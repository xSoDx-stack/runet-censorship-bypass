'use strict';

import { storage } from './storage.js';
import { logger } from './logger.js';

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

  getLastErrors() {
    return this.lastErrors;
  }
}

export const errorHandlers = new ErrorHandlersManager();
