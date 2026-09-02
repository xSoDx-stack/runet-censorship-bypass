'use strict';

import { expect } from 'chai';
import { validatePacScriptSource } from '../src/extension-common/core/pac-validator.js';

describe('PAC source validation', () => {
  it('accepts top-level declarations and direct function assignments', () => {
    expect(validatePacScriptSource(
      'function FindProxyForURL(url, host) { return "DIRECT"; }',
    ).valid).to.equal(true);
    expect(validatePacScriptSource(
      'var FindProxyForURL = function(url, host) { return "DIRECT"; };',
    ).valid).to.equal(true);
    expect(validatePacScriptSource(
      'globalThis.FindProxyForURL = (url, host) => "DIRECT";',
    ).valid).to.equal(true);
  });

  it('does not mistake comments, strings or regular expressions for PAC code', () => {
    const decoys = [
      '// function FindProxyForURL(url, host) {}',
      'const text = "function FindProxyForURL(url, host) {}";',
      'const matcher = /FindProxyForURL/;',
    ];

    for (const source of decoys) {
      const result = validatePacScriptSource(source);
      expect(result.valid).to.equal(false);
      expect(result.error).to.include('FindProxyForURL');
    }
  });

  it('rejects empty and truncated responses before changing proxy settings', () => {
    expect(validatePacScriptSource('   ').valid).to.equal(false);
    expect(validatePacScriptSource('function FindProxyForURL(url, host)').valid)
      .to.equal(false);
    const truncated = validatePacScriptSource(
      'function FindProxyForURL(url, host) { if (host) { return "DIRECT";',
    );
    expect(truncated.valid).to.equal(false);
    expect(truncated.error).to.match(/оборван|синтаксическ/);
  });
});
