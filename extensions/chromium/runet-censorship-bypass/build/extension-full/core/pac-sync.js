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

export const PAC_PROVIDERS = {
  Антизапрет: {
    distinctKey: 'Antizapret',
    label: chrome.i18n.getMessage('Antizapret') || 'Антизапрет',
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
    label: chrome.i18n.getMessage('Anticensority') || 'Антицензорити',
    desc: 'Альтернативный PAC-скрипт от авторов расширения с расширенной базой и защитой от провайдерских блокировок по IP.',
    order: 1,
    pacUrls: [
      'https://anticensority.github.io/generated-pac-scripts/anticensority.pac',
      'https://raw.githubusercontent.com/anticensority/generated-pac-scripts/master/anticensority.pac',
    ],
  },
  onlyOwnSites: {
    distinctKey: 'onlyOwnSites',
    label: chrome.i18n.getMessage('Only_own_sites_and_only_own_proxies') || 'Только свои сайты (Tor / Свои прокси)',
    desc: 'Проксируются только вручную добавленные сайты через ваши прокси или локальный Tor.',
    order: 2,
    pacUrls: [
      'data:application/x-ns-proxy-autoconfig,' + encodeURIComponent('function FindProxyForURL(url, host){ return "DIRECT"; }'),
    ],
  },
};

class PacSyncManager {
  constructor() {
    this.currentPacProviderKey = 'Антизапрет';
    this.lastPacUpdateStamp = 0;
    this.providerUpdateStamps = {};
    this.rawPacData = '';
    this.cookedPacData = '';
    this.lastError = null;
    this.isSyncing = false;
    this.isControlled = false;
    this.isControllable = false;
    this.isInitialized = false;
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
      if (chrome.runtime.lastError) { /* ignore */ }
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
      title = `PAC обновлён: ${upDate} | ${this.currentPacProviderKey || 'Отключено'}`;
    }
    chrome.action.setTitle({ title }, () => {
      if (chrome.runtime.lastError) { /* ignore */ }
    });
  }

  async persistState() {
    await storage.set(STORAGE_KEY, {
      currentPacProviderKey: this.currentPacProviderKey,
      lastPacUpdateStamp: this.lastPacUpdateStamp,
      providerUpdateStamps: this.providerUpdateStamps,
      rawPacData: this.rawPacData,
    });
    this.updateTitle();
  }

  async downloadPacFromProvider(provider) {
    if (!provider || !provider.pacUrls || !provider.pacUrls.length) {
      throw new Error('У провайдера нет доступных адресов PAC-скрипта');
    }

    let lastErr = null;
    for (const url of provider.pacUrls) {
      if (url.startsWith('data:')) {
        const decoded = decodeURIComponent(url.replace('data:application/x-ns-proxy-autoconfig,', ''));
        return decoded;
      }
      try {
        const text = await httpLib.get(url, { timeoutMs: 12000 });
        if (text && text.includes('FindProxyForURL')) {
          return text;
        }
      } catch (err) {
        lastErr = err;
        console.warn(`Failed to fetch PAC from ${url}:`, err);
      }
    }

    throw clarify(
      lastErr || new Error('Все адреса недоступны'),
      `Не удалось загрузить PAC-скрипт с адресов: ${provider.pacUrls.join(', ')}`
    );
  }

  async applyPacData(pacRawData) {
    const pacMods = await pacKitchen.getPacMods();
    const cooked = pacKitchen.cook(pacRawData, pacMods);
    this.cookedPacData = cooked;

    return new Promise((resolve, reject) => {
      const config = {
        mode: 'pac_script',
        pacScript: {
          data: cooked,
          mandatory: false,
        },
      };

      chrome.proxy.settings.set(
        { value: config, scope: 'regular' },
        async () => {
          if (chrome.runtime.lastError) {
            return reject(new Error(chrome.runtime.lastError.message));
          }
          await this.updateControlState();
          resolve();
        }
      );
    });
  }

  async syncWithPacProvider({ key = this.currentPacProviderKey, ifUnattended = false } = {}) {
    if (this.isSyncing) {
      console.log('PAC sync already in progress, skipping...');
      return;
    }

    if (key === 'none' || !key) {
      await this.clearPac();
      return;
    }

    const provider = PAC_PROVIDERS[key];
    if (!provider) {
      throw new Error(`Неизвестный провайдер PAC: ${key}`);
    }

    this.isSyncing = true;
    this.lastError = null;

    try {
      console.log(`[PAC Sync] Downloading PAC for provider "${key}"...`);
      const pacData = await this.downloadPacFromProvider(provider);
      this.rawPacData = pacData;
      this.currentPacProviderKey = key;

      console.log('[PAC Sync] Cooking and applying PAC script...');
      await this.applyPacData(pacData);

      const now = Date.now();
      this.lastPacUpdateStamp = now;
      this.providerUpdateStamps[key] = now;
      await this.persistState();

      console.log('[PAC Sync] Successfully updated PAC!');
      logger.info('pac', `PAC-скрипт "${key}" успешно обновлён`, `Размер PAC: ${(pacData.length / 1024).toFixed(1)} КБ`, {
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
    } finally {
      this.isSyncing = false;
    }
  }

  async installPac(key) {
    this.currentPacProviderKey = key;
    await this.syncWithPacProvider({ key, ifUnattended: false });
  }

  async clearPac() {
    this.currentPacProviderKey = 'none';
    this.rawPacData = '';
    this.cookedPacData = '';

    return new Promise((resolve, reject) => {
      chrome.proxy.settings.clear({ scope: 'regular' }, async () => {
        if (chrome.runtime.lastError) {
          return reject(new Error(chrome.runtime.lastError.message));
        }
        await this.persistState();
        await this.updateControlState();
        resolve();
      });
    });
  }

  async reapplyCurrentPac() {
    if (this.currentPacProviderKey === 'none' || !this.currentPacProviderKey) {
      return;
    }
    if (this.rawPacData) {
      await this.applyPacData(this.rawPacData);
    } else {
      await this.syncWithPacProvider({ key: this.currentPacProviderKey, ifUnattended: true });
    }
  }

  getState() {
    return {
      currentPacProviderKey: this.currentPacProviderKey,
      lastPacUpdateStamp: this.lastPacUpdateStamp,
      providerUpdateStamps: this.providerUpdateStamps,
      isSyncing: this.isSyncing,
      isControlled: this.isControlled,
      isControllable: this.isControllable,
      lastError: this.lastError ? this.lastError.message : null,
      providers: PAC_PROVIDERS,
      rawPacData: this.rawPacData,
    };
  }
}

export const pacSync = new PacSyncManager();
