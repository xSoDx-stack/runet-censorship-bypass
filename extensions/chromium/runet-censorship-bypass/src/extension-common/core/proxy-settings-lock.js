'use strict';

// chrome.proxy.settings is global for the browser profile. Every temporary or
// permanent mutation must pass through this queue so probes cannot race PAC installs.
let mutationQueue = Promise.resolve();

export function withProxySettingsLock(task) {
  if (typeof task !== 'function') {
    return Promise.reject(new TypeError('task must be a function'));
  }
  const next = mutationQueue.then(task, task);
  mutationQueue = next.catch(() => {});
  return next;
}
