'use strict';

import { storage } from './core/storage.js';
import { pacSync } from './core/pac-sync.js';
import { pacKitchen } from './core/pac-kitchen.js';
import { setupAuthListener, initProxyAuth } from './core/proxy-auth.js';
import { ipToHost } from './core/ip-to-host.js';
import { blockInformer } from './core/block-informer.js';
import { errorHandlers } from './core/error-handlers.js';
import { setupContextMenus, createContextMenuItems } from './core/context-menus.js';
import { setupMessageBus } from './core/message-bus.js';
import { logger } from './core/logger.js';

console.log('[Service Worker] Initializing Runet Censorship Bypass (MV3)...');

// Setup messaging, context menus, and event subsystems synchronously at top level
setupMessageBus();
setupAuthListener();
setupContextMenus();
blockInformer.init();
errorHandlers.init();
logger.init();

// Capture proxy connection failures strictly for diagnostic logging
if (chrome.webRequest && chrome.webRequest.onErrorOccurred) {
  chrome.webRequest.onErrorOccurred.addListener(
    (details) => {
      const errStr = String(details.error || '');
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
    },
    { urls: ['<all_urls>'] }
  );
}

// Alarms listener for background periodic synchronization
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'periodic-pac-update') {
    console.log('[Service Worker Alarm] Triggering periodic PAC update:', new Date().toLocaleString('ru-RU'));
    pacSync.syncWithPacProvider({ ifUnattended: true }).catch((err) => {
      console.warn('[Periodic PAC Update Warning]:', err);
    });
  }
});

// Extension Installed / Updated
chrome.runtime.onInstalled.addListener(async (details) => {
  console.log('[Service Worker] onInstalled reason:', details.reason);
  createContextMenuItems();
  await initProxyAuth();
  await ipToHost.init();
  await pacSync.init();

  if (details.reason === 'install') {
    const consentGiven = await storage.get('ifConsentGiven', false);
    if (!consentGiven) {
      chrome.tabs.create({ url: chrome.runtime.getURL('pages/options/index.html') });
    }
  }
});

// Browser Startup
chrome.runtime.onStartup.addListener(async () => {
  console.log('[Service Worker] onStartup');
  await initProxyAuth();
  await ipToHost.init();
  await pacSync.init();
});
