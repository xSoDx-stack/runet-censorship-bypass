'use strict';

import { storage } from './storage.js';
import { logger, sanitizeLogString } from './logger.js';

const HANDLERS_STATE_KEY = 'handlers-state';
const LAST_ERRORS_MAX = 30;

class ErrorHandlersManager {
  constructor() {
    this.lastErrors = [];
    this.notificationsEnabled = {
      'pac-error': true,
      'ext-error': true,
      'no-control': true,
    };
    this.isInitialized = false;
    this._listenersRegistered = false;
    this._noControlActive = false;
  }

  setupListeners() {
    if (this._listenersRegistered) return;

    // P2.6: Check typeof before calling hasListeners() to prevent TypeError if API shape differs
    if (chrome.proxy && chrome.proxy.onProxyError &&
        (typeof chrome.proxy.onProxyError.hasListeners !== 'function' || !chrome.proxy.onProxyError.hasListeners())) {
      chrome.proxy.onProxyError.addListener((details) => {
        this.handleProxyError(details);
      });
    }

    if (chrome.notifications && chrome.notifications.onClicked &&
        (typeof chrome.notifications.onClicked.hasListeners !== 'function' || !chrome.notifications.onClicked.hasListeners())) {
      chrome.notifications.onClicked.addListener((notId) => {
        chrome.notifications.clear(notId);
      });
    }

    if (typeof self !== 'undefined' && typeof self.addEventListener === 'function') {
      self.addEventListener('error', (event) => {
        this.handleExtensionError(event.error || event.message || 'Неизвестная ошибка');
      });
      self.addEventListener('unhandledrejection', (event) => {
        this.handleExtensionError(event.reason || 'Необработанная ошибка Promise');
      });
    }

    this._listenersRegistered = true;
  }

  async init() {
    this.setupListeners();
    if (this.isInitialized) return;

    const saved = await storage.get(HANDLERS_STATE_KEY, null);
    if (saved && typeof saved === 'object') {
      Object.assign(this.notificationsEnabled, saved);
    }
    this.isInitialized = true;
  }

  handleProxyError(details) {
    console.warn('[Proxy Error]:', details);
    const errItem = {
      type: 'proxy',
      error: details.error || 'Proxy error',
      details: details.details || '',
      fatal: details.fatal || false,
      timestamp: Date.now(),
    };
    this.addError(errItem);

    logger.add({
      level: details.fatal ? 'error' : 'warn',
      category: 'pac',
      title: details.error || 'Ошибка PAC / Proxy',
      message: details.details || 'Браузер сообщил об ошибке в PAC-скрипте или прокси-соединении',
      details,
    });

    if (this.notificationsEnabled['pac-error']) {
      this.notify(
        'pac-error',
        'Ошибка PAC-скрипта / Прокси',
        details.details || details.error || 'Прокси-сервер сообщил об ошибке'
      );
    }
  }

  addError(errObj) {
    this.lastErrors.unshift(errObj);
    if (this.lastErrors.length > LAST_ERRORS_MAX) {
      this.lastErrors.pop();
    }
  }

  notify(id, title, message) {
    if (!chrome.notifications) return;
    let iconName = 'default-128.png';
    if (id === 'pac-error') iconName = 'pac-error-128.png';
    else if (id === 'ext-error') iconName = 'ext-error-128.png';
    else if (id === 'no-control') iconName = 'no-control-128.png';

    chrome.notifications.create(id, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL(`icons/${iconName}`),
      title,
      message: String(message),
      priority: 1,
    }, () => {
      if (chrome.runtime.lastError) { /* ignore */ }
    });
  }

  async setNotificationOption(key, enabled) {
    this.notificationsEnabled[key] = Boolean(enabled);
    await storage.set(HANDLERS_STATE_KEY, this.notificationsEnabled);
  }

  handleExtensionError(error) {
    const rawMessage = error && error.message ? error.message : String(error || 'Неизвестная ошибка');
    const message = sanitizeLogString(rawMessage);
    this.addError({
      type: 'extension',
      error: message,
      timestamp: Date.now(),
    });
    logger.error('system', 'Непредвиденная ошибка расширения', message);
    if (this.notificationsEnabled['ext-error']) {
      this.notify('ext-error', 'Ошибка расширения', message);
    }
  }

  handleControlState(isControlled, expectedControl) {
    if (isControlled || !expectedControl) {
      this._noControlActive = false;
      return;
    }
    if (this._noControlActive) return;
    this._noControlActive = true;

    const message = 'Настройки прокси контролируются браузером, политикой или другим расширением.';
    this.addError({
      type: 'no-control',
      error: message,
      timestamp: Date.now(),
    });
    logger.warn('system', 'Утерян контроль настроек прокси', message);
    if (this.notificationsEnabled['no-control']) {
      this.notify('no-control', 'Утерян контроль прокси', message);
    }
  }

  resetRuntimeState() {
    this.lastErrors = [];
    this.notificationsEnabled = {
      'pac-error': true,
      'ext-error': true,
      'no-control': true,
    };
    this._noControlActive = false;
    this.isInitialized = false;
  }

  getLastErrors() {
    return this.lastErrors;
  }
}

export const errorHandlers = new ErrorHandlersManager();
