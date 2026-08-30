import { expect } from 'chai';
import {
  normalizeDomainRule,
  parseDomainRuleLines,
  sanitizeRuleCollections,
} from '../src/extension-common/core/domain-rules.js';

describe('domain rules canonical validation', () => {
  it('normalizes URLs, wildcard domains and IDNs', () => {
    expect(normalizeDomainRule('HTTPS://WWW.Example.COM:443/path').domain).to.equal('www.example.com');
    expect(normalizeDomainRule('*.пример.рф').domain).to.equal('*.xn--e1afmkfd.xn--p1ai');
  });

  it('rejects malformed rules and out-of-range IPv4 addresses', () => {
    expect(normalizeDomainRule('__proto__').valid).to.equal(false);
    expect(normalizeDomainRule('999.1.1.1').valid).to.equal(false);
  });

  it('uses the same parser for imported rules', () => {
    const parsed = parseDomainRuleLines(['# comment', 'example.com', 'https://пример.рф/path', 'bad']);
    expect(parsed.validDomains).to.deep.equal(['example.com', 'xn--e1afmkfd.xn--p1ai']);
    expect(parsed.skippedCount).to.equal(1);
  });

  it('drops unsafe keys before background persistence', () => {
    const result = sanitizeRuleCollections({ 'example.com': true, '__proto__': false }, ['ok.example', 'bad']);
    expect(result.exceptions).to.deep.equal({ 'example.com': true });
    expect(result.whitelist).to.deep.equal(['ok.example']);
  });
});
