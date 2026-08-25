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

    const { domains, skipped } = parseDomainsInput(raw);
    expect(domains).to.include('rutracker.org');
    expect(domains).to.include('ntc.party');
    expect(domains).to.include('instagram.com');
    expect(domains).to.include('1.1.1.1');
    expect(domains).to.not.include('invalid_domain..');
    expect(skipped).to.be.greaterThan(0);
  });

  it('should generate valid PAC script that correctly routes domains and subdomains', () => {
    const domains = ['rutracker.org', 'ntc.party'];
    const pacScript = generatePacScript({
      domains,
      proxyString: 'HTTPS proxy.example.com:443',
      bypassLocal: true,
      proxyOrDie: false,
    });

    expect(pacScript).to.include('function FindProxyForURL');
    expect(pacScript).to.include('HTTPS proxy.example.com:443');

    // Test evaluation
    const rule1 = testPacRule(pacScript, 'rutracker.org');
    expect(rule1.success).to.be.true;
    expect(rule1.matched).to.be.true;
    expect(rule1.proxy).to.equal('HTTPS proxy.example.com:443');

    // Subdomain test
    const ruleSub = testPacRule(pacScript, 'static.rutracker.org');
    expect(ruleSub.success).to.be.true;
    expect(ruleSub.matched).to.be.true;
    expect(ruleSub.proxy).to.equal('HTTPS proxy.example.com:443');

    // Non-matching domain
    const rule2 = testPacRule(pacScript, 'example.com');
    expect(rule2.success).to.be.true;
    expect(rule2.matched).to.be.false;
    expect(rule2.proxy).to.equal('DIRECT');
  });

  it('should support proxyOrDie option', () => {
    const domains = ['secret.com'];
    const pacScript = generatePacScript({
      domains,
      proxyString: 'SOCKS5 127.0.0.1:1080',
      bypassLocal: false,
      proxyOrDie: true,
    });

    const ruleNonMatch = testPacRule(pacScript, 'other.com');
    expect(ruleNonMatch.success).to.be.true;
    expect(ruleNonMatch.matched).to.be.false;
    expect(ruleNonMatch.proxy).to.equal('');
  });
});
