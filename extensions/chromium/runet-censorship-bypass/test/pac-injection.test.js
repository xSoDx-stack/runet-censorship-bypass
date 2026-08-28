'use strict';

import { expect } from 'chai';
import vm from 'vm';
import { cookPac } from '../src/extension-common/core/pac-kitchen.js';
import { generateHealthCheckPac } from '../src/extension-common/core/proxy-checker.js';

describe('PAC Generation: Injection Resistance & Safe Interpolation (Item 5)', () => {
  const basePac = `
    function FindProxyForURL(url, host) {
      if (host === 'blocked.example.com') return 'PROXY default-proxy:8443';
      return 'DIRECT';
    }
  `;

  it('1. replaceDirectWith containing regex patterns ($1, $&, $`, $\', $$) does not corrupt output or throw', () => {
    const specialReplacements = [
      'PROXY dollar$1:8080',
      'PROXY match$&:8080',
      'PROXY before$' + '`' + ':8080',
      'PROXY after$\':8080',
      'PROXY double$$:8080',
      'PROXY quotes"\'and\\slashes:8080',
      'PROXY multi; line\r\n DIRECT:8080',
    ];

    for (const replacement of specialReplacements) {
      const cooked = cookPac(basePac, {
        replaceDirectWith: replacement,
        ifProxyHttpsUrlsOnly: false,
        ifUseSecureProxiesOnly: false,
        ifProhibitDns: false,
        ifProxyOrDie: false,
        ifUsePacScriptProxies: true,
      });

      // Execute in sandbox VM to verify valid JavaScript
      const sandbox = { FindProxyForURL: null };
      const script = new vm.Script(cooked);
      const context = vm.createContext(sandbox);
      script.runInContext(context);

      expect(typeof sandbox.FindProxyForURL).to.equal('function');

      // Test direct traffic replacement
      const res = sandbox.FindProxyForURL('http://unblocked.org', 'unblocked.org');
      expect(res).to.equal(replacement);
    }
  });

  it('2. JavaScript escape payloads in replaceDirectWith cannot break sandbox or execute code', () => {
    const maliciousPayload = 'DIRECT"; exploited = true; "';

    const cooked = cookPac(basePac, {
      replaceDirectWith: maliciousPayload,
      ifProxyHttpsUrlsOnly: false,
      ifUseSecureProxiesOnly: false,
      ifProhibitDns: false,
      ifProxyOrDie: false,
      ifUsePacScriptProxies: true,
    });

    const sandbox = { FindProxyForURL: null, exploited: false };
    const script = new vm.Script(cooked);
    const context = vm.createContext(sandbox);
    script.runInContext(context);

    expect(sandbox.exploited).to.be.false;
    const res = sandbox.FindProxyForURL('http://test.com', 'test.com');
    expect(res).to.equal(maliciousPayload);
  });

  it('3. Health check PAC safely serializes proxy strings with quotes, slashes, and special characters', () => {
    const candidateProxy = 'HTTPS my"proxy\\test:443';
    const generated = generateHealthCheckPac(basePac, candidateProxy);

    const sandbox = { FindProxyForURL: null };
    const script = new vm.Script(generated);
    const context = vm.createContext(sandbox);
    script.runInContext(context);

    expect(typeof sandbox.FindProxyForURL).to.equal('function');
    const res = sandbox.FindProxyForURL('https://1.1.1.1', '1.1.1.1');
    expect(res).to.equal(candidateProxy);
  });

  it('4. Custom proxy strings and torPoints safely serialize in cookPac without injection vulnerability', () => {
    const cooked = cookPac(basePac, {
      ifUseLocalTor: true,
      torPoints: ['SOCKS5 localhost:9150"; malicious = true; "'],
      filteredCustomsString: 'PROXY "custom":8080',
      ifProxyHttpsUrlsOnly: false,
      ifUseSecureProxiesOnly: false,
      ifProhibitDns: false,
      ifProxyOrDie: false,
      ifUsePacScriptProxies: true,
    });

    const sandbox = { FindProxyForURL: null, malicious: false };
    const script = new vm.Script(cooked);
    const context = vm.createContext(sandbox);
    script.runInContext(context);

    expect(sandbox.malicious).to.be.false;
    const torRes = sandbox.FindProxyForURL('http://hidden.onion', 'hidden.onion');
    expect(torRes).to.equal('SOCKS5 localhost:9150"; malicious = true; "');
  });
});
