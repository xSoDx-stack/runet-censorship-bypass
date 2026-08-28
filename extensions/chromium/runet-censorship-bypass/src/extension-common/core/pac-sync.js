'use strict';

import { storage } from './storage.js';
import { httpLib } from './http-lib.js';
import { pacKitchen } from './pac-kitchen.js';
import { ipToHost } from './ip-to-host.js';
import { utils } from './utils.js';
import { clarify, formatErrorMessage } from './errors-lib.js';
import { logger } from './logger.js';

const STORAGE_KEY = 'antiCensorRu';
const ALARM_NAME = 'periodic-pac-update';

const getI18nMsg = (key, fallback) => {
  if (typeof chrome !== 'undefined' && chrome.i18n && typeof chrome.i18n.getMessage === 'function') {
    return chrome.i18n.getMessage(key) || fallback;
  }
  return fallback;
};

export const PAC_PROVIDERS = {
  Антизапрет: {
    distinctKey: 'Antizapret',
    label: getI18nMsg('Antizapret', 'Антизапрет'),
    desc: 'Основной PAC-скрипт от авторов проекта «Антизапрет». Блокировка определяется по реестровым доменам и IP-адресам.',
    order: 0,
    pacUrls: [
      'https://e.cen.rodeo:8443/proxy.pac',
      'https://antizapret.prostovpn.org:8443/proxy.pac',
      'https://antizapret.prostovpn.org:18443/proxy.pac',
      'https://antizapret.prostovpn.org/proxy.pac',
    ],
  },
  Антицензорити: {
    distinctKey: 'Anticensority',
    label: getI18nMsg('Anticensority', 'Антицензорити'),
    desc: 'Альтернативный PAC-скрипт от авторов расширения с расширенной базой и защитой от провайдерских блокировок по IP.',
    order: 1,
    pacUrls: [
      'https://anticensority.github.io/generated-pac-scripts/anticensority.pac',
      'https://raw.githubusercontent.com/anticensority/generated-pac-scripts/master/anticensority.pac',
    ],
  },
  onlyOwnSites: {
    distinctKey: 'onlyOwnSites',
    label: getI18nMsg('Only_own_sites_and_only_own_proxies', 'Только свои сайты (Tor / Свои прокси)'),
    desc: 'Проксируются только вручную добавленные сайты через ваши прокси или локальный Tor.',
    order: 2,
    pacUrls: [
      'data:application/x-ns-proxy-autoconfig,' + encodeURIComponent('function FindProxyForURL(url, host){ return "DIRECT"; }'),
    ],
  },
  customPacUrl: {
    distinctKey: 'customPacUrl',
    label: getI18nMsg('Custom_pac_url', 'Свой PAC (по ссылке)'),
    desc: 'Готовый PAC-скрипт по собственной прямой ссылке (HTTPS или HTTP).',
    order: 3,
    pacUrls: [],
  },
};

class PacSyncManager {
  constructor() {
    this.currentPacProviderKey = 'Антизапрет';
    this.customPacUrl = '';
    this.lastPacUpdateStamp = 0;
    this.providerUpdateStamps = {};
    this.rawPacData = '';
    this.cookedPacData = '';
    this.lastError = null;
    this.isSyncing = false;
    this.isControlled = false;
    this.isControllable = false;
    this.isInitialized = false;
    this.revision = 0;

    // Pending sync queue mechanism (Task 1)
    this._isSyncRunning = false;
    this._currentSyncPromise = null;
    this._currentRunningOptions = null;
    this._pendingSync = null;
  }

  resetRuntimeState() {
    this.currentPacProviderKey = 'Антизапрет';
    this.customPacUrl = '';
    this.lastPacUpdateStamp = 0;
    this.providerUpdateStamps = {};
    this.rawPacData = '';
    this.cookedPacData = '';
    this.lastError = null;
    this.revision++;
    this._isSyncRunning = false;
    this.isSyncing = false;
    this._currentSyncPromise = null;
    this._currentRunningOptions = null;
    this._pendingSync = null;
    this.updateTitle();
  }

  async init() {
    if (this.isInitialized) {
      return;
    }
    const saved = await storage.get(STORAGE_KEY, {});
    if (saved && typeof saved === 'object') {
      if (saved.currentPacProviderKey !== undefined) {
        this.currentPacProviderKey = saved.currentPacProviderKey;
      }
      if (saved.customPacUrl !== undefined) {
        this.customPacUrl = saved.customPacUrl;
      }
      if (saved.lastPacUpdateStamp) {
        this.lastPacUpdateStamp = saved.lastPacUpdateStamp;
      }
      if (saved.providerUpdateStamps) {
        this.providerUpdateStamps = saved.providerUpdateStamps;
      }
      if (saved.rawPacData) {
        this.rawPacData = saved.rawPacData;
      }
    }

    this.isInitialized = true;
    await this.updateControlState();
    this.setupAlarms();
    this.updateTitle();

    if (this.currentPacProviderKey && this.currentPacProviderKey !== 'none' && !this.rawPacData) {
      await this.syncWithPacProvider({ ifUnattended: true });
    }
  }

  setupAlarms() {
    if (!chrome.alarms) return;
    chrome.alarms.get(ALARM_NAME, (existingAlarm) => {
      if (chrome.runtime.lastError) {
        // P1.8: Log alarm check errors rather than silently swallowing them
        console.warn('[PacSync] Alarm check error:', chrome.runtime.lastError);
        return;
      }
      if (!existingAlarm) {
        chrome.alarms.create(ALARM_NAME, {
          periodInMinutes: 240, // every 4 hours
        });
      }
    });
  }

  async updateControlState() {
    return new Promise((resolve) => {
      chrome.proxy.settings.get({}, (details) => {
        if (chrome.runtime.lastError) {
          console.warn('proxy.settings.get error:', chrome.runtime.lastError);
          resolve(false);
          return;
        }

        this.isControllable = utils.areSettingsControllableFor(details);
        this.isControlled = utils.areSettingsControlledFor(details);

        const iconPath = this.isControlled
          ? {
              16: 'icons/default-16.png',
              32: 'icons/default-32.png',
              48: 'icons/default-48.png',
              128: 'icons/default-128.png',
            }
          : {
              16: 'icons/default-grayscale-16.png',
              32: 'icons/default-grayscale-32.png',
              48: 'icons/default-grayscale-48.png',
              128: 'icons/default-grayscale-128.png',
            };

        chrome.action.setIcon({ path: iconPath }, () => {
          if (chrome.runtime.lastError) { /* ignore */ }
        });

        resolve(this.isControlled);
      });
    });
  }

  updateTitle() {
    let title = 'Обход блокировок Рунета';
    if (this.lastPacUpdateStamp) {
      const upDate = new Date(this.lastPacUpdateStamp).toLocaleString('ru-RU', {
        day: 'numeric',
        month: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
      // P2.10: use i18n for provider label instead of hardcoded Russian string
      const customPacLabel = getI18nMsg('Custom_pac_url', 'Свой PAC');
      const provName = this.currentPacProviderKey === 'customPacUrl'
        ? customPacLabel
        : (this.currentPacProviderKey || 'Отключено');
      title = `PAC обновлён: ${upDate} | ${provName}`;
    }
    chrome.action.setTitle({ title }, () => {
      if (chrome.runtime.lastError) { /* ignore */ }
    });
  }

  async persistState() {
    await storage.set(STORAGE_KEY, {
      currentPacProviderKey: this.currentPacProviderKey,
      customPacUrl: this.customPacUrl,
      lastPacUpdateStamp: this.lastPacUpdateStamp,
      providerUpdateStamps: this.providerUpdateStamps,
      rawPacData: this.rawPacData,
    });
    this.updateTitle();
  }

  async downloadPacFromProvider(provider, customUrlCandidate = null) {
    if (!provider) {
      throw new Error('У провайдера нет доступных адресов PAC-скрипта');
    }

    let urls = provider.pacUrls || [];
    if (provider.distinctKey === 'customPacUrl') {
      const targetUrl = customUrlCandidate || this.customPacUrl;
      const validation = utils.validatePacUrl(targetUrl);
      if (!validation.valid) {
        throw new Error(validation.error || 'Не указан корректный URL для своего PAC-скрипта');
      }
      urls = [validation.sanitizedUrl];
    }

    if (!urls.length) {
      throw new Error('У провайдера нет доступных адресов PAC-скрипта');
    }

    let lastErr = null;
    for (const url of urls) {
      if (url.startsWith('data:')) {
        const decoded = decodeURIComponent(url.replace('data:application/x-ns-proxy-autoconfig,', ''));
        return decoded;
      }
      try {
        const text = await httpLib.get(url, { timeoutMs: 12000 });
        if (text && text.trim().length > 0) {
          if (text.includes('FindProxyForURL')) {
            return text;
          }
          throw new Error('Ответ не содержит функцию FindProxyForURL');
        }
        throw new Error('Сервер вернул пустой PAC-скрипт');
      } catch (err) {
        lastErr = err;
        console.warn(`Failed to fetch PAC from ${url}:`, err);
      }
    }

    throw clarify(
      lastErr || new Error('Все адреса недоступны'),
      `Не удалось загрузить PAC-скрипт с адресов: ${urls.join(', ')}`
    );
  }

  async applyPacData(candidateRawData) {
    const pacMods = await pacKitchen.getPacMods();
    const candidateCooked = pacKitchen.cook(candidateRawData, pacMods);

    const isProxyOrDie = pacMods && pacMods.ifProxyOrDie !== false;

    await new Promise((resolve, reject) => {
      const config = {
        mode: 'pac_script',
        pacScript: {
          data: candidateCooked,
          mandatory: Boolean(isProxyOrDie),
        },
      };

      chrome.proxy.settings.set(
        { value: config, scope: 'regular' },
        () => {
          if (chrome.runtime.lastError) {
            return reject(new Error(chrome.runtime.lastError.message));
          }
          resolve();
        }
      );
    });

    // Transaction Commit on success
    this.revision++;
    this.rawPacData = candidateRawData;
    this.cookedPacData = candidateCooked;
    try {
      ipToHost.updateFromPac(candidateRawData);
      await ipToHost.persistData();
    } catch {
      // Non-critical
    }
    await this.updateControlState();
  }

  getProxyTitle() {
    if (this.currentPacProviderKey === 'Антизапрет') {
      return 'proxy.antizapret.prostovpn.org:8443';
    }
    if (this.currentPacProviderKey === 'Антицензорити') {
      return 'Anticensority Proxy';
    }
    if (this.currentPacProviderKey === 'customPacUrl') {
      if (this.customPacUrl) {
        try {
          const parsed = new URL(this.customPacUrl);
          return `Свой PAC (${parsed.hostname})`;
        } catch {
          return 'Свой PAC';
        }
      }
      return 'Свой PAC';
    }
    const provider = PAC_PROVIDERS[this.currentPacProviderKey];
    return provider ? provider.label : (this.currentPacProviderKey || 'Proxy');
  }

  isDomainInPac(hostname) {
    if (!hostname || !this.rawPacData) return false;
    const h = String(hostname).toLowerCase().trim();
    if (!h) return false;

    if (this.rawPacData.includes(`"${h}"`) || this.rawPacData.includes(`'${h}'`)) {
      return true;
    }

    const parts = h.split('.');
    for (let i = 1; i < parts.length - 1; i++) {
      const parent = parts.slice(i).join('.');
      if (this.rawPacData.includes(`"${parent}"`) || this.rawPacData.includes(`'${parent}'`)) {
        return true;
      }
    }

    return false;
  }

  _isSameSyncRequest(optA, optB) {
    if (!optA || !optB) return false;
    return (
      (optA.key || '') === (optB.key || '') &&
      (optA.customUrl || '') === (optB.customUrl || '') &&
      Boolean(optA.ifUnattended) === Boolean(optB.ifUnattended)
    );
  }

  async syncWithPacProvider(options = {}) {
    const opts = typeof options === 'string' ? { key: options } : (options || {});
    const key = opts.key || this.currentPacProviderKey;
    const customUrl = opts.customUrl || null;
    const ifUnattended = Boolean(opts.ifUnattended);
    const requestOptions = { key, customUrl, ifUnattended };

    // If no sync is currently in-flight, start the execution loop immediately
    if (!this._isSyncRunning) {
      this._isSyncRunning = true;
      this.isSyncing = true;
      this._currentSyncPromise = this._runSyncLoop(requestOptions);
      try {
        return await this._currentSyncPromise;
      } finally {
        this._isSyncRunning = false;
        this.isSyncing = false;
        this._currentSyncPromise = null;
        this._currentRunningOptions = null;
      }
    }

    // A sync is currently in progress.
    // If this request is identical to the current running request AND there is no pending request yet, await it.
    if (!this._pendingSync && this._isSameSyncRequest(this._currentRunningOptions, requestOptions)) {
      return this._currentSyncPromise;
    }

    // Otherwise, enqueue as the latest desired pending request (replaces any older pending request)
    return new Promise((resolve, reject) => {
      if (this._pendingSync) {
        if (this._isSameSyncRequest(this._pendingSync.options, requestOptions)) {
          this._pendingSync.deferreds.push({ resolve, reject });
          return;
        }
        // Update to the newer desired request and attach deferreds
        this._pendingSync.options = requestOptions;
        this._pendingSync.deferreds.push({ resolve, reject });
      } else {
        this._pendingSync = {
          options: requestOptions,
          deferreds: [{ resolve, reject }],
        };
      }
    });
  }

  async _runSyncLoop(initialOptions) {
    let nextOptions = initialOptions;
    let initialCallerError = null;
    let pendingDeferredsToResolve = [];

    while (nextOptions) {
      this._currentRunningOptions = nextOptions;

      if (this._pendingSync && this._isSameSyncRequest(this._pendingSync.options, nextOptions)) {
        pendingDeferredsToResolve.push(...this._pendingSync.deferreds);
        this._pendingSync = null;
      }

      let stepError = null;
      try {
        await this._performSync(nextOptions);
        for (const d of pendingDeferredsToResolve) {
          d.resolve();
        }
      } catch (err) {
        stepError = err;
        for (const d of pendingDeferredsToResolve) {
          d.reject(err);
        }
      }
      pendingDeferredsToResolve = [];

      if (nextOptions === initialOptions) {
        initialCallerError = stepError;
      }

      // Check if another pending request arrived while executing this step
      if (this._pendingSync) {
        const pending = this._pendingSync;
        this._pendingSync = null;
        nextOptions = pending.options;
        pendingDeferredsToResolve = pending.deferreds;
      } else {
        nextOptions = null;
      }
    }

    if (initialCallerError && !initialOptions.ifUnattended) {
      throw initialCallerError;
    }
  }

  async _performSync({ key = this.currentPacProviderKey, customUrl = null, ifUnattended = false } = {}) {
    if (key === 'none' || !key) {
      await this.clearPac();
      return;
    }

    const provider = PAC_PROVIDERS[key];
    if (!provider) {
      throw new Error(`Неизвестный провайдер PAC: ${key}`);
    }

    this.lastError = null;

    try {
      console.log(`[PAC Sync] Downloading PAC for provider "${key}"...`);
      const candidateRaw = await this.downloadPacFromProvider(provider, customUrl);

      console.log('[PAC Sync] Cooking and applying PAC script...');
      await this.applyPacData(candidateRaw);

      this.currentPacProviderKey = key;
      if (key === 'customPacUrl' && customUrl) {
        this.customPacUrl = customUrl.trim();
      }

      const now = Date.now();
      this.lastPacUpdateStamp = now;
      this.providerUpdateStamps[key] = now;
      await this.persistState();

      console.log('[PAC Sync] Successfully updated PAC!');
      logger.info('pac', `PAC-скрипт "${key}" успешно обновлён`, `Размер PAC: ${(candidateRaw.length / 1024).toFixed(1)} КБ`, {
        provider: key,
        lastPacUpdateStamp: now,
      });
    } catch (err) {
      this.lastError = err;
      const errorMsg = formatErrorMessage(err) || err.message || String(err);
      console.warn(`[PAC Sync Warning for "${key}"]:`, errorMsg);
      logger.error('pac', `Ошибка синхронизации PAC "${key}"`, errorMsg, {
        provider: key,
        ifUnattended,
        error: errorMsg,
      });
      if (!ifUnattended) {
        throw new Error(errorMsg);
      }
    }
  }

  async installPac(key, customUrl = null) {
    await this.syncWithPacProvider({ key, customUrl, ifUnattended: false });
  }

  async clearPac({ persist = true } = {}) {
    await new Promise((resolve, reject) => {
      chrome.proxy.settings.clear({ scope: 'regular' }, () => {
        if (chrome.runtime.lastError) {
          return reject(new Error(chrome.runtime.lastError.message));
        }
        resolve();
      });
    });

    // Transaction Commit on success
    this.revision++;
    this.currentPacProviderKey = 'none';
    this.rawPacData = '';
    this.cookedPacData = '';
    if (persist) {
      await this.persistState();
    }
    await this.updateControlState();
  }

  async reapplyCurrentPac() {
    this.revision++;
    if (this.currentPacProviderKey === 'none' || !this.currentPacProviderKey) {
      return new Promise((resolve) => {
        chrome.proxy.settings.clear({ scope: 'regular' }, async () => {
          await this.updateControlState();
          resolve();
        });
      });
    }
    if (this.rawPacData) {
      await this.applyPacData(this.rawPacData);
    } else {
      await this.syncWithPacProvider({ key: this.currentPacProviderKey, ifUnattended: true });
    }
  }

  getRevision() {
    return this.revision;
  }

  getPacData() {
    return {
      rawPacData: this.rawPacData,
      cookedPacData: this.cookedPacData,
      currentProvider: this.currentPacProviderKey,
    };
  }

  getState() {
    return {
      currentPacProviderKey: this.currentPacProviderKey,
      customPacUrl: this.customPacUrl,
      lastPacUpdateStamp: this.lastPacUpdateStamp,
      providerUpdateStamps: this.providerUpdateStamps,
      isSyncing: this.isSyncing,
      isControlled: this.isControlled,
      isControllable: this.isControllable,
      lastError: this.lastError ? this.lastError.message : null,
      providers: PAC_PROVIDERS,
      hasPacData: Boolean(this.rawPacData),
      revision: this.revision,
    };
  }
}

export const pacSync = new PacSyncManager();
