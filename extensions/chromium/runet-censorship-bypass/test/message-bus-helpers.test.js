'use strict';

import { expect } from 'chai';
import {
  getConnectionTestUrl,
  getRequestedCurrentHost,
  serializePacMods,
} from '../src/extension-common/core/message-bus.js';

describe('Message bus request helpers', () => {
  it('reads the currentDomain field sent by the options UI', () => {
    expect(getRequestedCurrentHost({ currentDomain: ' Example.COM ' })).to.equal('example.com');
  });

  it('keeps compatibility with the legacy currentHost field', () => {
    expect(getRequestedCurrentHost({ currentHost: 'Legacy.Example' })).to.equal('legacy.example');
  });

  it('tests the active custom PAC URL instead of an unrelated provider', () => {
    const customUrl = 'https://custom.example/proxy.pac';
    expect(getConnectionTestUrl({
      currentPacProviderKey: 'customPacUrl',
      customPacUrl: customUrl,
    })).to.equal(customUrl);
  });

  it('falls back to the built-in provider for an unknown provider', () => {
    expect(getConnectionTestUrl({ currentPacProviderKey: 'missing-provider' }))
      .to.match(/^https:\/\//);
  });

  it('includes site rules only when the caller explicitly requests them', () => {
    const mods = {
      exceptions: { 'example.com': true },
      whitelist: ['allowed.example'],
    };

    expect(serializePacMods(mods, false)).to.not.have.property('exceptions');
    expect(serializePacMods(mods, true)).to.include.keys('exceptions', 'whitelist');
    expect(serializePacMods(mods, true).exceptions).to.deep.equal({ 'example.com': true });
    expect(serializePacMods(mods, true).whitelist).to.deep.equal(['allowed.example']);
  });
});
