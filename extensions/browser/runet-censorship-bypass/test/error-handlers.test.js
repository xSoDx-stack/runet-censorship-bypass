'use strict';

import { expect } from 'chai';
import { errorHandlers } from '../src/extension-common/core/error-handlers.js';
import { logger } from '../src/extension-common/core/logger.js';
import { storage } from '../src/extension-common/core/storage.js';

describe('Proxy error flood protection', () => {
  it('throttles identical PAC/proxy errors and their notifications', () => {
    const originalLoggerAdd = logger.add;
    const originalNotify = errorHandlers.notify;
    const originalConsoleWarn = console.warn;
    const capturedLogs = [];
    const capturedNotifications = [];
    logger.add = (entry) => capturedLogs.push(entry);
    errorHandlers.notify = (...args) => capturedNotifications.push(args);
    console.warn = () => {};
    errorHandlers.resetRuntimeState();

    try {
      const details = {
        error: 'net::ERR_PROXY_CONNECTION_FAILED',
        details: '',
        fatal: true,
      };
      errorHandlers.handleProxyError(details);
      errorHandlers.handleProxyError(details);

      expect(errorHandlers.getLastErrors()).to.have.lengthOf(1);
      expect(capturedLogs).to.have.lengthOf(1);
      expect(capturedNotifications).to.have.lengthOf(1);

      errorHandlers.handleProxyError({ ...details, error: 'net::ERR_TUNNEL_CONNECTION_FAILED' });
      expect(errorHandlers.getLastErrors()).to.have.lengthOf(2);
      expect(capturedLogs).to.have.lengthOf(2);
    } finally {
      logger.add = originalLoggerAdd;
      errorHandlers.notify = originalNotify;
      console.warn = originalConsoleWarn;
      errorHandlers.resetRuntimeState();
    }
  });

  it('does not warn while a temporarily cleared proxy setting remains controllable', async () => {
    const originalNotify = errorHandlers.notify;
    const notifications = [];
    errorHandlers.notify = (...args) => notifications.push(args);
    errorHandlers.resetRuntimeState();

    try {
      await errorHandlers.handleControlState({
        isControlled: false,
        isControllable: true,
        expectedControl: true,
        levelOfControl: 'controllable_by_this_extension',
      });

      expect(errorHandlers.getLastErrors()).to.have.lengthOf(0);
      expect(notifications).to.have.lengthOf(0);
    } finally {
      errorHandlers.notify = originalNotify;
      errorHandlers.resetRuntimeState();
    }
  });

  it('persists a real control-loss incident across service-worker restarts', async () => {
    const originalStorageGet = storage.get;
    const originalStorageSet = storage.set;
    const originalNotify = errorHandlers.notify;
    const originalLoggerAdd = logger.add;
    let savedState = null;
    const notifications = [];
    storage.get = async () => savedState;
    storage.set = async (_key, value) => {
      savedState = structuredClone(value);
    };
    errorHandlers.notify = (...args) => notifications.push(args);
    logger.add = () => {};
    errorHandlers.resetRuntimeState();

    const lostControl = {
      isControlled: false,
      isControllable: false,
      expectedControl: true,
      levelOfControl: 'controlled_by_other_extensions',
    };

    try {
      await errorHandlers.init();
      await errorHandlers.handleControlState(lostControl);
      expect(notifications).to.have.lengthOf(1);
      expect(savedState.noControlActive).to.equal(true);

      // Simulate a new MV3 service-worker instance restoring its runtime state.
      errorHandlers.resetRuntimeState();
      await errorHandlers.init();
      await errorHandlers.handleControlState(lostControl);
      expect(notifications).to.have.lengthOf(1);

      await errorHandlers.handleControlState({
        isControlled: true,
        isControllable: true,
        expectedControl: true,
        levelOfControl: 'controlled_by_this_extension',
      });
      expect(savedState.noControlActive).to.equal(false);

      errorHandlers.resetRuntimeState();
      await errorHandlers.init();
      await errorHandlers.handleControlState(lostControl);
      expect(notifications).to.have.lengthOf(2);
    } finally {
      storage.get = originalStorageGet;
      storage.set = originalStorageSet;
      errorHandlers.notify = originalNotify;
      logger.add = originalLoggerAdd;
      errorHandlers.resetRuntimeState();
    }
  });
});
