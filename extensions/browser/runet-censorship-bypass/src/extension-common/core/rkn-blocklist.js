'use strict';

export const RKN_BLOCKLIST_URL = 'https://blocklist.rkn.gov.ru/';
export const RKN_PREFILL_FRAGMENT_KEY = 'anticheburnet-search';

export function normalizeRknLookupUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return '';

  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return '';
    }

    // Credentials, query parameters and fragments are not required for a
    // registry lookup and may contain sensitive data that must not be copied
    // to a third-party form.
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.href;
  } catch {
    return '';
  }
}

export function buildRknBlocklistUrl(rawUrl) {
  const lookupUrl = normalizeRknLookupUrl(rawUrl);
  if (!lookupUrl) return RKN_BLOCKLIST_URL;

  const fragment = `${RKN_PREFILL_FRAGMENT_KEY}=${encodeURIComponent(lookupUrl)}`;
  return `${RKN_BLOCKLIST_URL}#${fragment}`;
}
