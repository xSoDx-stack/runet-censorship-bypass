'use strict';

import { expect } from 'chai';
import { appState } from '../src/extension-common/core/app-state.js';
import { logger } from '../src/extension-common/core/logger.js';
import { ipToHost } from '../src/extension-common/core/ip-to-host.js';
import { errorHandlers } from '../src/extension-common/core/error-handlers.js';
import { pacKitchen } from '../src/extension-common/core/pac-kitchen.js';
import { pacSync } from '../src/extension-common/core/pac-sync.js';

describe('AppState initialization', () => {
  it('should not retry while operations from a failed initialization may still be running', async () => {
    const originals = {
      loggerInit: logger.init,
      ipToHostInit: ipToHost.init,
      errorHandlersInit: errorHandlers.init,
      getPacMods: pacKitchen.getPacMods,
      pacSyncInit: pacSync.init,
      consoleError: console.error,
    };
    let loggerInitCalls = 0;
    let releaseSlowInitializer;
    const slowInitializer = new Promise((resolve) => {
      releaseSlowInitializer = resolve;
    });

    appState.reset();
    logger.init = async () => {
      loggerInitCalls += 1;
      throw new Error('initialization failed');
    };
    ipToHost.init = () => slowInitializer;
    errorHandlers.init = async () => {};
    pacKitchen.getPacMods = async () => ({});
    pacSync.init = async () => {};
    console.error = () => {};

    try {
      let firstError;
      try {
        await appState.ensureInitialized();
      } catch (err) {
        firstError = err;
      }

      let secondError;
      try {
        await appState.ensureInitialized();
      } catch (err) {
        secondError = err;
      }

      expect(firstError).to.be.an('error').with.property('message', 'initialization failed');
      expect(secondError).to.equal(firstError);
      expect(loggerInitCalls).to.equal(1);
      expect(appState.isInitialized).to.equal(false);
    } finally {
      releaseSlowInitializer();
      logger.init = originals.loggerInit;
      ipToHost.init = originals.ipToHostInit;
      errorHandlers.init = originals.errorHandlersInit;
      pacKitchen.getPacMods = originals.getPacMods;
      pacSync.init = originals.pacSyncInit;
      console.error = originals.consoleError;
      appState.reset();
    }
  });
});
