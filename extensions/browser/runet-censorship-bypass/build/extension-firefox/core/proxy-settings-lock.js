'use strict';

import { utils } from './utils.js';
import { proxyBackend } from './proxy-backend.js';

// chrome.proxy.settings is global for the browser profile. Every temporary or
// permanent mutation must pass through this queue so probes cannot race PAC installs.
let mutationQueue = Promise.resolve();

export class ProxySettingsNotControllableError extends Error {
  constructor(levelOfControl = 'unknown') {
    super('Настройки прокси контролируются другим расширением или политикой браузера.');
    this.name = 'ProxySettingsNotControllableError';
    this.code = 'PROXY_NOT_CONTROLLABLE';
    this.levelOfControl = levelOfControl;
  }
}

/**
 * Reads the live profile-wide proxy ownership state and rejects unless this
 * extension may mutate it. Call this inside withProxySettingsLock immediately
 * before every set/clear operation.
 *
 * @returns {Promise<object>} current chrome.proxy.settings details
 */
export function assertProxySettingsControllable() {
  return proxyBackend.getSettings().then((details) => {
    if (!utils.areSettingsControllableFor(details)) {
      throw new ProxySettingsNotControllableError(details && details.levelOfControl);
    }
    return details || {};
  });
}

export function withProxySettingsLock(task) {
  if (typeof task !== 'function') {
    return Promise.reject(new TypeError('task must be a function'));
  }
  const next = mutationQueue.then(task, task);
  mutationQueue = next.catch(() => {});
  return next;
}
