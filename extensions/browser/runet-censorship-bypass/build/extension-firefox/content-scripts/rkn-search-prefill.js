'use strict';

(() => {
  const fragmentKey = 'anticheburnet-search';
  const params = new URLSearchParams(window.location.hash.slice(1));
  const lookupUrl = params.get(fragmentKey);
  if (!lookupUrl) return;

  try {
    const parsed = new URL(lookupUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return;
  } catch {
    return;
  }

  const input = document.querySelector('#inputMsg[name="searchstring"], input[name="searchstring"]');
  if (!input) return;

  input.value = lookupUrl;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  input.focus();

  // The fragment is never sent in the HTTP request. Remove it after filling
  // the form so the checked address does not remain in the browser history.
  window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
})();
