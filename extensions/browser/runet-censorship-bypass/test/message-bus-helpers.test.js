'use strict';

import { expect } from 'chai';
import {
  createErrorResponse,
  getConnectionTestUrl,
  getRequestedCurrentHost,
  getRequestedCurrentTabId,
  removeMatchingExceptionRules,
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

  it('accepts only a valid current browser tab ID', () => {
    expect(getRequestedCurrentTabId({ currentTabId: 42 })).to.equal(42);
    expect(getRequestedCurrentTabId({ currentTabId: -1 })).to.equal(null);
    expect(getRequestedCurrentTabId({ currentTabId: null })).to.equal(null);
    expect(getRequestedCurrentTabId({ currentTabId: 'invalid' })).to.equal(null);
  });

  it('removes the wildcard rule that actually controls the current site', () => {
    const result = removeMatchingExceptionRules('example.com', {
      '*.example.com': true,
      'unrelated.example': true,
    });

    expect(result.exceptions).to.deep.equal({ 'unrelated.example': true });
    expect(result.removedRuleKeys).to.deep.equal(['*.example.com']);
    expect(result.currentSiteMatch).to.deep.equal({ matched: false });
  });

  it('removes every nested manual rule before returning a site to PAC', () => {
    const result = removeMatchingExceptionRules('docs.sub.example.com', {
      'docs.sub.example.com': false,
      '*.sub.example.com': true,
      'example.com': true,
      'unrelated.example': false,
    });

    expect(result.exceptions).to.deep.equal({ 'unrelated.example': false });
    expect(result.removedRuleKeys).to.deep.equal([
      'docs.sub.example.com',
      '*.sub.example.com',
      'example.com',
    ]);
    expect(result.currentSiteMatch).to.deep.equal({ matched: false });
  });

  it('does not mutate site rules when there is nothing to reset', () => {
    const exceptions = { 'other.example': true };
    const result = removeMatchingExceptionRules('example.com', exceptions);

    expect(result.exceptions).to.deep.equal(exceptions);
    expect(result.exceptions).to.not.equal(exceptions);
    expect(result.removedRuleKeys).to.deep.equal([]);
  });

  it('keeps an actionable error code in a failed runtime response', () => {
    const privateBrowsingError = new Error('Private browsing access is required');
    privateBrowsingError.code = 'FIREFOX_PRIVATE_BROWSING_REQUIRED';
    const wrappedError = new Error('PAC setup failed');
    wrappedError.wrapped = privateBrowsingError;

    expect(createErrorResponse(wrappedError)).to.deep.equal({
      success: false,
      error: 'PAC setup failed > Private browsing access is required',
      errorCode: 'FIREFOX_PRIVATE_BROWSING_REQUIRED',
    });
  });
});
