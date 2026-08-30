'use strict';

import { expect } from 'chai';
import vm from 'vm';
import { generateHealthCheckPac } from '../src/extension-common/core/proxy-checker.js';

describe('Proxy Health Check PAC Wrapper (generateHealthCheckPac)', () => {
  const originalPacScript = `
function FindProxyForURL(url, host) {
  if (host === 'normal.example' || host.endsWith('.normal.example')) {
    return 'PROXY original.example:8080';
  }
  if (host === 'blocked.example') {
    return 'HTTPS antizapret.example:443';
  }
  return 'DIRECT';
}
`;

  const testProxyScheme = 'HTTPS testproxy.example:443';

  it('should route probe endpoints to TEST_PROXY and normal traffic to ORIGINAL_PROXY without recursion', () => {
    const layeredPac = generateHealthCheckPac(originalPacScript, testProxyScheme);

    // Evaluate in fresh V8 VM sandbox simulating Chromium PAC environment
    const sandbox = {};
    vm.createContext(sandbox);
    vm.runInContext(layeredPac, sandbox);

    expect(sandbox.FindProxyForURL).to.be.a('function');

    // 1. Probe endpoints must route via candidate test proxy
    expect(sandbox.FindProxyForURL('https://1.1.1.1/cdn-cgi/trace', '1.1.1.1')).to.equal(testProxyScheme);
    expect(sandbox.FindProxyForURL('https://cloudflare.com/', 'cloudflare.com')).to.equal(testProxyScheme);
    expect(sandbox.FindProxyForURL('https://cp.cloudflare.com/generate_204', 'cp.cloudflare.com')).to.equal(testProxyScheme);
    expect(sandbox.FindProxyForURL('https://connectivitycheck.gstatic.com/generate_204', 'connectivitycheck.gstatic.com')).to.equal(testProxyScheme);
    expect(sandbox.FindProxyForURL('https://dns.google/resolve', 'dns.google')).to.equal(testProxyScheme);

    // 2. Normal traffic MUST be routed through the original PAC without DIRECT leakage
    expect(sandbox.FindProxyForURL('http://normal.example/path', 'normal.example')).to.equal('PROXY original.example:8080');
    expect(sandbox.FindProxyForURL('https://sub.normal.example/', 'sub.normal.example')).to.equal('PROXY original.example:8080');
    expect(sandbox.FindProxyForURL('https://blocked.example/video', 'blocked.example')).to.equal('HTTPS antizapret.example:443');

    // 3. Unproxied general traffic still returns DIRECT from original PAC
    expect(sandbox.FindProxyForURL('https://random-site.com/', 'random-site.com')).to.equal('DIRECT');
  });

  it('should not throw recursion or stack overflow on repeated and parallel calls', () => {
    const layeredPac = generateHealthCheckPac(originalPacScript, testProxyScheme);

    const sandbox = {};
    vm.createContext(sandbox);
    vm.runInContext(layeredPac, sandbox);

    // 1,000 rapid calls to verify call stack integrity
    for (let i = 0; i < 1000; i++) {
      const probeRes = sandbox.FindProxyForURL('https://1.1.1.1/cdn-cgi/trace', '1.1.1.1');
      const normalRes = sandbox.FindProxyForURL('http://normal.example/', 'normal.example');
      expect(probeRes).to.equal(testProxyScheme);
      expect(normalRes).to.equal('PROXY original.example:8080');
    }
  });

  it('should handle empty or fallback base PAC gracefully', () => {
    const layeredPac = generateHealthCheckPac('', testProxyScheme);

    const sandbox = {};
    vm.createContext(sandbox);
    vm.runInContext(layeredPac, sandbox);

    expect(sandbox.FindProxyForURL('https://1.1.1.1/', '1.1.1.1')).to.equal(testProxyScheme);
    expect(sandbox.FindProxyForURL('https://example.com/', 'example.com')).to.equal('DIRECT');
  });
});

describe('Proxy Health Check: Concurrency & State Race Protection (P1-1)', () => {
  let appliedProxyConfigs = [];
  let originalFetch;

  before(() => {
    originalFetch = globalThis.fetch;
    if (!globalThis.chrome) globalThis.chrome = {};
    if (!globalThis.chrome.runtime) globalThis.chrome.runtime = { lastError: null };
    if (!globalThis.chrome.storage) {
      globalThis.chrome.storage = {
        local: {
          get: (k, cb) => cb({}),
          set: (i, cb) => cb && cb(),
          remove: (k, cb) => cb && cb(),
        },
      };
    }
    globalThis.chrome.proxy = {
      settings: {
        set: (opts, cb) => {
          appliedProxyConfigs.push(opts.value);
          if (cb) cb();
        },
        clear: (opts, cb) => {
          appliedProxyConfigs.push({ mode: 'direct' });
          if (cb) cb();
        },
        get: (opts, cb) => {
          cb && cb({ levelOfControl: 'controlled_by_this_extension' });
        },
      },
    };
    globalThis.chrome.action = {
      setIcon: () => {},
      setTitle: () => {},
      setBadgeText: () => {},
      setBadgeBackgroundColor: () => {},
    };
  });

  after(() => {
    globalThis.fetch = originalFetch;
  });

  beforeEach(() => {
    appliedProxyConfigs = [];
  });

  it('should not overwrite newer PAC configuration if provider changed during health check', async () => {
    const { pacSync } = await import('../src/extension-common/core/pac-sync.js');
    const { checkProxyHealth } = await import('../src/extension-common/core/proxy-checker.js');

    // 1. Initial state: Antizapret
    pacSync.resetRuntimeState();
    pacSync.currentPacProviderKey = 'Антизапрет';
    pacSync.cookedPacData = 'function FindProxyForURL(url, host) { return "PROXY antizapret:443"; }';
    pacSync.rawPacData = pacSync.cookedPacData;
    pacSync.revision = 1;

    // 2. Mock fetch: during probe fetch, user changes provider to Anticensority
    let providerSwitch;
    globalThis.fetch = async () => {
      // A real provider switch uses the same global proxy-settings lock.
      pacSync.currentPacProviderKey = 'Антицензорити';
      providerSwitch = pacSync.applyPacData(
        'function FindProxyForURL(url, host) { return "PROXY anticensority:443"; }'
      );

      return { status: 200 };
    };

    // 3. Run health check
    const res = await checkProxyHealth('HTTP 1.2.3.4:8080');
    await providerSwitch;
    expect(res.ok).to.be.true;

    // 4. Verify that final applied config is Anticensority and NOT the old Antizapret or probe PAC
    const lastConfig = appliedProxyConfigs[appliedProxyConfigs.length - 1];
    expect(lastConfig.pacScript.data).to.include('anticensority:443');
    expect(lastConfig.pacScript.data).to.not.include('1.2.3.4:8080');
    expect(pacSync.currentPacProviderKey).to.equal('Антицензорити');
  });

  it('should sequentially batch check multiple proxies via checkMultipleProxies', async () => {
    const { checkMultipleProxies } = await import('../src/extension-common/core/proxy-checker.js');
    globalThis.fetch = async () => ({ status: 200 });

    const results = await checkMultipleProxies([
      'HTTPS valid-1.example:443',
      'SOCKS5 127.0.0.1:9050',
    ]);

    expect(results).to.have.property('HTTPS valid-1.example:443');
    expect(results['HTTPS valid-1.example:443'].ok).to.be.true;
    expect(results).to.have.property('SOCKS5 127.0.0.1:9050');
    expect(results['SOCKS5 127.0.0.1:9050'].ok).to.be.true;
  });

  it('should reject an unknown proxy protocol without throwing', async () => {
    const { checkProxyHealth } = await import('../src/extension-common/core/proxy-checker.js');
    const result = await checkProxyHealth('BANANA proxy.example:1234');

    expect(result).to.deep.equal({ ok: false, error: 'Не указан хост или порт' });
  });
});

