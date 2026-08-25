'use strict';

import { storage } from './storage.js';
import { utils } from './utils.js';

/**
 * Proxy Authentication Manager for Chrome MV3
 */

// In-memory credentials map: "host:port" -> { username, password }
let proxyCredentialsMap = {};

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
  proxyCredentialsMap = Object.assign({}, saved);
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

  proxyCredentialsMap = newMap;
  await storage.set('proxy-credentials-map', newMap);
  return proxyCredentialsMap;
}

export function registerTemporaryCredentials(hostname, port, username, password) {
  if (!hostname || !username) return;
  const portStr = String(port || '443');
  const creds = {
    username: String(username),
    password: String(password || ''),
  };

  const aliases = getHostAliases(hostname);
  for (const alias of aliases) {
    proxyCredentialsMap[`${alias}:${portStr}`] = creds;
    proxyCredentialsMap[alias] = creds;
  }
}

export function unregisterTemporaryCredentials(hostname, port) {
  if (!hostname) return;
  const portStr = String(port || '443');
  const aliases = getHostAliases(hostname);
  for (const alias of aliases) {
    delete proxyCredentialsMap[`${alias}:${portStr}`];
  }
}

function findCredentials(host, port) {
  const hostStr = (host || '').toLowerCase().trim();
  const portStr = String(port || '');

  // 1. Direct host:port match
  if (proxyCredentialsMap[`${hostStr}:${portStr}`]) {
    return proxyCredentialsMap[`${hostStr}:${portStr}`];
  }

  // 2. Localhost aliases match
  if (isLoopbackHost(hostStr)) {
    const loopbacks = ['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0'];
    for (const lb of loopbacks) {
      if (proxyCredentialsMap[`${lb}:${portStr}`]) {
        return proxyCredentialsMap[`${lb}:${portStr}`];
      }
      if (proxyCredentialsMap[lb]) {
        return proxyCredentialsMap[lb];
      }
    }
  }

  // 3. Host only match
  if (proxyCredentialsMap[hostStr]) {
    return proxyCredentialsMap[hostStr];
  }

  // 4. Any key matching this port if loopback
  for (const key of Object.keys(proxyCredentialsMap)) {
    if (key.endsWith(`:${portStr}`)) {
      const keyHost = key.slice(0, -(portStr.length + 1));
      if (isLoopbackHost(keyHost) && isLoopbackHost(hostStr)) {
        return proxyCredentialsMap[key];
      }
    }
  }

  return null;
}

export function setupAuthListener() {
  if (chrome.webRequest && chrome.webRequest.onAuthRequired) {
    const requestTries = {};

    chrome.webRequest.onAuthRequired.addListener(
      (details, asyncCallback) => {
        if (!details.isProxy) {
          if (asyncCallback) asyncCallback({});
          return {};
        }

        const handleAuth = (credsMap) => {
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

        // If credentials are in memory, return synchronously or immediately
        if (Object.keys(proxyCredentialsMap).length > 0) {
          return handleAuth(proxyCredentialsMap);
        }

        // If in-memory is cold, rehydrate from storage
        chrome.storage.local.get('proxy-credentials-map', (saved) => {
          proxyCredentialsMap = Object.assign({}, saved['proxy-credentials-map'] || {});
          handleAuth(proxyCredentialsMap);
        });

        return {};
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
