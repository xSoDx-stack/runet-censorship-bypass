'use strict';

import { storage } from './storage.js';
import { utils } from './utils.js';
import { appState } from './app-state.js';
import { logger } from './logger.js';

/**
 * Proxy Authentication Manager for Chrome MV3
 * Maintains strict separation between persistent credentials (stored in chrome.storage.local)
 * and temporary credentials (in-memory only, used exclusively for health-check probes).
 */

// Persistent credentials map (saved to storage, survives restarts): "host:port" / "host" -> { username, password }
let persistentCredentialsMap = {};

// Temporary credentials map (in-memory only, never saved to storage, cleaned up after health check): "host:port" / "host" -> { username, password }
let temporaryCredentialsMap = {};

const AUTH_ATTEMPTS_KEY = 'proxy-auth-attempts';
const AUTH_TRY_TTL_MS = 60_000;
const MAX_AUTH_TRIES = 3;
const MAX_TRACKED_REQUESTS = 500;
let authAttemptsQueue = Promise.resolve();
const memoryAuthAttempts = new Map();

function getSessionStorageArea() {
  if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.session) {
    return null;
  }
  return chrome.storage.session;
}

function callSessionStorage(method, ...args) {
  const area = getSessionStorageArea();
  if (!area || typeof area[method] !== 'function') {
    return Promise.resolve(null);
  }
  return new Promise((resolve, reject) => {
    area[method](...args, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(result);
    });
  });
}

function withAuthAttemptsLock(task) {
  const next = authAttemptsQueue.then(task, task);
  authAttemptsQueue = next.catch(() => {});
  return next;
}

function normalizeAuthAttempts(raw, now = Date.now()) {
  const normalized = {};
  if (!raw || typeof raw !== 'object') return normalized;

  const recent = Object.entries(raw)
    .filter(([, state]) => state && Number.isInteger(state.tries) &&
      state.tries > 0 && Number.isFinite(state.updatedAt) &&
      now - state.updatedAt < AUTH_TRY_TTL_MS)
    .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
    .slice(0, MAX_TRACKED_REQUESTS);

  for (const [key, state] of recent) {
    normalized[key] = { tries: state.tries, updatedAt: state.updatedAt };
  }
  return normalized;
}

/**
 * Atomically consumes an authentication attempt for a request. The state is
 * kept in chrome.storage.session so it survives MV3 service-worker restarts,
 * while containing no proxy endpoint or credential data.
 *
 * @param {string|number} requestId Chrome webRequest request identifier
 * @param {number} [now=Date.now()] current time, injectable for tests
 * @returns {Promise<{allowed: boolean, tries: number}>}
 */
export function consumeProxyAuthAttempt(requestId, now = Date.now()) {
  return withAuthAttemptsLock(async () => {
    const storageArea = getSessionStorageArea();
    const key = `request:${String(requestId || '')}`;

    if (!storageArea) {
      const previous = memoryAuthAttempts.get(key);
      const tries = previous && now - previous.updatedAt < AUTH_TRY_TTL_MS
        ? previous.tries
        : 0;
      if (tries >= MAX_AUTH_TRIES) return { allowed: false, tries };
      memoryAuthAttempts.set(key, { tries: tries + 1, updatedAt: now });
      return { allowed: true, tries: tries + 1 };
    }

    const stored = await callSessionStorage('get', AUTH_ATTEMPTS_KEY);
    const attempts = normalizeAuthAttempts(stored && stored[AUTH_ATTEMPTS_KEY], now);
    const tries = attempts[key] ? attempts[key].tries : 0;
    if (tries >= MAX_AUTH_TRIES) return { allowed: false, tries };

    attempts[key] = { tries: tries + 1, updatedAt: now };
    await callSessionStorage('set', { [AUTH_ATTEMPTS_KEY]: attempts });
    return { allowed: true, tries: tries + 1 };
  });
}

/**
 * Clears durable authentication retry state for one completed request or for
 * the entire browser session after credentials/configuration change.
 *
 * @param {string|number|null} [requestId=null]
 * @returns {Promise<void>}
 */
export function clearProxyAuthAttempts(requestId = null) {
  return withAuthAttemptsLock(async () => {
    const storageArea = getSessionStorageArea();
    if (requestId === null || requestId === undefined) {
      memoryAuthAttempts.clear();
      if (storageArea) await callSessionStorage('remove', AUTH_ATTEMPTS_KEY);
      return;
    }

    const key = `request:${String(requestId)}`;
    memoryAuthAttempts.delete(key);
    if (!storageArea) return;

    const stored = await callSessionStorage('get', AUTH_ATTEMPTS_KEY);
    const attempts = normalizeAuthAttempts(stored && stored[AUTH_ATTEMPTS_KEY]);
    delete attempts[key];
    if (Object.keys(attempts).length) {
      await callSessionStorage('set', { [AUTH_ATTEMPTS_KEY]: attempts });
    } else {
      await callSessionStorage('remove', AUTH_ATTEMPTS_KEY);
    }
  });
}

function isLoopbackHost(host = '') {
  const h = (host || '').toLowerCase().trim();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]' || h === '0.0.0.0';
}

function getHostAliases(hostname = '') {
  const h = (hostname || '').toLowerCase().trim();
  if (isLoopbackHost(h)) {
    return ['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0'];
  }
  return [h];
}

export async function initProxyAuth() {
  const mods = await storage.get('pac-kitchen-mods', {});
  persistentCredentialsMap = buildProxyCredentialsMap(mods.customProxyStringRaw || '');
  await storage.remove('proxy-credentials-map').catch(() => {});
}

export function buildProxyCredentialsMap(customProxyStringRaw = '') {
  const newMap = {};
  if (customProxyStringRaw) {
    const lines = customProxyStringRaw
      .replace(/#.*$/gm, '')
      .split(/(?:\s*(?:;\r?\n)+\s*|\r?\n+|;\s*)+/g)
      .map((l) => l.trim())
      .filter(Boolean);

    for (const line of lines) {
      const parsed = utils.parseProxyScheme(line);
      if (parsed && parsed.hostname && parsed.username && parsed.port) {
        const port = parsed.port;
        const creds = {
          username: String(parsed.username),
          password: String(parsed.password || ''),
        };

        const aliases = getHostAliases(parsed.hostname);
        for (const alias of aliases) {
          // Strictly store host:port scoped credentials
          newMap[`${alias}:${port}`] = creds;
        }
      }
    }
  }
  return newMap;
}

export function commitProxyCredentials(newMap) {
  persistentCredentialsMap = Object.assign({}, newMap || {});
}

export function resetProxyCredentialsState() {
  persistentCredentialsMap = {};
  temporaryCredentialsMap = {};
  clearProxyAuthAttempts().catch((err) => {
    console.warn('[Proxy Auth] Failed to clear retry state:', err);
  });
}

export async function updateProxyCredentialsFromRaw(customProxyStringRaw = '') {
  const newMap = buildProxyCredentialsMap(customProxyStringRaw);
  await storage.remove('proxy-credentials-map').catch(() => {});
  await clearProxyAuthAttempts();
  commitProxyCredentials(newMap);
  return getPersistentCredentialsMap();
}

export function registerTemporaryCredentials(hostname, port, username, password) {
  if (!hostname || !username) return;
  const h = String(hostname).toLowerCase().trim();
  const portStr = String(port || '443').trim();
  const creds = {
    username: String(username),
    password: String(password || ''),
  };

  const aliases = getHostAliases(h);
  for (const alias of aliases) {
    temporaryCredentialsMap[`${alias}:${portStr}`] = creds;
  }
}

export function unregisterTemporaryCredentials(hostname, port) {
  if (!hostname) {
    temporaryCredentialsMap = {};
    return;
  }
  const h = String(hostname).toLowerCase().trim();
  const portStr = port ? String(port).trim() : '';
  const aliases = getHostAliases(h);
  for (const alias of aliases) {
    if (portStr) {
      delete temporaryCredentialsMap[`${alias}:${portStr}`];
    } else {
      for (const k of Object.keys(temporaryCredentialsMap)) {
        if (k.startsWith(`${alias}:`)) {
          delete temporaryCredentialsMap[k];
        }
      }
    }
  }
}

function lookupInMap(map, hostStr, portStr) {
  if (!map || !hostStr) return null;

  // 1. If port is provided in challenge: STRICT canonical host:port lookup ONLY
  if (portStr) {
    if (map[`${hostStr}:${portStr}`]) {
      return map[`${hostStr}:${portStr}`];
    }
    // Loopback aliases with exact same port
    if (isLoopbackHost(hostStr)) {
      const loopbacks = ['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0'];
      for (const lb of loopbacks) {
        if (map[`${lb}:${portStr}`]) {
          return map[`${lb}:${portStr}`];
        }
      }
    }
    // Strict isolation: DO NOT fall back to another port or host-only if port was provided
    return null;
  }

  // 2. If port was NOT provided in challenge: allow fallback only if there is exactly ONE entry for host
  const candidateKeys = [];
  const loopbacks = isLoopbackHost(hostStr)
    ? ['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']
    : [hostStr];

  for (const lb of loopbacks) {
    for (const key of Object.keys(map)) {
      if (key.startsWith(`${lb}:`)) {
        candidateKeys.push(key);
      }
    }
  }

  if (candidateKeys.length === 0) return null;

  // Check if all matched entries have the exact same credentials (unambiguous)
  const firstCreds = map[candidateKeys[0]];
  const allSame = candidateKeys.every((k) => {
    const c = map[k];
    return c && c.username === firstCreds.username && c.password === firstCreds.password;
  });

  if (allSame && firstCreds && firstCreds.username) {
    return firstCreds;
  }

  return null;
}

export function findCredentials(host, port) {
  const hostStr = (host || '').toLowerCase().trim();
  const portStr = port !== undefined && port !== null && String(port).trim() !== ''
    ? String(port).trim()
    : '';

  if (!hostStr) return null;

  // 1. Check temporary credentials first (active probe)
  const tempCreds = lookupInMap(temporaryCredentialsMap, hostStr, portStr);
  if (tempCreds && tempCreds.username) {
    return tempCreds;
  }

  // 2. Fall back to persistent credentials
  const permCreds = lookupInMap(persistentCredentialsMap, hostStr, portStr);
  if (permCreds && permCreds.username) {
    return permCreds;
  }

  return null;
}

export function getPersistentCredentialsMap() {
  return Object.assign({}, persistentCredentialsMap);
}

export function getTemporaryCredentialsMap() {
  return Object.assign({}, temporaryCredentialsMap);
}

export function setupAuthListener() {
  if (chrome.webRequest && chrome.webRequest.onAuthRequired) {
    if (chrome.webRequest.onAuthRequired.hasListeners && chrome.webRequest.onAuthRequired.hasListeners()) {
      return;
    }

    const requestTries = new Map();

    chrome.webRequest.onAuthRequired.addListener(
      (details, asyncCallback) => {
        if (!details.isProxy) {
          if (asyncCallback) asyncCallback({});
          return {};
        }

        const handleAuth = async (useDurableAttempts) => {
          const host = details.challenger.host;
          const port = details.challenger.port;
          const creds = findCredentials(host, port);

          if (creds && creds.username) {
            const reqId = details.requestId;
            if (useDurableAttempts) {
              const attempt = await consumeProxyAuthAttempt(reqId);
              if (!attempt.allowed) {
                console.warn('[Proxy Auth] Max attempts (3) exceeded');
                return { cancel: true };
              }
            } else {
              if (requestTries.size > MAX_TRACKED_REQUESTS) {
                const cutoff = Date.now() - AUTH_TRY_TTL_MS;
                for (const [id, state] of requestTries) {
                  if (state.updatedAt < cutoff || requestTries.size > MAX_TRACKED_REQUESTS) {
                    requestTries.delete(id);
                  }
                }
              }
              const previous = requestTries.get(reqId);
              const tries = previous && Date.now() - previous.updatedAt < AUTH_TRY_TTL_MS
                ? previous.tries
                : 0;
              if (tries >= MAX_AUTH_TRIES) {
                console.warn('[Proxy Auth] Max attempts (3) exceeded');
                return { cancel: true };
              }
              requestTries.set(reqId, { tries: tries + 1, updatedAt: Date.now() });
            }

            console.log('[Proxy Auth] Authenticating proxy');
            logger.info('auth', 'Аутентификация прокси', 'Отправка учётных данных');

            return {
              authCredentials: {
                username: String(creds.username),
                password: String(creds.password || ''),
              },
            };
          }

          console.warn('[Proxy Auth] No credentials found');
          return {};
        };

        if (asyncCallback) {
          const ready = appState.isInitialized &&
            (Object.keys(persistentCredentialsMap).length > 0 || Object.keys(temporaryCredentialsMap).length > 0)
            ? Promise.resolve()
            : appState.ensureInitialized();
          ready
            .then(() => handleAuth(true))
            .then((response) => asyncCallback(response))
            .catch((err) => {
              console.warn('[Proxy Auth] Error during auth ensureInitialized:', err);
              // If retry state cannot be read/written reliably, do not risk an
              // unbounded authentication loop.
              asyncCallback({ cancel: true });
            });
          return;
        }

        // Compatibility path for direct/unit invocations without Chrome's
        // asyncBlocking callback. Real MV3 auth events use the durable branch.
        const host = details.challenger.host;
        const port = details.challenger.port;
        const creds = findCredentials(host, port);
        if (!creds || !creds.username) {
          console.warn('[Proxy Auth] No credentials found');
          return {};
        }
        const reqId = details.requestId;
        const previous = requestTries.get(reqId);
        const tries = previous && Date.now() - previous.updatedAt < AUTH_TRY_TTL_MS
          ? previous.tries
          : 0;
        if (tries >= MAX_AUTH_TRIES) {
          console.warn('[Proxy Auth] Max attempts (3) exceeded');
          return { cancel: true };
        }
        requestTries.set(reqId, { tries: tries + 1, updatedAt: Date.now() });
        console.log('[Proxy Auth] Authenticating proxy');
        logger.info('auth', 'Аутентификация прокси', 'Отправка учётных данных');
        return {
          authCredentials: {
            username: String(creds.username),
            password: String(creds.password || ''),
          },
        };
      },
      { urls: ['<all_urls>'] },
      ['asyncBlocking']
    );

    const cleanup = (details) => {
      requestTries.delete(details.requestId);
      clearProxyAuthAttempts(details.requestId).catch((err) => {
        console.warn('[Proxy Auth] Failed to clear completed request state:', err);
      });
    };
    chrome.webRequest.onCompleted.addListener(cleanup, { urls: ['<all_urls>'] });
    chrome.webRequest.onErrorOccurred.addListener(cleanup, { urls: ['<all_urls>'] });
  }
}
