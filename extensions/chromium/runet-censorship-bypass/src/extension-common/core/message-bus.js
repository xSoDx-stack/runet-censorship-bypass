'use strict';

import { appState } from './app-state.js';
import { pacSync, PAC_PROVIDERS } from './pac-sync.js';
import { pacKitchen, getDefaultConfigs, matchExceptionDomain } from './pac-kitchen.js';
import { errorHandlers } from './error-handlers.js';
import { storage } from './storage.js';
import { httpLib } from './http-lib.js';
import { checkProxyHealth } from './proxy-checker.js';
import {
  loadProxyHealthCache,
  pruneProxyHealthCache,
  saveProxyHealthResult,
} from './proxy-health-cache.js';
import {
  checkLocalProxyService,
  getLocalProxyService,
} from './local-proxy-services.js';
import { logger } from './logger.js';
import { formatErrorMessage } from './errors-lib.js';
import { ipToHost } from './ip-to-host.js';
import { clearProxyAuthAttempts, resetProxyCredentialsState } from './proxy-auth.js';
import { utils } from './utils.js';

const FALLBACK_CONNECTION_TEST_URL = PAC_PROVIDERS['Антизапрет'].pacUrls[0];

export function getRequestedCurrentHost(message = {}) {
  const candidate = typeof message.currentDomain === 'string'
    ? message.currentDomain
    : message.currentHost;
  return typeof candidate === 'string' ? candidate.trim().toLowerCase() : '';
}

export function getConnectionTestUrl(syncState = {}) {
  const providerKey = syncState.currentPacProviderKey || 'Антизапрет';
  if (providerKey === 'customPacUrl' && syncState.customPacUrl) {
    return syncState.customPacUrl;
  }

  const provider = PAC_PROVIDERS[providerKey] || PAC_PROVIDERS['Антизапрет'];
  const providerUrl = provider.pacUrls && provider.pacUrls[0];
  return providerUrl && !providerUrl.startsWith('data:')
    ? providerUrl
    : FALLBACK_CONNECTION_TEST_URL;
}

export function serializePacMods(pacMods = {}, includeExceptions = false) {
  const serialized = {
    ifProxyHttpsUrlsOnly: Boolean(pacMods.ifProxyHttpsUrlsOnly),
    ifUseSecureProxiesOnly: Boolean(pacMods.ifUseSecureProxiesOnly),
    ifProhibitDns: Boolean(pacMods.ifProhibitDns),
    ifProxyOrDie: pacMods.ifProxyOrDie !== false,
    ifUsePacScriptProxies: pacMods.ifUsePacScriptProxies !== false,
    ifUseLocalTor: Boolean(pacMods.ifUseLocalTor),
    ifUseLocalWarp: Boolean(pacMods.ifUseLocalWarp),
    ifMindExceptions: pacMods.ifMindExceptions !== false,
    ifMindWhitelist: Boolean(pacMods.ifMindWhitelist),
    ifUseOwnProxiesOnlyForOwnSites: Boolean(pacMods.ifUseOwnProxiesOnlyForOwnSites),
    customProxyStringRaw: pacMods.customProxyStringRaw || '',
    ifProxyMoreDomains: Boolean(pacMods.ifProxyMoreDomains),
    replaceDirectWith: pacMods.replaceDirectWith || '',
  };
  if (includeExceptions) {
    serialized.exceptions = Object.assign({}, pacMods.exceptions || {});
    serialized.whitelist = [...(pacMods.whitelist || [])];
  }
  return serialized;
}

export function setupMessageBus() {
  if (chrome.runtime.onMessage.hasListeners && chrome.runtime.onMessage.hasListeners()) {
    return;
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender && sender.id && chrome.runtime?.id && sender.id !== chrome.runtime.id) {
      return false;
    }
    if (sender && sender.url && !sender.url.startsWith(chrome.runtime.getURL(''))) {
      return false;
    }

    if (!message || !message.action) {
      return false;
    }

    const handleMessage = async () => {
      await appState.ensureInitialized();

      switch (message.action) {
        case 'GET_STATE': {
          const syncState = pacSync.getState();
          const pacMods = await pacKitchen.getPacMods();
          const proxyList = utils.parseCustomProxies(pacMods.customProxyStringRaw || '')
            .map((proxy) => proxy.raw);
          const proxyHealthMap = await loadProxyHealthCache(proxyList).catch((err) => {
            console.warn('[Proxy Health] Failed to load cached results:', err);
            return {};
          });
          const configs = getDefaultConfigs();
          const defaultConfigs = {};
          for (const k in configs) {
            defaultConfigs[k] = configs[k].dflt;
          }
          const exceptionStats = pacKitchen.getCachedStats();

          let currentSiteMatch = null;
          const currentHost = getRequestedCurrentHost(message);
          if (currentHost) {
            currentSiteMatch = matchExceptionDomain(currentHost, pacMods.exceptions);
          }

          return {
            success: true,
            data: {
              syncState,
              pacMods: serializePacMods(pacMods, Boolean(message.includeExceptions)),
              defaultConfigs,
              notifications: errorHandlers.notificationsEnabled,
              lastErrors: errorHandlers.getLastErrors(),
              version: chrome.runtime.getManifest().version,
              exceptionStats,
              currentSiteMatch,
              proxyHealthMap,
            },
          };
        }

        case 'GET_EXCEPTIONS': {
          const pacMods = await pacKitchen.getPacMods();
          return {
            success: true,
            data: {
              exceptions: pacMods.exceptions || {},
              whitelist: pacMods.whitelist || [],
            },
          };
        }

        case 'SET_SINGLE_EXCEPTION': {
          let updatedExceptions = {};
          await pacKitchen.updatePacMods((current) => {
            const exceptions = Object.assign({}, current.exceptions || {});
            if (message.isProxy === null || message.isProxy === undefined) {
              delete exceptions[message.domain];
            } else {
              exceptions[message.domain] = Boolean(message.isProxy);
            }
            updatedExceptions = exceptions;
            return Object.assign({}, current, { exceptions });
          });
          await pacSync.reapplyCurrentPac();
          const exceptionStats = pacKitchen.getCachedStats();
          const currentSiteMatch = matchExceptionDomain(message.domain, updatedExceptions);
          return { success: true, data: { exceptionStats, currentSiteMatch } };
        }

        case 'IMPORT_EXCEPTIONS_BATCH': {
          const domains = message.domains || [];
          const target = message.target || 'excluded';
          await pacKitchen.updatePacMods((current) => {
            const exceptions = Object.assign({}, current.exceptions || {});
            const whitelistSet = new Set(current.whitelist || []);
            if (target === 'included') {
              domains.forEach((d) => (exceptions[d] = true));
            } else if (target === 'excluded') {
              domains.forEach((d) => (exceptions[d] = false));
            } else if (target === 'whitelist') {
              domains.forEach((d) => whitelistSet.add(d));
            }
            const whitelist = [...whitelistSet];
            return Object.assign({}, current, { exceptions, whitelist });
          });
          await pacSync.reapplyCurrentPac();
          const exceptionStats = pacKitchen.getCachedStats();
          return { success: true, data: { count: domains.length, exceptionStats } };
        }

        case 'CLEAR_EXCEPTIONS_CATEGORY': {
          const target = message.target || 'included';
          await pacKitchen.updatePacMods((current) => {
            const exceptions = Object.assign({}, current.exceptions || {});
            let whitelist = [...(current.whitelist || [])];
            if (target === 'included') {
              for (const k in exceptions) {
                if (exceptions[k] === true) delete exceptions[k];
              }
            } else if (target === 'excluded') {
              for (const k in exceptions) {
                if (exceptions[k] === false) delete exceptions[k];
              }
            } else if (target === 'whitelist') {
              whitelist = [];
            } else if (target === 'all') {
              for (const k in exceptions) delete exceptions[k];
              whitelist = [];
            }
            return Object.assign({}, current, { exceptions, whitelist });
          });
          await pacSync.reapplyCurrentPac();
          const exceptionStats = pacKitchen.getCachedStats();
          return { success: true, data: { exceptionStats } };
        }

        case 'SYNC_PAC': {
          await pacSync.syncWithPacProvider({
            key: message.key || pacSync.currentPacProviderKey,
            customUrl: message.customPacUrl,
            ifUnattended: false,
          });
          return { success: true, data: pacSync.getState() };
        }

        case 'INSTALL_PAC': {
          await pacSync.installPac(message.key, message.customPacUrl);
          return { success: true, data: pacSync.getState() };
        }

        case 'SET_CUSTOM_PAC_URL': {
          await pacSync.installPac('customPacUrl', message.url);
          return { success: true, data: pacSync.getState() };
        }

        case 'CLEAR_PAC': {
          await pacSync.clearPac();
          return { success: true, data: pacSync.getState() };
        }

        case 'SAVE_MODS': {
          const parsedMods = await pacKitchen.updatePacMods((current) => {
            return Object.assign({}, current, message.mods);
          });
          await pacSync.reapplyCurrentPac();

          if (Object.prototype.hasOwnProperty.call(message.mods || {}, 'customProxyStringRaw')) {
            const proxyList = utils.parseCustomProxies(parsedMods.customProxyStringRaw || '')
              .map((proxy) => proxy.raw);
            await pruneProxyHealthCache(proxyList).catch((err) => {
              console.warn('[Proxy Health] Failed to prune cached results:', err);
            });
          }

          const returnMods = serializePacMods(parsedMods, Boolean(message.includeExceptions));
          return { success: true, data: returnMods };
        }

        case 'CHECK_PROXY_HEALTH': {
          const res = await checkProxyHealth(message.proxy);
          const checkedAt = Date.now();
          const cached = await saveProxyHealthResult(message.proxy, res, checkedAt)
            .catch((err) => {
              console.warn('[Proxy Health] Failed to persist result:', err);
              return null;
            });
          return {
            success: true,
            data: Object.assign({}, res, { checkedAt: cached?.checkedAt || checkedAt }),
          };
        }

        case 'SET_LOCAL_PROXY_ENABLED': {
          const service = getLocalProxyService(message.service);
          const enabled = Boolean(message.enabled);
          let health = null;

          if (enabled) {
            health = await checkLocalProxyService(message.service, checkProxyHealth);
            if (!health.ok) {
              return { success: false, error: health.error, data: { health } };
            }
          }

          const parsedMods = await pacKitchen.updatePacMods((current) => {
            return Object.assign({}, current, { [service.modKey]: enabled });
          });
          await pacSync.reapplyCurrentPac();

          return {
            success: true,
            data: {
              pacMods: serializePacMods(parsedMods),
              health,
            },
          };
        }

        case 'GET_PAC_SCRIPT': {
          const pacData = pacSync.getPacData();
          return {
            success: true,
            data: {
              rawPacData: pacData.rawPacData,
              cookedPacData: pacData.cookedPacData,
              currentProvider: pacData.currentProvider,
            },
          };
        }

        case 'SET_RAW_PAC': {
          // Restricted to trusted extension pages by the sender-origin guard
          // above; applyPacData also performs lexical PAC validation.
          await pacSync.setRawPacData(message.pacData);
          return { success: true };
        }

        case 'SET_NOTIFICATION_OPTION': {
          await errorHandlers.setNotificationOption(message.key, message.enabled);
          return { success: true, data: errorHandlers.notificationsEnabled };
        }

        case 'GET_LAST_ERRORS': {
          return { success: true, data: errorHandlers.getLastErrors() };
        }

        case 'GET_LOGS': {
          const logs = logger.getLogs({
            category: message.category || 'all',
            level: message.level || 'all',
            search: message.search || '',
            limit: message.limit || 150,
          });
          const stats = logger.getStats();
          return { success: true, data: { logs, stats } };
        }

        case 'CLEAR_LOGS': {
          await logger.clear();
          return { success: true, data: { stats: logger.getStats() } };
        }

        case 'EXPORT_LOGS': {
          const text = logger.exportText(message.category || 'all', message.search || '');
          return { success: true, data: { text } };
        }

        case 'LOG_CLIENT_EVENT': {
          if (message.entry) {
            logger.add(message.entry);
          }
          return { success: true };
        }

        case 'TEST_CONNECTION': {
          const startTime = Date.now();
          try {
            const syncState = pacSync.getState();
            const testUrl = getConnectionTestUrl(syncState);
            const validation = utils.validatePacUrl(testUrl);
            if (!validation.valid) {
              throw new Error(validation.error);
            }
            await httpLib.probe(validation.sanitizedUrl, {
              validateFinalUrl: (finalUrl, requestedUrl) =>
                utils.validatePacResponseUrl(requestedUrl, finalUrl),
            });
            const latency = Date.now() - startTime;
            return { success: true, latency };
          } catch (err) {
            return { success: false, error: err.message || 'Сбой соединения' };
          }
        }

        case 'RESET_SETTINGS': {
          pacSync.resetRuntimeState();
          await storage.clear();
          pacKitchen.invalidateCache();
          resetProxyCredentialsState();
          await clearProxyAuthAttempts();
          ipToHost.reset();
          await pacSync.clearPac({ persist: false });
          await pacSync.syncWithPacProvider({ key: 'Антизапрет', ifUnattended: true });
          // Drain pending log writes created before/during reset, then remove
          // them so an old callback cannot resurrect cleared diagnostics.
          await logger.clear();
          logger.resetRuntimeState();
          errorHandlers.resetRuntimeState();
          await appState.reset();
          return { success: true };
        }

        default:
          return { success: false, error: `Unknown action: ${message.action}` };
      }
    };

    handleMessage()
      .then((res) => sendResponse(res))
      .catch((err) => {
        const errorMsg = formatErrorMessage(err) || err.message || String(err);
        console.warn(`[Message Bus] Handled error for action "${message.action}":`, errorMsg);
        sendResponse({ success: false, error: errorMsg });
      });

    return true; // Keep message port open for async response
  });
}
