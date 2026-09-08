'use strict';

import { storage } from './storage.js';
import { parseProxyScheme } from './utils.js';

export const PROXY_HEALTH_CACHE_KEY = 'proxy-health-cache';

const MAX_CACHE_ENTRIES = 100;
const MAX_ERROR_LENGTH = 500;
let cacheQueue = Promise.resolve();

function enqueueCacheOperation(operation) {
  const task = cacheQueue.then(operation, operation);
  cacheQueue = task.catch(() => {});
  return task;
}

function normalizeHealthEntry(entry) {
  if (!entry || typeof entry !== 'object' || typeof entry.ok !== 'boolean') {
    return null;
  }

  const checkedAt = Number(entry.checkedAt);
  if (!Number.isFinite(checkedAt) || checkedAt <= 0) {
    return null;
  }

  const normalized = {
    checking: false,
    ok: entry.ok,
    checkedAt,
  };
  if (Number.isFinite(entry.latency) && entry.latency >= 0) {
    normalized.latency = Math.round(entry.latency);
  }
  if (typeof entry.error === 'string' && entry.error) {
    normalized.error = entry.error.slice(0, MAX_ERROR_LENGTH);
  }
  return normalized;
}

function normalizeProxyList(proxyList) {
  const unique = new Set();
  for (const proxyRaw of proxyList || []) {
    const parsed = parseProxyScheme(proxyRaw);
    if (parsed) unique.add(parsed.raw);
  }
  return unique;
}

/**
 * Loads the last known health result for the currently configured proxies and
 * removes orphaned entries left behind after a proxy is edited or deleted.
 */
export function loadProxyHealthCache(proxyList = []) {
  return enqueueCacheOperation(async () => {
    const allowed = normalizeProxyList(proxyList);
    const stored = await storage.get(PROXY_HEALTH_CACHE_KEY, {});
    const filtered = {};

    for (const proxyRaw of allowed) {
      const entry = normalizeHealthEntry(stored && stored[proxyRaw]);
      if (entry) filtered[proxyRaw] = entry;
    }

    if (JSON.stringify(stored || {}) !== JSON.stringify(filtered)) {
      await storage.set(PROXY_HEALTH_CACHE_KEY, filtered);
    }
    return filtered;
  });
}

/** Persists one completed proxy check. In-progress checks are never cached. */
export function saveProxyHealthResult(proxyRaw, result, checkedAt = Date.now()) {
  return enqueueCacheOperation(async () => {
    const parsed = parseProxyScheme(proxyRaw);
    const entry = normalizeHealthEntry(Object.assign({}, result, { checkedAt }));
    if (!parsed || !entry) return null;

    const stored = await storage.get(PROXY_HEALTH_CACHE_KEY, {});
    const entries = Object.entries(Object.assign({}, stored, { [parsed.raw]: entry }))
      .map(([proxy, health]) => [proxy, normalizeHealthEntry(health)])
      .filter(([, health]) => health)
      .sort((a, b) => b[1].checkedAt - a[1].checkedAt)
      .slice(0, MAX_CACHE_ENTRIES);

    await storage.set(PROXY_HEALTH_CACHE_KEY, Object.fromEntries(entries));
    return entry;
  });
}

/** Keeps cache entries only for the supplied proxy list. */
export function pruneProxyHealthCache(proxyList = []) {
  return loadProxyHealthCache(proxyList);
}
