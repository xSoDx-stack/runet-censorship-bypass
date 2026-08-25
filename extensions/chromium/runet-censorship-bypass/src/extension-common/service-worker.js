'use strict';

import { storage } from './core/storage.js';
import { appState } from './core/app-state.js';
import { pacSync } from './core/pac-sync.js';
import { setupAuthListener } from './core/proxy-auth.js';
import { blockInformer } from './core/block-informer.js';
import { errorHandlers } from './core/error-handlers.js';
import { setupContextMenus, createContextMenuItems } from './core/context-menus.js';
import { setupMessageBus } from './core/message-bus.js';
import { logger } from './core/logger.js';

console.log('[Service Worker] Initializing Runet Censorship Bypass (MV3)...');

// 1. Setup messaging, auth listener, context menus, and event listeners synchronously at top level
setupMessageBus();
setupAuthListener();
setupContextMenus();
errorHandlers.setupListeners();
blockInformer.init();

// 2. Capture proxy connection failures strictly for diagnostic logging
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

// 3. Alarms listener for background periodic synchronization (ensuring state is initialized)
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'periodic-pac-update') {
    console.log('[Service Worker Alarm] Triggering periodic PAC update:', new Date().toLocaleString('ru-RU'));
    try {
      await appState.ensureInitialized();
      await pacSync.syncWithPacProvider({ ifUnattended: true });
    } catch (err) {
      console.warn('[Periodic PAC Update Warning]:', err);
    }
  }
});

// 4. Extension Installed / Updated
chrome.runtime.onInstalled.addListener(async (details) => {
  console.log('[Service Worker] onInstalled reason:', details.reason);
  createContextMenuItems();
  try {
    await appState.ensureInitialized();
  } catch (err) {
    console.warn('[Service Worker] onInstalled initialization error:', err);
  }

  if (details.reason === 'install') {
    const consentGiven = await storage.get('ifConsentGiven', false);
    if (!consentGiven) {
      chrome.tabs.create({ url: chrome.runtime.getURL('pages/options/index.html') });
    }
  }
});

// 5. Browser Startup
chrome.runtime.onStartup.addListener(async () => {
  console.log('[Service Worker] onStartup');
  try {
    await appState.ensureInitialized();
  } catch (err) {
    console.warn('[Service Worker] onStartup initialization error:', err);
  }
});

// 6. Asynchronously trigger state rehydration in background for current SW instance
appState.ensureInitialized().catch((err) => {
  console.warn('[Service Worker] Background ensureInitialized warning:', err);
});
