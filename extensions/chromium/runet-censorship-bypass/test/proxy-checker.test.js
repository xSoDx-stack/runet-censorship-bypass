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
