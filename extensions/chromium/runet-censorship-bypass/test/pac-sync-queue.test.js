'use strict';

import { expect } from 'chai';
import { pacSync } from '../src/extension-common/core/pac-sync.js';
import { storage } from '../src/extension-common/core/storage.js';

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

  beforeEach(async () => {
    mockStorage = {};
    appliedProxyConfigs = [];
    downloadedUrls = [];
    pacSync.resetRuntimeState();
    await storage.clear();

    originalDownload = pacSync.downloadPacFromProvider;
  });

  afterEach(() => {
    pacSync.downloadPacFromProvider = originalDownload;
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
});
