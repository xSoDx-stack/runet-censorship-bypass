'use strict';

import { expect } from 'chai';
import { pacSync } from '../src/extension-common/core/pac-sync.js';
import { pacKitchen } from '../src/extension-common/core/pac-kitchen.js';
import { storage } from '../src/extension-common/core/storage.js';
import { ipToHost } from '../src/extension-common/core/ip-to-host.js';
import {
  findCredentials,
  getPersistentCredentialsMap,
  resetProxyCredentialsState,
} from '../src/extension-common/core/proxy-auth.js';

let mockStorage = {};

globalThis.chrome = {
  runtime: {
    lastError: null,
    getManifest: () => ({ version: '2.2.19' }),
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
        if (cb) {
          cb({
            levelOfControl: 'controlled_by_this_extension',
            value: { mode: 'pac_script', pacScript: { data: 'test' } },
          });
        }
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

describe('Reset Settings & Ghost Data Prevention (Item 2)', () => {
  let originalDownload;

  beforeEach(async () => {
    mockStorage = {};
    pacSync.resetRuntimeState();
    pacKitchen.invalidateCache();
    resetProxyCredentialsState();
    ipToHost.reset();
    await storage.clear();

    originalDownload = pacSync.downloadPacFromProvider;
    pacSync.downloadPacFromProvider = async () => {
      return 'function FindProxyForURL(url, host) { return "DIRECT"; }';
    };
  });

  afterEach(() => {
    pacSync.downloadPacFromProvider = originalDownload;
  });

  it('1. Warm state with custom PAC, proxy auth credentials, and exception mods is fully purged on reset', async () => {
    // 1. Setup rich custom state
    await pacKitchen.savePacMods({
      customProxyStringRaw: 'HTTPS myuser:secret123@myproxy.example.com:443',
      exceptions: { 'blocked.org': true },
      whitelist: ['whitelisted.com'],
      ifProxyOrDie: true,
      ifUseLocalTor: true,
    });

    pacSync.currentPacProviderKey = 'customPacUrl';
    pacSync.customPacUrl = 'https://custom.example.com/custom.pac';
    pacSync.lastPacUpdateStamp = 123456789;
    pacSync.providerUpdateStamps = { customPacUrl: 123456789 };
    pacSync.rawPacData = '/* custom pac */';
    pacSync.cookedPacData = '/* custom cooked pac */';
    await pacSync.persistState();

    // Verify state was populated
    expect(findCredentials('myproxy.example.com', 443)).to.exist;
    expect(pacSync.customPacUrl).to.equal('https://custom.example.com/custom.pac');

    // 2. Perform Full Reset Sequence (matching message-bus RESET_SETTINGS)
    pacSync.resetRuntimeState();
    await storage.clear();
    pacKitchen.invalidateCache();
    resetProxyCredentialsState();
    ipToHost.reset();
    await pacSync.clearPac({ persist: false });
    await pacSync.syncWithPacProvider({ key: 'Антизапрет', ifUnattended: true });

    // 3. Verify ALL storage is clean and restored to defaults
    const stateAfter = pacSync.getState();
    expect(stateAfter.currentPacProviderKey).to.equal('Антизапрет');
    expect(stateAfter.customPacUrl).to.equal('');
    expect(stateAfter.lastError).to.be.null;

    // Verify proxyAuth credentials map in RAM and storage is completely clean
    expect(getPersistentCredentialsMap()).to.deep.equal({});
    expect(findCredentials('myproxy.example.com', 443)).to.be.null;

    // Verify pacKitchen cache is invalidated and returns default mods
    const modsAfter = await pacKitchen.getPacMods();
    expect(modsAfter.customProxyStringRaw).to.equal('');
    expect(modsAfter.exceptions).to.deep.equal({});
    expect(modsAfter.whitelist).to.deep.equal([]);
    expect(modsAfter.ifUseLocalTor).to.be.false;

    // Verify no ghost custom PAC data re-persisted into storage
    const rawStorage = await storage.get('antiCensorRu', null);
    expect(rawStorage).to.exist;
    expect(rawStorage.currentPacProviderKey).to.equal('Антизапрет');
    expect(rawStorage.customPacUrl).to.equal('');
  });
});
