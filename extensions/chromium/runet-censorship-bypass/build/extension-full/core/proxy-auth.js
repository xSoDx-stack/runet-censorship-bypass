'use strict';

import { storage } from './storage.js';
import { utils } from './utils.js';
import { appState } from './app-state.js';

/**
 * Proxy Authentication Manager for Chrome MV3
 * Maintains strict separation between persistent credentials (stored in chrome.storage.local)
 * and temporary credentials (in-memory only, used exclusively for health-check probes).
 */

// Persistent credentials map (saved to storage, survives restarts): "host:port" / "host" -> { username, password }
let persistentCredentialsMap = {};

// Temporary credentials map (in-memory only, never saved to storage, cleaned up after health check): "host:port" / "host" -> { username, password }
let temporaryCredentialsMap = {};

// P1-4 fix: requestTries moved to module scope so it is accessible to cleanup listeners
// regardless of whether setupAuthListener ran its early return path.
// P1-6 fix: explicit flag to distinguish "initialized with zero proxies" from "not yet initialized"
let requestTries = {};
let proxyAuthInitialized = false;

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
  const saved = await storage.get('proxy-credentials-map', {});
  persistentCredentialsMap = Object.assign({}, saved);
  // P1-4 fix: reset try counter on every SW init to avoid stale state from previous lifecycle
  requestTries = {};
  // P1-6 fix: mark as truly initialized (distinct from "empty map")
  proxyAuthInitialized = true;
}

export async function updateProxyCredentialsFromRaw(customProxyStringRaw = '') {
  const newMap = {};
  if (customProxyStringRaw) {
    const lines = customProxyStringRaw
      .replace(/#.*$/gm, '')
      .split(/(?:\s*(?:;\r?\n)+\s*|\r?\n+|;\s*)+/g)
      .map((l) => l.trim())
      .filter((l) => l && /\s+/g.test(l));

    for (const line of lines) {
      const parsed = utils.parseProxyScheme(line);
      if (parsed.hostname && parsed.username) {
        const port = parsed.port || (parsed.type.startsWith('SOCKS') ? '1080' : '443');
        const creds = {
          username: String(parsed.username),
          password: String(parsed.password || ''),
        };

        const aliases = getHostAliases(parsed.hostname);
        for (const alias of aliases) {
          newMap[`${alias}:${port}`] = creds;
          newMap[alias] = creds;
        }
      }
    }
  }

  persistentCredentialsMap = newMap;
  await storage.set('proxy-credentials-map', newMap);
  return persistentCredentialsMap;
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
    temporaryCredentialsMap[alias] = creds;
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
    }
    delete temporaryCredentialsMap[alias];
  }
}

function lookupInMap(map, hostStr, portStr) {
  if (!map || !hostStr) return null;

  // 1. Direct host:port match
  if (portStr && map[`${hostStr}:${portStr}`]) {
    return map[`${hostStr}:${portStr}`];
  }

  // 2. Loopback aliases with port
  if (isLoopbackHost(hostStr)) {
    const loopbacks = ['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0'];
    if (portStr) {
      for (const lb of loopbacks) {
        if (map[`${lb}:${portStr}`]) {
          return map[`${lb}:${portStr}`];
        }
      }
    }
    // Loopback aliases host-only
    for (const lb of loopbacks) {
      if (map[lb]) {
        return map[lb];
      }
    }
  }

  // 3. Host only match
  if (map[hostStr]) {
    return map[hostStr];
  }

  return null;
}

export function findCredentials(host, port) {
  const hostStr = (host || '').toLowerCase().trim();
  const portStr = port ? String(port).trim() : '';

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

    // P1-4: requestTries is now in module scope (see top of file)
    // so cleanup listeners always reference the same object even after early return paths

    chrome.webRequest.onAuthRequired.addListener(
      (details, asyncCallback) => {
        if (!details.isProxy) {
          if (asyncCallback) asyncCallback({});
          return {};
        }

        const handleAuth = () => {
          const host = details.challenger.host;
          const port = details.challenger.port;
          const hostPortKey = `${host}:${port}`;

          const creds = findCredentials(host, port);

          if (creds && creds.username) {
            const reqId = details.requestId;
            const tries = requestTries[reqId] || 0;

            if (tries >= 3) {
              console.warn(`[Proxy Auth] Max attempts (3) exceeded for ${hostPortKey}`);
              const resp = { cancel: true };
              if (asyncCallback) asyncCallback(resp);
              return resp;
            }

            requestTries[reqId] = tries + 1;
            console.log(`[Proxy Auth] Authenticating proxy ${hostPortKey} (User: ${creds.username})`);

            const resp = {
              authCredentials: {
                username: String(creds.username),
                password: String(creds.password || ''),
              },
            };
            if (asyncCallback) asyncCallback(resp);
            return resp;
          }

          console.warn(`[Proxy Auth] No credentials found for ${hostPortKey}`);
          const resp = {};
          if (asyncCallback) asyncCallback(resp);
          return resp;
        };

        // P1-6 fix: use proxyAuthInitialized flag instead of checking map emptiness.
        // An empty map is valid (user has no proxies with passwords) and differs from
        // "not yet initialized". This prevents wrongly deferring auth on a valid empty state.
        if (proxyAuthInitialized) {
          return handleAuth();
        }

        // If in-memory is cold or initializing, wait for appState before responding
        if (asyncCallback) {
          appState.ensureInitialized()
            .then(() => handleAuth())
            .catch((err) => {
              console.warn('[Proxy Auth] Error during auth ensureInitialized:', err);
              asyncCallback({});
            });
          return {};
        } else {
          return handleAuth();
        }
      },
      { urls: ['<all_urls>'] },
      ['asyncBlocking']
    );

    const cleanup = (details) => {
      delete requestTries[details.requestId];
    };
    chrome.webRequest.onCompleted.addListener(cleanup, { urls: ['<all_urls>'] });
    chrome.webRequest.onErrorOccurred.addListener(cleanup, { urls: ['<all_urls>'] });
  }
}
