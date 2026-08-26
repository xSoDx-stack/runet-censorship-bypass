'use strict';

import { ipToHost } from './ip-to-host.js';
import { pacKitchen } from './pac-kitchen.js';
import { pacSync } from './pac-sync.js';

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

    // 1. Reset on tab navigation / reload
    if (chrome.webNavigation && chrome.webNavigation.onBeforeNavigate) {
      chrome.webNavigation.onBeforeNavigate.addListener((details) => {
        if (details.frameId === 0 && details.tabId >= 0) {
          this.clearTab(details.tabId);
        }
      });
    }

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
        (details) => this.handleRequest(details),
        { urls: ['<all_urls>'] }
      );
    }
  }

  clearTab(tabId) {
    this.tabData.delete(tabId);
    try {
      if (chrome.action) {
        chrome.action.setBadgeText({ tabId, text: '' });
        chrome.action.setTitle({ tabId, title: this.defaultTitle });
      }
    } catch {
      // Tab may no longer exist
    }
  }

  handleRequest(details) {
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
    if (!proxyHost) {
      try {
        const mods = pacKitchen.cachedMods;
        if (mods && mods.userAddedExceptions) {
          const match = pacKitchen.matchExceptionDomain(hostname, mods.userAddedExceptions);
          if (match && match.matched && match.isProxied) {
            proxyHost = (mods.proxies || 'Proxy').split(';')[0].trim();
          }
        }
      } catch {
        // Non-critical
      }
    }

    // C. Check if raw PAC contains domain
    if (!proxyHost && pacSync && pacSync.rawPacData) {
      if (pacSync.isDomainInPac(hostname)) {
        proxyHost = pacSync.getProxyTitle();
      }
    }

    if (!proxyHost) {
      return;
    }

    this.recordProxiedHost(details.tabId, hostname, proxyHost, details.type === 'main_frame');
  }

  recordProxiedHost(tabId, hostname, proxyHost, isMainFrame) {
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

    try {
      if (chrome.action) {
        chrome.action.setBadgeBackgroundColor({
          tabId,
          color: '#db4b2f',
        });
        chrome.action.setBadgeText({
          tabId,
          text: badgeText,
        });
        chrome.action.setTitle({
          tabId,
          title: tooltip,
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
