'use strict';

import { ipToHost } from './ip-to-host.js';
import { pacKitchen, matchExceptionDomain } from './pac-kitchen.js';
import { logger } from './logger.js';
import { appState } from './app-state.js';

const MAX_PROXIED_HOSTS_PER_TAB = 300;
const MAX_PROXIES_PER_TAB = 50;
const MAX_TRACKED_TABS = 150;
const ANTIZAPRET_PROXY_HOST = 'proxy.antizapret.prostovpn.org';
const TAB_ROUTE_STORAGE_PREFIX = 'block-informer-route:';

export function normalizeProxyEndpoint(proxyValue) {
  let value = String(proxyValue || '').trim().toLowerCase();
  if (!value) return '';
  value = value.replace(/^(?:https?|proxy|socks5?|quic)\s+/i, '').trim();
  if (value.includes('@')) value = value.slice(value.lastIndexOf('@') + 1);
  return value;
}

export function classifyProxySource(proxyHost, filteredCustomsString = '') {
  const endpoint = normalizeProxyEndpoint(proxyHost);
  if (!endpoint) return 'unknown';

  const customEndpoints = String(filteredCustomsString || '')
    .split(';')
    .map((item) => normalizeProxyEndpoint(item))
    .filter(Boolean);
  if (customEndpoints.includes(endpoint)) return 'own';

  const hostname = endpoint.startsWith('[')
    ? endpoint.slice(1, endpoint.indexOf(']'))
    : endpoint.replace(/:\d+$/, '');
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
    return 'own';
  }
  if (hostname === ANTIZAPRET_PROXY_HOST) return 'antizapret';
  return 'pac';
}

function proxyEndpointFromInfo(proxyInfo) {
  if (!proxyInfo || typeof proxyInfo !== 'object' || !proxyInfo.host) return '';
  let host = String(proxyInfo.host).trim().toLowerCase();
  if (host.includes(':') && !host.startsWith('[')) host = `[${host}]`;
  const port = Number(proxyInfo.port);
  return Number.isInteger(port) && port > 0 ? `${host}:${port}` : host;
}

function isFirefoxRuntime() {
  try {
    return chrome.runtime.getURL('').startsWith('moz-extension://');
  } catch {
    return false;
  }
}

function callSessionStorage(method, ...args) {
  if (typeof chrome === 'undefined' || !chrome.storage?.session ||
      typeof chrome.storage.session[method] !== 'function') {
    return Promise.resolve(null);
  }
  return new Promise((resolve, reject) => {
    chrome.storage.session[method](...args, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(result);
    });
  });
}

class BlockInformer {
  constructor() {
    this.tabData = new Map();
    this.defaultTitle = 'АнтиЧебурнет';
    this.initialized = false;
    this.registeredCustomProxyString = '';
    this.routeStoragePromise = Promise.resolve();
  }

  init() {
    if (this.initialized) return;
    this.initialized = true;

    if (typeof chrome === 'undefined') return;

    // P2.5: Clean up any stale tabData entries from previous SW lifecycle
    if (chrome.tabs && chrome.tabs.query) {
      chrome.tabs.query({}, (tabs) => {
        if (chrome.runtime.lastError) return;
        const activeIds = new Set(tabs.map((t) => t.id));
        for (const tabId of this.tabData.keys()) {
          if (!activeIds.has(tabId)) {
            this.tabData.delete(tabId);
          }
        }
      });
    }

    // 1. Reset on tab navigation / reload
    if (chrome.tabs && chrome.tabs.onUpdated) {
      chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
        if (changeInfo.status === 'loading' && tabId >= 0) {
          this.clearTab(tabId);
        }
      });
    }

    // 2. Cleanup on tab close
    if (chrome.tabs && chrome.tabs.onRemoved) {
      chrome.tabs.onRemoved.addListener((tabId) => {
        this.tabData.delete(tabId);
        this._removePersistedRoute(tabId);
      });
    }

    // 3. Listen to webRequest events
    if (chrome.webRequest && chrome.webRequest.onResponseStarted) {
      chrome.webRequest.onResponseStarted.addListener(
        (details) => this.handleRequest(details, true),
        { urls: ['<all_urls>'] }
      );
    }

    if (chrome.webRequest && chrome.webRequest.onErrorOccurred) {
      chrome.webRequest.onErrorOccurred.addListener(
        (details) => {
          this.handleRequest(details, false);
          this.handleConnectionError(details);
        },
        { urls: ['<all_urls>'] }
      );
    }
  }

  handleConnectionError(details) {
    const errStr = String(details?.error || '');
    // Browser error strings are internal and differ between engines. Use this
    // only as a best-effort diagnostic filter, never as a proxy health signal.
    if (!errStr || (!errStr.includes('PROXY') && !errStr.includes('TUNNEL'))) {
      return;
    }

    // Subresources and background/speculative requests can generate large
    // bursts while the proxy itself remains healthy. Only a failed top-level
    // navigation is useful enough to show in the user-facing journal.
    if (details.type !== 'main_frame' ||
        typeof details.tabId !== 'number' || details.tabId < 0) {
      return;
    }

    // Ignore internal extension URLs in both Chromium and Firefox.
    if (details.url && (
      details.url.startsWith('chrome-extension://') ||
      details.url.startsWith('moz-extension://')
    )) {
      return;
    }

    let parsedDomain = '';
    try {
      parsedDomain = new URL(details.url).hostname;
    } catch {
      parsedDomain = '';
    }

    logger.add({
      level: 'warn',
      category: 'proxy',
      title: errStr,
      message: 'Не удалось выполнить отдельный запрос через прокси. Это не означает, что прокси-сервер недоступен целиком.',
      details: {
        error: details.error,
        domain: parsedDomain,
        type: details.type,
      },
      // Do not merge failures for unrelated sites into one repeat counter.
      groupKey: `${errStr}|${parsedDomain}|${details.type}`,
    });
  }

  clearTab(tabId) {
    this.tabData.delete(tabId);
    this._removePersistedRoute(tabId);
    if (typeof chrome === 'undefined' || !chrome.action || tabId < 0) {
      return;
    }

    try {
      if (chrome.action.setBadgeText) {
        chrome.action.setBadgeText({ tabId, text: '' }, () => {
          if (chrome.runtime && chrome.runtime.lastError) { /* ignore closed tab */ }
        });
      }
      if (chrome.action.setTitle) {
        chrome.action.setTitle({ tabId, title: this.defaultTitle }, () => {
          if (chrome.runtime && chrome.runtime.lastError) { /* ignore closed tab */ }
        });
      }
    } catch {
      // Tab may no longer exist
    }
  }

  async handleRequest(details, requestSucceeded = true) {
    if (!details || typeof details.tabId !== 'number' || details.tabId < 0 || !details.url) {
      return;
    }

    // Ignore internal extension / browser URLs
    if (details.url.startsWith('chrome-extension://') || details.url.startsWith('chrome://') || details.url.startsWith('edge://')) {
      return;
    }

    let parsedUrl;
    try {
      parsedUrl = new URL(details.url);
    } catch {
      return;
    }

    const hostname = parsedUrl.hostname.toLowerCase();
    if (!hostname || hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
      return;
    }

    if (!appState.isInitialized) {
      try {
        await appState.ensureInitialized();
      } catch {
        // Non-critical: continue with available state
      }
    }

    let mods = null;
    try {
      mods = pacKitchen.getCachedMods();
      const customProxyString = mods?.filteredCustomsString || '';
      if (customProxyString !== this.registeredCustomProxyString) {
        ipToHost.updateFromPac(customProxyString);
        this.registeredCustomProxyString = customProxyString;
      }
    } catch {
      // Non-critical: route detection can continue with browser event data.
    }

    const isMainFrame = details.type === 'main_frame';
    const proxyInfo = details.proxyInfo;
    if (proxyInfo && String(proxyInfo.type || '').toLowerCase() === 'direct') {
      if (requestSucceeded && isMainFrame) {
        this.recordDirectRoute(details.tabId, hostname);
      }
      return;
    }

    let proxyHost = proxyEndpointFromInfo(proxyInfo);
    let confidence = proxyHost && requestSucceeded ? 'observed' : 'configured';

    // A. Check remote IP against known proxy IPs
    if (!proxyHost && details.ip) {
      const hostFromIp = ipToHost.get(details.ip);
      if (hostFromIp) {
        // If resource is fetched directly from proxy host itself, ignore
        if (hostname !== details.ip && hostname !== hostFromIp.replace(/:\d+$/, '')) {
          proxyHost = hostFromIp;
          confidence = requestSucceeded ? 'observed' : 'configured';
        }
      }
    }

    // Firefox exposes proxyInfo directly. If it is absent on a successful
    // top-level request, the navigation was made without a proxy.
    if (!proxyHost && requestSucceeded && isMainFrame && isFirefoxRuntime()) {
      this.recordDirectRoute(details.tabId, hostname);
      return;
    }

    // B. Check domain matching against PAC Kitchen user exceptions
    if (!proxyHost) {
      try {
        if (mods && mods.exceptions && Object.keys(mods.exceptions).length > 0) {
          const match = matchExceptionDomain(hostname, mods.exceptions);
          if (match && match.matched && match.isProxied) {
            proxyHost = (mods.filteredCustomsString || '').split(';')[0].trim();
            confidence = 'configured';
          }
        }
      } catch {
        // Non-critical
      }
    }

    if (!proxyHost) {
      return;
    }

    const source = classifyProxySource(proxyHost, mods?.filteredCustomsString || '');
    this.recordProxiedHost(
      details.tabId,
      hostname,
      proxyHost,
      isMainFrame,
      source,
      confidence
    );
  }

  _getOrCreateTabData(tabId) {
    if (tabId < 0) return null;

    if (this.tabData.size >= MAX_TRACKED_TABS && !this.tabData.has(tabId)) {
      const oldestKey = this.tabData.keys().next().value;
      if (oldestKey !== undefined) this.tabData.delete(oldestKey);
    }

    let data = this.tabData.get(tabId);
    if (!data) {
      data = {
        proxiedHosts: new Set(),
        proxies: new Set(),
        hasMainFrame: false,
        mainFrameRoute: null,
      };
      this.tabData.set(tabId, data);
    }
    return data;
  }

  _queueRouteStorage(task) {
    const next = this.routeStoragePromise.then(task, task);
    this.routeStoragePromise = next.catch((err) => {
      console.warn('[BlockInformer] Failed to persist tab route:', err);
    });
    return next;
  }

  _persistRoute(tabId, route) {
    if (!Number.isInteger(tabId) || tabId < 0 || !route) return;
    const key = `${TAB_ROUTE_STORAGE_PREFIX}${tabId}`;
    this._queueRouteStorage(() => callSessionStorage('set', { [key]: route }));
  }

  _removePersistedRoute(tabId) {
    if (!Number.isInteger(tabId) || tabId < 0) return;
    const key = `${TAB_ROUTE_STORAGE_PREFIX}${tabId}`;
    this._queueRouteStorage(() => callSessionStorage('remove', key));
  }

  clearRoutes() {
    this.tabData.clear();
    return this._queueRouteStorage(async () => {
      const stored = await callSessionStorage('get', null);
      const routeKeys = Object.keys(stored || {})
        .filter((key) => key.startsWith(TAB_ROUTE_STORAGE_PREFIX));
      if (routeKeys.length) await callSessionStorage('remove', routeKeys);
    });
  }

  recordDirectRoute(tabId, hostname) {
    const data = this._getOrCreateTabData(tabId);
    if (!data) return;
    data.mainFrameRoute = {
      kind: 'direct',
      source: 'direct',
      hostname,
      proxyHost: '',
      confidence: 'observed',
      observedAt: Date.now(),
    };
    this._persistRoute(tabId, data.mainFrameRoute);
  }

  recordProxiedHost(
    tabId,
    hostname,
    proxyHost,
    isMainFrame,
    source = 'unknown',
    confidence = 'configured'
  ) {
    if (tabId < 0) return;
    const data = this._getOrCreateTabData(tabId);
    if (!data) return;

    if (isMainFrame) {
      data.hasMainFrame = true;
      data.mainFrameRoute = {
        kind: 'proxy',
        source,
        hostname,
        proxyHost: normalizeProxyEndpoint(proxyHost),
        confidence,
        observedAt: Date.now(),
      };
      this._persistRoute(tabId, data.mainFrameRoute);
    }

    if (data.proxiedHosts.size >= MAX_PROXIED_HOSTS_PER_TAB && !data.proxiedHosts.has(hostname)) {
      const oldestHost = data.proxiedHosts.values().next().value;
      if (oldestHost !== undefined) {
        data.proxiedHosts.delete(oldestHost);
      }
    }
    data.proxiedHosts.add(hostname);

    if (data.proxies.size >= MAX_PROXIES_PER_TAB && !data.proxies.has(proxyHost)) {
      const oldestProxy = data.proxies.values().next().value;
      if (oldestProxy !== undefined) {
        data.proxies.delete(oldestProxy);
      }
    }
    data.proxies.add(proxyHost);

    const count = data.proxiedHosts.size;
    const badgeText = data.hasMainFrame ? String(count) : `%${count}`;

    const hostsList = Array.from(data.proxiedHosts).map((h) => `  ${h}`).join('\n');
    const proxiesList = Array.from(data.proxies).map((p) => `  ${p}`).join('\n');
    const tooltip = `Разблокированы:\n${hostsList}\nПрокси:\n${proxiesList}`;

    if (typeof chrome === 'undefined' || !chrome.action) {
      return;
    }

    try {
      if (chrome.action.setBadgeBackgroundColor) {
        chrome.action.setBadgeBackgroundColor({
          tabId,
          color: '#db4b2f',
        }, () => {
          if (chrome.runtime && chrome.runtime.lastError) { /* ignore closed tab */ }
        });
      }
      if (chrome.action.setBadgeText) {
        chrome.action.setBadgeText({
          tabId,
          text: badgeText,
        }, () => {
          if (chrome.runtime && chrome.runtime.lastError) { /* ignore closed tab */ }
        });
      }
      if (chrome.action.setTitle) {
        chrome.action.setTitle({
          tabId,
          title: tooltip,
        }, () => {
          if (chrome.runtime && chrome.runtime.lastError) { /* ignore closed tab */ }
        });
      }
    } catch {
      // Ignored if tab was closed
    }
  }

  getTabStats(tabId) {
    const data = this.tabData.get(tabId);
    if (!data) {
      return { count: 0, hosts: [], proxies: [] };
    }
    return {
      count: data.proxiedHosts.size,
      hosts: Array.from(data.proxiedHosts),
      proxies: Array.from(data.proxies),
    };
  }

  async getTabRoute(tabId, hostname = '') {
    // Finish any queued set/remove first, otherwise reopening the popup right
    // after changing a site rule can briefly restore the old observed route.
    await this.routeStoragePromise.catch(() => {});
    let route = this.tabData.get(tabId)?.mainFrameRoute;
    if (!route && Number.isInteger(tabId) && tabId >= 0) {
      const key = `${TAB_ROUTE_STORAGE_PREFIX}${tabId}`;
      try {
        const stored = await callSessionStorage('get', key);
        route = stored?.[key] || null;
      } catch (err) {
        console.warn('[BlockInformer] Failed to restore tab route:', err);
      }
    }
    if (!route) return null;

    const requestedHost = String(hostname || '').trim().toLowerCase();
    if (requestedHost &&
        route.hostname !== requestedHost &&
        !route.hostname.endsWith(`.${requestedHost}`) &&
        !requestedHost.endsWith(`.${route.hostname}`)) {
      return null;
    }
    return { ...route };
  }
}

export const blockInformer = new BlockInformer();
