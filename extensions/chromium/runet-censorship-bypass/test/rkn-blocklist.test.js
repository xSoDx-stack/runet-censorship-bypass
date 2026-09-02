import { expect } from 'chai';
import {
  RKN_BLOCKLIST_URL,
  RKN_PREFILL_FRAGMENT_KEY,
  buildRknBlocklistUrl,
  normalizeRknLookupUrl,
} from '../src/extension-common/core/rkn-blocklist.js';

describe('RKN blocklist lookup links', () => {
  it('preserves an HTTP(S) page path while removing secrets and tracking data', () => {
    const result = normalizeRknLookupUrl(
      'https://user:secret@example.com/path?q=value#private-fragment'
    );

    expect(result).to.equal('https://example.com/path');
  });

  it('rejects browser and extension URLs', () => {
    expect(normalizeRknLookupUrl('chrome://extensions/')).to.equal('');
    expect(normalizeRknLookupUrl('chrome-extension://example/options.html')).to.equal('');
  });

  it('passes the lookup address in a fragment that is not sent to the server', () => {
    const target = 'https://пример.рф/page?q=1';
    const result = new URL(buildRknBlocklistUrl(target));
    const params = new URLSearchParams(result.hash.slice(1));

    expect(result.origin + result.pathname).to.equal(RKN_BLOCKLIST_URL);
    expect(params.get(RKN_PREFILL_FRAGMENT_KEY)).to.equal(
      normalizeRknLookupUrl(target)
    );
  });

  it('opens the service without prefill for an invalid address', () => {
    expect(buildRknBlocklistUrl('about:blank')).to.equal(RKN_BLOCKLIST_URL);
  });
});
