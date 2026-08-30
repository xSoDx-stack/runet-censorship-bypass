'use strict';

import { ipToHost } from './ip-to-host.js';
import { pacKitchen, matchExceptionDomain } from './pac-kitchen.js';
import { logger } from './logger.js';
import { appState } from './app-state.js';

class BlockInformer {
  constructor() {
    this.tabData = new Map();
    this.defaultTitle = 'АнтиЧебурнет';
    this.initialized = false;
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
      });
    }

    // 3. Listen to webRequest events
    if (chrome.webRequest && chrome.webRequest.onResponseStarted) {
      chrome.webRequest.onResponseStarted.addListener(
        (details) => this.handleRequest(details),
        { urls: ['<all_urls>'] }
      );
    }

    if (chrome.webRequest && chrome.webRequest.onErrorOccurred) {
      chrome.webRequest.onErrorOccurred.addListener(
        (details) => {
          this.handleRequest(details);
          this.handleConnectionError(details);
        },
        { urls: ['<all_urls>'] }
      );
    }
  }

  handleConnectionError(details) {
    const errStr = String(details?.error || '');
    // Only capture genuine proxy tunnel / proxy connection errors
    if (!errStr || (!errStr.includes('PROXY') && !errStr.includes('TUNNEL'))) {
      return;
    }

    // Ignore internal extension URLs
    if (details.url && details.url.startsWith('chrome-extension://')) {
      return;
    }

    let parsedDomain = '';
    try {
      parsedDomain = new URL(details.url).hostname;
    } catch {
      parsedDomain = '';
    }

    logger.add({
      level: 'error',
      category: 'proxy',
      title: errStr,
      message: `Сбой прокси при обращении к ${parsedDomain || 'серверу'}`,
      details: {
        error: details.error,
        domain: parsedDomain,
        type: details.type,
      },
    });
  }

  clearTab(tabId) {
    this.tabData.delete(tabId);
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

  async handleRequest(details) {
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

    let proxyHost = null;

    // A. Check remote IP against known proxy IPs
    if (details.ip) {
      const hostFromIp = ipToHost.get(details.ip);
      if (hostFromIp) {
        // If resource is fetched directly from proxy host itself, ignore
        if (hostname !== details.ip && hostname !== hostFromIp.replace(/:\d+$/, '')) {
          proxyHost = hostFromIp;
        }
      }
    }

    // B. Check domain matching against PAC Kitchen user exceptions
    // P0.3: Fixed — was using non-existent pacKitchen.cachedMods and pacKitchen.matchExceptionDomain
    if (!proxyHost) {
      try {
        const mods = pacKitchen.getCachedMods();
        if (mods && mods.exceptions && Object.keys(mods.exceptions).length > 0) {
          const match = matchExceptionDomain(hostname, mods.exceptions);
          if (match && match.matched && match.isProxied) {
            proxyHost = (mods.filteredCustomsString || 'Proxy').split(';')[0].trim();
          }
        }
      } catch {
        // Non-critical
      }
    }

    if (!proxyHost) {
      return;
    }

    this.recordProxiedHost(details.tabId, hostname, proxyHost, details.type === 'main_frame');
  }

  recordProxiedHost(tabId, hostname, proxyHost, isMainFrame) {
    if (tabId < 0) return;

    let data = this.tabData.get(tabId);
    if (!data) {
      data = {
        proxiedHosts: new Set(),
        proxies: new Set(),
        hasMainFrame: false,
      };
      this.tabData.set(tabId, data);
    }

    if (isMainFrame) {
      data.hasMainFrame = true;
    }

    data.proxiedHosts.add(hostname);
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
}

export const blockInformer = new BlockInformer();
