'use strict';

import { expect } from 'chai';
import { proxyBackend as chromiumBackend } from '../src/extension-common/core/proxy-backend.js';
import { proxyBackend as firefoxBackend } from '../src/extension-firefox/core/proxy-backend.js';

describe('Cross-browser proxy backend contract', () => {
  let originalChrome;
  let originalCreateObjectURL;
  let originalRevokeObjectURL;
  let privateBrowsingAllowed;
  let nativeValue;
  let levelOfControl;
  let settingCalls;
  let blobCounter;
  let optionsPageOpenCount;

  before(() => {
    originalChrome = globalThis.chrome;
    originalCreateObjectURL = URL.createObjectURL;
    originalRevokeObjectURL = URL.revokeObjectURL;
  });

  beforeEach(async () => {
    privateBrowsingAllowed = true;
    nativeValue = {
      proxyType: 'system',
      autoConfigUrl: '',
    };
    levelOfControl = 'controllable_by_this_extension';
    settingCalls = [];
    blobCounter = 0;
    optionsPageOpenCount = 0;

    URL.createObjectURL = () => `blob:mock-pac-${++blobCounter}`;
    URL.revokeObjectURL = () => {};

    const onChange = {
      addListener: () => {},
      hasListener: () => false,
    };
    const onError = {
      addListener: () => {},
      hasListener: () => false,
    };
    const onProxyError = {
      addListener: () => {},
      hasListener: () => false,
    };

    globalThis.chrome = {
      runtime: {
        lastError: null,
        openOptionsPage: (callback) => {
          optionsPageOpenCount++;
          callback();
        },
      },
      extension: {
        isAllowedIncognitoAccess: (callback) => callback(privateBrowsingAllowed),
      },
      proxy: {
        onError,
        onProxyError,
        settings: {
          onChange,
          get: (_details, callback) => callback({
            levelOfControl,
            value: { ...nativeValue },
          }),
          set: (details, callback) => {
            settingCalls.push({ method: 'set', details });
            nativeValue = { ...details.value };
            levelOfControl = 'controlled_by_this_extension';
            callback(true);
          },
          clear: (details, callback) => {
            settingCalls.push({ method: 'clear', details });
            nativeValue = { proxyType: 'system', autoConfigUrl: '' };
            levelOfControl = 'controllable_by_this_extension';
            callback(true);
          },
        },
      },
    };

    await firefoxBackend.clear();
    settingCalls = [];
  });

  after(() => {
    globalThis.chrome = originalChrome;
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
  });

  it('keeps the Chromium PAC schema and regular-profile scope unchanged', async () => {
    const pacData = 'function FindProxyForURL() { return "DIRECT"; }';
    await chromiumBackend.applyPac(pacData, { mandatory: true });

    expect(settingCalls).to.deep.equal([{
      method: 'set',
      details: {
        value: {
          mode: 'pac_script',
          pacScript: { data: pacData, mandatory: true },
        },
        scope: 'regular',
      },
    }]);
  });

  it('maps a large cooked PAC to Firefox autoConfig through a Blob URL', async () => {
    const pacData = `/*${'x'.repeat(2 * 1024 * 1024)}*/\n` +
      'function FindProxyForURL() { return "DIRECT"; }';
    await firefoxBackend.applyPac(pacData, { mandatory: true });
    const details = await firefoxBackend.getSettings();

    expect(settingCalls[0]).to.deep.equal({
      method: 'set',
      details: {
        value: {
          proxyType: 'autoConfig',
          autoConfigUrl: 'blob:mock-pac-1',
        },
      },
    });
    expect(firefoxBackend.isExpectedPacApplied(details, pacData)).to.equal(true);
    expect(details.backendSnapshot.pacData).to.equal(pacData);
  });

  it('restores a captured Firefox PAC through a fresh Blob URL', async () => {
    const originalPac = 'function FindProxyForURL() { return "PROXY old.test:443"; }';
    const probePac = 'function FindProxyForURL() { return "PROXY probe.test:443"; }';
    await firefoxBackend.applyPac(originalPac);
    const originalDetails = await firefoxBackend.getSettings();

    await firefoxBackend.applyPac(probePac);
    await firefoxBackend.restore(originalDetails);
    const restoredDetails = await firefoxBackend.getSettings();

    expect(settingCalls.map((call) => call.details.value.autoConfigUrl)).to.deep.equal([
      'blob:mock-pac-1',
      'blob:mock-pac-2',
      'blob:mock-pac-3',
    ]);
    expect(restoredDetails.value.autoConfigUrl).to.equal('blob:mock-pac-3');
    expect(firefoxBackend.isExpectedPacApplied(restoredDetails, originalPac)).to.equal(true);
  });

  it('returns an actionable error before mutating Firefox settings without private access', async () => {
    privateBrowsingAllowed = false;
    let error;
    try {
      await firefoxBackend.applyPac(
        'function FindProxyForURL() { return "DIRECT"; }'
      );
    } catch (caught) {
      error = caught;
    }

    expect(error).to.be.an('error');
    expect(error.code).to.equal('FIREFOX_PRIVATE_BROWSING_REQUIRED');
    expect(error.message).to.include('приватных окнах');
    expect(settingCalls).to.deep.equal([]);
    expect(optionsPageOpenCount).to.equal(0);
  });

  it('opens Firefox add-on management only after an explicit UI action', async () => {
    expect(optionsPageOpenCount).to.equal(0);

    await firefoxBackend.openPrivateBrowsingSettings();

    expect(optionsPageOpenCount).to.equal(1);
    expect(chromiumBackend.openPrivateBrowsingSettings).to.equal(undefined);
  });

  it('uses the browser-specific proxy error event on each platform', () => {
    let chromiumListener = null;
    let firefoxListener = null;
    chrome.proxy.onProxyError.addListener = (listener) => {
      chromiumListener = listener;
    };
    chrome.proxy.onError.addListener = (listener) => {
      firefoxListener = listener;
    };

    const listener = () => {};
    expect(chromiumBackend.addErrorListener(listener)).to.equal(true);
    expect(firefoxBackend.addErrorListener(listener)).to.equal(true);
    expect(chromiumListener).to.equal(listener);
    expect(firefoxListener).to.equal(listener);
  });
});
