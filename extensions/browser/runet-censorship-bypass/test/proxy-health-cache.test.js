'use strict';

import { expect } from 'chai';
import {
  PROXY_HEALTH_CACHE_KEY,
  loadProxyHealthCache,
  pruneProxyHealthCache,
  saveProxyHealthResult,
} from '../src/extension-common/core/proxy-health-cache.js';

let mockStorage = {};
let previousChrome;

function installChromeMock() {
  globalThis.chrome = {
    runtime: { lastError: null },
    storage: {
      local: {
        get: (key, callback) => {
          callback(typeof key === 'string' ? { [key]: mockStorage[key] } : { ...mockStorage });
        },
        set: (items, callback) => {
          Object.assign(mockStorage, items);
          callback?.();
        },
        remove: (keys, callback) => {
          for (const key of Array.isArray(keys) ? keys : [keys]) delete mockStorage[key];
          callback?.();
        },
        clear: (callback) => {
          mockStorage = {};
          callback?.();
        },
      },
    },
  };
}

describe('Proxy health cache', () => {
  beforeEach(() => {
    mockStorage = {};
    previousChrome = globalThis.chrome;
    installChromeMock();
  });

  afterEach(() => {
    globalThis.chrome = previousChrome;
  });

  it('restores a completed health check after the options page is reopened', async () => {
    const proxy = 'HTTPS proxy.example:443';
    await saveProxyHealthResult(proxy, { ok: true, latency: 87 }, 1_800_000_000_000);

    const restored = await loadProxyHealthCache([proxy]);

    expect(restored[proxy]).to.deep.equal({
      checking: false,
      ok: true,
      latency: 87,
      checkedAt: 1_800_000_000_000,
    });
  });

  it('keeps the last failure and trims oversized error messages', async () => {
    const proxy = 'SOCKS5 127.0.0.1:9050';
    await saveProxyHealthResult(proxy, { ok: false, error: 'x'.repeat(700) }, 1234);

    const restored = await loadProxyHealthCache([proxy]);

    expect(restored[proxy].ok).to.equal(false);
    expect(restored[proxy].error).to.have.length(500);
    expect(restored[proxy].checkedAt).to.equal(1234);
  });

  it('removes results for proxies that are no longer configured', async () => {
    const kept = 'HTTP kept.example:8080';
    const removed = 'HTTP removed.example:8080';
    await saveProxyHealthResult(kept, { ok: true, latency: 10 }, 100);
    await saveProxyHealthResult(removed, { ok: true, latency: 20 }, 200);

    const restored = await pruneProxyHealthCache([kept]);
    const reopened = await loadProxyHealthCache([kept, removed]);

    expect(restored).to.have.all.keys(kept);
    expect(reopened).to.have.all.keys(kept);
    expect(mockStorage[PROXY_HEALTH_CACHE_KEY]).to.have.all.keys(kept);
  });

  it('does not persist malformed proxies or unfinished results', async () => {
    expect(await saveProxyHealthResult('not a proxy', { ok: true }, 123)).to.equal(null);
    expect(await saveProxyHealthResult('HTTP proxy.example:8080', { checking: true }, 123)).to.equal(null);
    expect(mockStorage[PROXY_HEALTH_CACHE_KEY]).to.equal(undefined);
  });
});
