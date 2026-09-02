'use strict';

import { pacSync } from './pac-sync.js';
import { pacKitchen } from './pac-kitchen.js';
import { ipToHost } from './ip-to-host.js';
import { errorHandlers } from './error-handlers.js';
import { logger } from './logger.js';
import { storage } from './storage.js';

/**
 * Global AppState Manager for Manifest V3 Service Worker
 * Guarantees unified, idempotent initialization for every service worker instance
 */
class AppStateManager {
  constructor() {
    this._initPromise = null;
    this.isInitialized = false;
  }

  /**
   * Idempotent initialization promise for the current Service Worker lifecycle instance.
   * Guarantees all subsystems (storage, credentials, pac-sync, logs, error handlers)
   * are fully restored into memory before handling events or messages.
   * @returns {Promise<void>}
   */
  async ensureInitialized() {
    if (this.isInitialized) {
      return;
    }
    if (!this._initPromise) {
      this._initPromise = (async () => {
        try {
          // Protect sensitive local data before any other subsystem reads it.
          await storage.restrictLocalAccess();

          // Initialize independent storage-backed singletons concurrently.
          // (pacKitchen.getPacMods already restores proxyCredentialsMap from customProxyStringRaw)
          const results = await Promise.allSettled([
            logger.init(),
            ipToHost.init(),
            errorHandlers.init(),
            pacKitchen.getPacMods(),
          ]);
          const failedResult = results.find((result) => result.status === 'rejected');
          if (failedResult) {
            throw failedResult.reason;
          }

          // Initialize PAC sync manager with restored storage settings.
          await pacSync.init();

          this.isInitialized = true;
        } catch (err) {
          console.error('[AppState] Service Worker initialization error:', err);
          this.isInitialized = false;
          // A later event may retry after a transient storage/network failure.
          this._initPromise = null;
          throw err;
        }
      })();
    }
    return this._initPromise;
  }

  /**
   * Reset initialization state (useful for tests or full reloads)
   */
  reset() {
    this._initPromise = null;
    this.isInitialized = false;
  }
}

export const appState = new AppStateManager();
