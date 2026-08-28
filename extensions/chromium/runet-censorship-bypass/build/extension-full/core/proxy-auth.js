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
}

export function buildProxyCredentialsMap(customProxyStringRaw = '') {
  const newMap = {};
  if (customProxyStringRaw) {
    const lines = customProxyStringRaw
      .replace(/#.*$/gm, '')
      .split(/(?:\s*(?:;\r?\n)+\s*|\r?\n+|;\s*)+/g)
      .map((l) => l.trim())
      .filter((l) => l && /\s+/g.test(l));

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
}

export async function updateProxyCredentialsFromRaw(customProxyStringRaw = '') {
  const newMap = buildProxyCredentialsMap(customProxyStringRaw);
  await storage.set('proxy-credentials-map', newMap);
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

    const requestTries = {};

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

        // If credentials are in memory and already initialized, handle immediately
        if (appState.isInitialized && (Object.keys(persistentCredentialsMap).length > 0 || Object.keys(temporaryCredentialsMap).length > 0)) {
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
