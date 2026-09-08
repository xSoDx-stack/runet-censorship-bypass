'use strict';

import { expect } from 'chai';
import { pacSync } from '../src/extension-common/core/pac-sync.js';
import { pacKitchen } from '../src/extension-common/core/pac-kitchen.js';
import { storage } from '../src/extension-common/core/storage.js';

let mockStorage = {};

globalThis.chrome = {
  runtime: {
    lastError: null,
      getManifest: () => ({ version: '0.0.0-test' }),
  },
  action: {
    setIcon: () => {},
    setTitle: () => {},
    setBadgeText: () => {},
    setBadgeBackgroundColor: () => {},
  },
  proxy: {
    settings: {
      get: (opts, cb) => {
        if (cb) cb({ levelOfControl: 'controlled_by_this_extension', value: {} });
      },
      set: (opts, cb) => {
        if (cb) cb();
      },
      clear: (opts, cb) => {
        if (cb) cb();
      },
    },
  },
  storage: {
    local: {
      get: (key, cb) => {
        if (typeof key === 'string') {
          cb({ [key]: mockStorage[key] });
        } else {
          cb(Object.assign({}, mockStorage));
        }
      },
      set: (items, cb) => {
        Object.assign(mockStorage, items);
        if (cb) cb();
      },
      remove: (keys, cb) => {
        const kArr = Array.isArray(keys) ? keys : [keys];
        kArr.forEach((k) => delete mockStorage[k]);
        if (cb) cb();
      },
      clear: (cb) => {
        mockStorage = {};
        if (cb) cb();
      },
    },
  },
};

describe('Lightweight GET_STATE vs GET_PAC_SCRIPT (Item 6)', () => {
  beforeEach(async () => {
    mockStorage = {};
    pacSync.resetRuntimeState();
    pacKitchen.invalidateCache();
    await storage.clear();
  });

  it('1. A large 1MB PAC script is NOT included in pacSync.getState() (payload size stays tiny)', async () => {
    // Generate a 1MB PAC script
    const largeComment = '/* ' + 'x'.repeat(1024 * 1024) + ' */\n';
    const largePac = largeComment + 'function FindProxyForURL(url, host) { return "DIRECT"; }';

    await pacSync.applyPacData(largePac);

    const state = pacSync.getState();

    // Verify getState does NOT include rawPacData or cookedPacData
    expect(state.rawPacData).to.be.undefined;
    expect(state.cookedPacData).to.be.undefined;
    expect(state.hasPacData).to.be.true;
    expect(state.currentPacProviderKey).to.equal('Антизапрет');

    // Verify JSON serialized size of state is well under 2KB
    const serializedSize = JSON.stringify(state).length;
    expect(serializedSize).to.be.lessThan(2048);
  });

  it('2. getPacData() exclusively provides full raw and cooked PAC scripts', async () => {
    const customPac = 'function FindProxyForURL(url, host) { return "PROXY custom:8080"; }';
    await pacSync.applyPacData(customPac);

    const pacData = pacSync.getPacData();
    expect(pacData.rawPacData).to.equal(customPac);
    expect(pacData.cookedPacData).to.include('custom:8080');
    expect(pacData.currentProvider).to.equal('Антизапрет');
  });

  it('3. exposes an actionable error code without serializing the Error object', () => {
    pacSync.lastError = new Error('Private browsing access is required');
    pacSync.lastError.code = 'FIREFOX_PRIVATE_BROWSING_REQUIRED';

    const state = pacSync.getState();

    expect(state.lastError).to.equal('Private browsing access is required');
    expect(state.lastErrorCode).to.equal('FIREFOX_PRIVATE_BROWSING_REQUIRED');
  });
});
