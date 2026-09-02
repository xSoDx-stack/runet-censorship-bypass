'use strict';

import { storage } from './storage.js';
import { logger, sanitizeLogData, sanitizeLogString } from './logger.js';

const HANDLERS_STATE_KEY = 'handlers-state';
const LAST_ERRORS_MAX = 30;
const PROXY_ERROR_THROTTLE_MS = 5000;
const NOTIFICATION_KEYS = ['pac-error', 'ext-error', 'no-control'];
const HARD_PROXY_CONTROL_LEVELS = new Set([
  'controlled_by_other_extensions',
  'not_controllable',
]);

export function isHardProxyControlConflict({
  isControlled = false,
  isControllable = false,
  expectedControl = false,
  levelOfControl = 'unknown',
} = {}) {
  return expectedControl &&
    !isControlled &&
    !isControllable &&
    HARD_PROXY_CONTROL_LEVELS.has(levelOfControl);
}

function getControlLossMessage(levelOfControl) {
  if (levelOfControl === 'controlled_by_other_extensions') {
    return 'Настройки прокси перехвачены другим расширением с более высоким приоритетом.';
  }
  if (levelOfControl === 'not_controllable') {
    return 'Настройки прокси заблокированы политикой или параметрами браузера.';
  }
  return 'Расширение не может управлять настройками прокси.';
}

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
    this._lastProxyErrorSignature = '';
    this._lastProxyErrorAt = 0;
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
      const savedNotifications = saved.notificationsEnabled &&
        typeof saved.notificationsEnabled === 'object'
        ? saved.notificationsEnabled
        : saved;
      for (const key of NOTIFICATION_KEYS) {
        if (typeof savedNotifications[key] === 'boolean') {
          this.notificationsEnabled[key] = savedNotifications[key];
        }
      }
      this._noControlActive = saved.noControlActive === true;
    }
    this.isInitialized = true;
  }

  async _persistState() {
    await storage.set(HANDLERS_STATE_KEY, {
      notificationsEnabled: { ...this.notificationsEnabled },
      noControlActive: this._noControlActive,
    });
  }

  handleProxyError(details) {
    const safeDetails = sanitizeLogData(details || {});
    const signature = JSON.stringify([
      safeDetails.error || '',
      safeDetails.details || '',
      Boolean(safeDetails.fatal),
    ]);
    const now = Date.now();
    if (signature === this._lastProxyErrorSignature &&
        now - this._lastProxyErrorAt < PROXY_ERROR_THROTTLE_MS) {
      return;
    }
    this._lastProxyErrorSignature = signature;
    this._lastProxyErrorAt = now;

    console.warn('[Proxy Error]:', safeDetails);
    const errItem = {
      type: 'proxy',
      error: safeDetails.error || 'Proxy error',
      details: safeDetails.details || '',
      fatal: safeDetails.fatal || false,
      timestamp: now,
    };
    this.addError(errItem);

    logger.add({
      level: safeDetails.fatal ? 'error' : 'warn',
      category: 'pac',
      title: safeDetails.error || 'Ошибка PAC / Proxy',
      message: safeDetails.details || 'Браузер сообщил об ошибке в PAC-скрипте или прокси-соединении',
      details: safeDetails,
    });

    if (this.notificationsEnabled['pac-error']) {
      this.notify(
        'pac-error',
        'Ошибка PAC-скрипта / Прокси',
        safeDetails.details || safeDetails.error || 'Прокси-сервер сообщил об ошибке'
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
    await this._persistState();
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

  async handleControlState({
    isControlled = false,
    isControllable = false,
    expectedControl = false,
    levelOfControl = 'unknown',
  } = {}) {
    const hasHardConflict = isHardProxyControlConflict({
      isControlled,
      isControllable,
      expectedControl,
      levelOfControl,
    });

    if (!hasHardConflict) {
      if (this._noControlActive) {
        this._noControlActive = false;
        try {
          await this._persistState();
        } catch (err) {
          console.warn('[Error Handlers] Failed to persist restored proxy control:', err);
        }
        if (chrome.notifications?.clear) {
          chrome.notifications.clear('no-control', () => {
            if (chrome.runtime.lastError) { /* ignore */ }
          });
        }
      }
      return;
    }
    if (this._noControlActive) return;
    this._noControlActive = true;

    try {
      await this._persistState();
    } catch (err) {
      console.warn('[Error Handlers] Failed to persist lost proxy control:', err);
    }

    const message = getControlLossMessage(levelOfControl);
    this.addError({
      type: 'no-control',
      error: message,
      timestamp: Date.now(),
    });
    logger.add({
      level: 'warn',
      category: 'system',
      title: 'Утерян контроль настроек прокси',
      message,
      details: { levelOfControl },
    });
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
    this._lastProxyErrorSignature = '';
    this._lastProxyErrorAt = 0;
    this.isInitialized = false;
  }

  getLastErrors() {
    return this.lastErrors;
  }
}

export const errorHandlers = new ErrorHandlersManager();
