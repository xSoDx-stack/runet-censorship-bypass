'use strict';

import { expect } from 'chai';
import { pacSync } from '../src/extension-common/core/pac-sync.js';
import { storage } from '../src/extension-common/core/storage.js';
import { httpLib } from '../src/extension-common/core/http-lib.js';
import { errorHandlers } from '../src/extension-common/core/error-handlers.js';

let mockStorage = {};
let appliedProxyConfigs = [];
let downloadedUrls = [];

globalThis.chrome = {
  runtime: { lastError: null },
  action: {
    setIcon: () => {},
    setTitle: () => {},
    setBadgeText: () => {},
    setBadgeBackgroundColor: () => {},
  },
  proxy: {
    settings: {
      get: (opts, cb) => {
        if (cb) {
          cb({
            levelOfControl: 'controlled_by_this_extension',
            value: appliedProxyConfigs[appliedProxyConfigs.length - 1] || {},
          });
        }
      },
      set: (opts, cb) => {
        appliedProxyConfigs.push(opts.value);
        if (cb) cb();
      },
      clear: (opts, cb) => {
        appliedProxyConfigs.push({ mode: 'direct' });
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

describe('PAC Sync: Pending Request Queue & Concurrency (Item 1)', () => {
  let originalDownload;
  let originalHttpLibGet;
  let originalApplyPacData;
  let originalStorageSet;

  beforeEach(async () => {
    mockStorage = {};
    appliedProxyConfigs = [];
    downloadedUrls = [];
    globalThis.chrome.proxy = {
      settings: {
        get: (opts, cb) => {
          if (cb) {
            cb({
              levelOfControl: 'controlled_by_this_extension',
              value: appliedProxyConfigs[appliedProxyConfigs.length - 1] || {},
            });
          }
        },
        set: (opts, cb) => {
          appliedProxyConfigs.push(opts.value);
          if (cb) cb();
        },
        clear: (opts, cb) => {
          appliedProxyConfigs.push({ mode: 'direct' });
          if (cb) cb();
        },
      },
    };
    pacSync.resetRuntimeState();
    await storage.clear();

    originalDownload = pacSync.downloadPacFromProvider;
    originalApplyPacData = pacSync.applyPacData;
    originalStorageSet = storage.set;
    originalHttpLibGet = httpLib.get;
    httpLib.get = async () => 'function FindProxyForURL(url, host) { return "DIRECT"; }';
  });

  afterEach(() => {
    pacSync.downloadPacFromProvider = originalDownload;
    pacSync.applyPacData = originalApplyPacData;
    storage.set = originalStorageSet;
    httpLib.get = originalHttpLibGet;
  });

  it('1. Sync A is running -> request B arrives -> B executes after A and becomes the final state', async () => {
    let syncACallback;
    const syncAPromise = new Promise((resolve) => {
      syncACallback = resolve;
    });

    pacSync.downloadPacFromProvider = async (provider) => {
      downloadedUrls.push(provider.distinctKey);
      if (provider.distinctKey === 'Antizapret') {
        await syncAPromise;
        return 'function FindProxyForURL(url, host) { return "PROXY antizapret:8443; DIRECT"; }';
      }
      return 'function FindProxyForURL(url, host) { return "PROXY anticensority:8443; DIRECT"; }';
    };

    // Start Sync A (Antizapret)
    const callA = pacSync.syncWithPacProvider({ key: 'Антизапрет' });

    // While A is in-flight, request Sync B (Антицензорити)
    const callB = pacSync.syncWithPacProvider({ key: 'Антицензорити' });

    // Release Sync A
    syncACallback();

    await Promise.all([callA, callB]);

    // Both A and B were downloaded in order
    expect(downloadedUrls).to.deep.equal(['Antizapret', 'Anticensority']);
    // Final active provider is B (the latest requested)
    expect(pacSync.currentPacProviderKey).to.equal('Антицензорити');
  });

  it('2. A -> B -> C while A is in-flight -> after A finishes, C executes (B is superseded by latest request C)', async () => {
    let syncACallback;
    const syncAPromise = new Promise((resolve) => {
      syncACallback = resolve;
    });

    pacSync.downloadPacFromProvider = async (provider) => {
      downloadedUrls.push(provider.distinctKey);
      if (provider.distinctKey === 'Antizapret') {
        await syncAPromise;
        return 'function FindProxyForURL(url, host) { return "PROXY antizapret:8443; DIRECT"; }';
      }
      return `function FindProxyForURL(url, host) { return "PROXY ${provider.distinctKey}:8443; DIRECT"; }`;
    };

    // Start A
    const callA = pacSync.syncWithPacProvider({ key: 'Антизапрет' });

    // Enqueue B, then enqueue C
    const callB = pacSync.syncWithPacProvider({ key: 'onlyOwnSites' });
    const callC = pacSync.syncWithPacProvider({ key: 'Антицензорити' });

    syncACallback();

    await Promise.all([callA, callB, callC]);

    // A ran, then latest request C ran (B was superseded)
    expect(downloadedUrls).to.deep.equal(['Antizapret', 'Anticensority']);
    expect(pacSync.currentPacProviderKey).to.equal('Антицензорити');
  });

  it('3. Multiple identical sync requests do not trigger redundant downloads or PAC applications', async () => {
    let syncCount = 0;
    pacSync.downloadPacFromProvider = async () => {
      syncCount++;
      await new Promise((r) => setTimeout(r, 15));
      return 'function FindProxyForURL(url, host) { return "DIRECT"; }';
    };

    // Fire 3 identical requests in parallel
    await Promise.all([
      pacSync.syncWithPacProvider({ key: 'Антизапрет' }),
      pacSync.syncWithPacProvider({ key: 'Антизапрет' }),
      pacSync.syncWithPacProvider({ key: 'Антизапрет' }),
    ]);

    // Download happened only once
    expect(syncCount).to.equal(1);
  });

  it('4. Failed Sync A does not block pending Sync B, and queue remains fully operational', async () => {
    let syncACallback;
    const syncAPromise = new Promise((resolve) => {
      syncACallback = resolve;
    });

    pacSync.downloadPacFromProvider = async (provider) => {
      if (provider.distinctKey === 'Antizapret') {
        await syncAPromise;
        throw new Error('Network Connection Timed Out for A');
      }
      return 'function FindProxyForURL(url, host) { return "PROXY anticensority:8443; DIRECT"; }';
    };

    const callA = pacSync.syncWithPacProvider({ key: 'Антизапрет', ifUnattended: false });
    const callB = pacSync.syncWithPacProvider({ key: 'Антицензорити', ifUnattended: false });

    syncACallback();

    let errA = null;
    try {
      await callA;
    } catch (e) {
      errA = e;
    }

    // Call A failed
    expect(errA).to.exist;
    expect(errA.message).to.include('Network Connection Timed Out for A');

    // Call B succeeded
    await callB;
    expect(pacSync.currentPacProviderKey).to.equal('Антицензорити');

    // Subsequent sync C also works without getting stuck
    await pacSync.syncWithPacProvider({ key: 'onlyOwnSites', ifUnattended: false });
    expect(pacSync.currentPacProviderKey).to.equal('onlyOwnSites');
  });

  it('5. Reset invalidates an in-flight download before it can apply stale PAC data', async () => {
    let releaseOldDownload;
    const oldDownloadGate = new Promise((resolve) => {
      releaseOldDownload = resolve;
    });

    pacSync.downloadPacFromProvider = async (provider) => {
      downloadedUrls.push(provider.distinctKey);
      if (provider.distinctKey === 'Anticensority') {
        await oldDownloadGate;
        return 'function FindProxyForURL() { return "PROXY stale.example:443"; }';
      }
      return 'function FindProxyForURL() { return "PROXY fresh.example:443"; }';
    };
    const appliedCandidates = [];
    pacSync.applyPacData = async function(candidate, options) {
      appliedCandidates.push(candidate);
      return originalApplyPacData.call(this, candidate, options);
    };

    const staleCall = pacSync.syncWithPacProvider({
      key: 'Антицензорити',
      ifUnattended: false,
    });
    pacSync.resetRuntimeState();
    const freshCall = pacSync.syncWithPacProvider({
      key: 'Антизапрет',
      ifUnattended: false,
    });

    releaseOldDownload();

    let staleError = null;
    try {
      await staleCall;
    } catch (err) {
      staleError = err;
    }
    await freshCall;

    expect(staleError).to.exist;
    expect(pacSync.currentPacProviderKey).to.equal('Антизапрет');
    expect(pacSync.rawPacData).to.include('fresh.example:443');
    expect(appliedCandidates).to.have.lengthOf(1);
    expect(appliedCandidates[0]).to.include('fresh.example:443');
  });

  it('rolls the active PAC back when its state cannot be persisted', async () => {
    pacSync.downloadPacFromProvider = async (provider) =>
      `function FindProxyForURL() { return "PROXY ${provider.distinctKey}.example:443"; }`;

    await pacSync.syncWithPacProvider({ key: 'Антизапрет', ifUnattended: false });
    const previousRawPac = pacSync.rawPacData;
    storage.set = async (key, value) => {
      if (key === 'antiCensorRu') {
        throw new Error('storage quota exceeded');
      }
      return originalStorageSet.call(storage, key, value);
    };

    let syncError;
    try {
      await pacSync.syncWithPacProvider({ key: 'Антицензорити', ifUnattended: false });
    } catch (err) {
      syncError = err;
    }

    expect(syncError).to.be.an('error');
    expect(syncError.message).to.include('storage quota exceeded');
    expect(pacSync.currentPacProviderKey).to.equal('Антизапрет');
    expect(pacSync.rawPacData).to.equal(previousRawPac);
    const activeConfig = appliedProxyConfigs[appliedProxyConfigs.length - 1];
    expect(activeConfig.pacScript.data).to.include('Antizapret.example:443');
    expect(activeConfig.pacScript.data).to.not.include('Anticensority.example:443');
  });

  it('rolls a PAC clear back when the cleared state cannot be persisted', async () => {
    pacSync.downloadPacFromProvider = async () =>
      'function FindProxyForURL() { return "PROXY previous.example:443"; }';
    await pacSync.syncWithPacProvider({ key: 'Антизапрет', ifUnattended: false });
    const previousRawPac = pacSync.rawPacData;
    storage.set = async (key, value) => {
      if (key === 'antiCensorRu') {
        throw new Error('storage unavailable');
      }
      return originalStorageSet.call(storage, key, value);
    };

    let clearError;
    try {
      await pacSync.clearPac();
    } catch (err) {
      clearError = err;
    }

    expect(clearError).to.be.an('error');
    expect(pacSync.currentPacProviderKey).to.equal('Антизапрет');
    expect(pacSync.rawPacData).to.equal(previousRawPac);
    const activeConfig = appliedProxyConfigs[appliedProxyConfigs.length - 1];
    expect(activeConfig.mode).to.equal('pac_script');
    expect(activeConfig.pacScript.data).to.include('previous.example:443');
  });

  it('reapplies stored PAC after the profile proxy setting is unexpectedly cleared', async () => {
    pacSync.downloadPacFromProvider = async () =>
      'function FindProxyForURL() { return "PROXY recover.example:443"; }';
    let extensionControlsProxy = true;
    chrome.proxy.settings.get = (_opts, cb) => cb({
      levelOfControl: extensionControlsProxy
        ? 'controlled_by_this_extension'
        : 'controllable_by_this_extension',
      value: extensionControlsProxy
        ? appliedProxyConfigs[appliedProxyConfigs.length - 1]
        : { mode: 'system' },
    });
    const originalProxySet = chrome.proxy.settings.set;
    chrome.proxy.settings.set = (options, cb) => {
      extensionControlsProxy = true;
      originalProxySet(options, cb);
    };

    await pacSync.syncWithPacProvider({ key: 'Антизапрет', ifUnattended: false });
    extensionControlsProxy = false;
    const reapplied = await pacSync.reconcileProxyState();

    expect(reapplied).to.equal(true);
    expect(extensionControlsProxy).to.equal(true);
    expect(appliedProxyConfigs[appliedProxyConfigs.length - 1].pacScript.data)
      .to.include('recover.example:443');
  });

  it('confirms a transient ownership conflict before warning and restores PAC', async () => {
    pacSync.downloadPacFromProvider = async () =>
      'function FindProxyForURL() { return "PROXY recover.example:443"; }';
    await pacSync.syncWithPacProvider({ key: 'Антизапрет', ifUnattended: false });

    const originalWaitForStability = pacSync._waitForControlStateStability;
    const originalHandleControlState = errorHandlers.handleControlState;
    const reportedStates = [];
    let controlMode = 'hard-conflict';

    pacSync._waitForControlStateStability = async () => {
      controlMode = 'controllable';
    };
    errorHandlers.handleControlState = async (state) => reportedStates.push({ ...state });
    chrome.proxy.settings.get = (_opts, cb) => {
      const details = controlMode === 'hard-conflict'
        ? {
            levelOfControl: 'controlled_by_other_extensions',
            value: { mode: 'system' },
          }
        : controlMode === 'controllable'
          ? {
              levelOfControl: 'controllable_by_this_extension',
              value: { mode: 'system' },
            }
          : {
              levelOfControl: 'controlled_by_this_extension',
              value: appliedProxyConfigs[appliedProxyConfigs.length - 1],
            };
      cb(details);
    };
    chrome.proxy.settings.set = (options, cb) => {
      appliedProxyConfigs.push(options.value);
      controlMode = 'controlled';
      cb();
    };

    try {
      const reapplied = await pacSync.reconcileProxyState();

      expect(reapplied).to.equal(true);
      expect(controlMode).to.equal('controlled');
      expect(reportedStates.some((state) =>
        state.levelOfControl === 'controlled_by_other_extensions')).to.equal(false);
      expect(appliedProxyConfigs[appliedProxyConfigs.length - 1].pacScript.data)
        .to.include('recover.example:443');
    } finally {
      pacSync._waitForControlStateStability = originalWaitForStability;
      errorHandlers.handleControlState = originalHandleControlState;
    }
  });

  it('reports a persistent ownership conflict after confirmation', async () => {
    pacSync.downloadPacFromProvider = async () =>
      'function FindProxyForURL() { return "PROXY expected.example:443"; }';
    await pacSync.syncWithPacProvider({ key: 'Антизапрет', ifUnattended: false });

    const originalWaitForStability = pacSync._waitForControlStateStability;
    const originalHandleControlState = errorHandlers.handleControlState;
    const reportedStates = [];
    const appliedCountBeforeConflict = appliedProxyConfigs.length;

    pacSync._waitForControlStateStability = async () => {};
    errorHandlers.handleControlState = async (state) => reportedStates.push({ ...state });
    chrome.proxy.settings.get = (_opts, cb) => cb({
      levelOfControl: 'controlled_by_other_extensions',
      value: { mode: 'system' },
    });

    try {
      const reapplied = await pacSync.reconcileProxyState();

      expect(reapplied).to.equal(false);
      expect(appliedProxyConfigs).to.have.lengthOf(appliedCountBeforeConflict);
      expect(reportedStates).to.deep.equal([{
        isControlled: false,
        isControllable: false,
        expectedControl: true,
        levelOfControl: 'controlled_by_other_extensions',
      }]);
    } finally {
      pacSync._waitForControlStateStability = originalWaitForStability;
      errorHandlers.handleControlState = originalHandleControlState;
    }
  });

  it('replaces a stale PAC still owned by this extension after an interrupted update', async () => {
    pacSync.downloadPacFromProvider = async () =>
      'function FindProxyForURL() { return "PROXY committed.example:443"; }';
    await pacSync.syncWithPacProvider({ key: 'Антизапрет', ifUnattended: false });

    appliedProxyConfigs.push({
      mode: 'pac_script',
      pacScript: {
        data: 'function FindProxyForURL() { return "PROXY uncommitted.example:443"; }',
        mandatory: true,
      },
    });
    const reapplied = await pacSync.reconcileProxyState();

    expect(reapplied).to.equal(true);
    const activePac = appliedProxyConfigs[appliedProxyConfigs.length - 1].pacScript.data;
    expect(activePac).to.include('committed.example:443');
    expect(activePac).to.not.include('uncommitted.example:443');
  });
});
