'use strict';

import { expect } from 'chai';
import { parseDomainsInput, generatePacScript, testPacRule } from '../src/extension-common/core/pac-generator.js';

describe('PAC Generator: parseDomainsInput, generatePacScript, testPacRule', () => {
  it('should cleanly parse and normalize domains from raw text', () => {
    const raw = `
      # Comments
      https://rutracker.org/forum/
      *.ntc.party:443
      .instagram.com
      invalid_domain..
      1.1.1.1
    `;

    const domains = parseDomainsInput(raw);
    expect(domains).to.include('rutracker.org');
    expect(domains).to.include('ntc.party');
    expect(domains).to.include('instagram.com');
    expect(domains).to.include('1.1.1.1');
    expect(domains).to.not.include('invalid_domain..');
  });

  it('should generate valid PAC script that correctly routes domains and subdomains', () => {
    const domains = ['rutracker.org', 'ntc.party'];
    const pacScript = generatePacScript({
      domains,
      proxies: 'HTTPS proxy.example.com:443',
      bypassLocal: true,
      ifProxyOrDie: false,
    });

    expect(pacScript).to.include('function FindProxyForURL');
    expect(pacScript).to.include('HTTPS proxy.example.com:443');

    // Test direct domain match
    const rule1 = testPacRule(pacScript, 'rutracker.org');
    expect(rule1.success).to.be.true;
    expect(rule1.isProxied).to.be.true;
    expect(rule1.route).to.equal('HTTPS proxy.example.com:443');

    // Test subdomain match
    const ruleSub = testPacRule(pacScript, 'static.rutracker.org');
    expect(ruleSub.success).to.be.true;
    expect(ruleSub.isProxied).to.be.true;
    expect(ruleSub.route).to.equal('HTTPS proxy.example.com:443');

    // Test non-matching domain
    const rule2 = testPacRule(pacScript, 'example.com');
    expect(rule2.success).to.be.true;
    expect(rule2.isProxied).to.be.false;
    expect(rule2.route).to.equal('DIRECT');
  });

  it('should support proxyOrDie option', () => {
    const domains = ['secret.com'];
    const pacScript = generatePacScript({
      domains,
      proxies: 'SOCKS5 127.0.0.1:1080',
      bypassLocal: false,
      ifProxyOrDie: true,
    });

    const ruleMatch = testPacRule(pacScript, 'secret.com');
    expect(ruleMatch.success).to.be.true;
    expect(ruleMatch.isProxied).to.be.true;
    expect(ruleMatch.route).to.equal('SOCKS5 127.0.0.1:1080');

    const ruleNonMatch = testPacRule(pacScript, 'other.com');
    expect(ruleNonMatch.success).to.be.true;
    expect(ruleNonMatch.isProxied).to.be.false;
    expect(ruleNonMatch.route).to.equal('');
  });
});
