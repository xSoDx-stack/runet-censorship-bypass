'use strict';

import { pacSync, PAC_PROVIDERS } from './pac-sync.js';
import { pacKitchen, getDefaultConfigs, getExceptionStats, matchExceptionDomain } from './pac-kitchen.js';
import { ipToHost } from './ip-to-host.js';
import { errorHandlers } from './error-handlers.js';
import { storage } from './storage.js';
import { httpLib } from './http-lib.js';
import { checkProxyHealth } from './proxy-checker.js';
import { logger } from './logger.js';
import { formatErrorMessage } from './errors-lib.js';

export function setupMessageBus() {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || !message.action) {
      return false;
    }

    const handleMessage = async () => {
      switch (message.action) {
        case 'GET_STATE': {
          // Ultra-fast cached sync state and cached mods (0ms)
          const syncState = pacSync.getState();
          const pacMods = await pacKitchen.getPacMods();
          const defaultConfigs = getDefaultConfigs();
          const exceptionStats = pacKitchen.getCachedStats();

          let currentSiteMatch = { matched: false };
          if (message.currentDomain) {
            currentSiteMatch = matchExceptionDomain(message.currentDomain, pacMods.exceptions);
          }

          // Return strictly lightweight settings payload (<1 KB) for popup window
          const returnMods = {
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

          if (message.includeExceptions) {
            returnMods.exceptions = pacMods.exceptions || {};
            returnMods.whitelist = pacMods.whitelist || [];
          }

          // Non-blocking background control state refresh
          pacSync.updateControlState().catch(() => {});

          return {
            success: true,
            data: {
              syncState,
              pacMods: returnMods,
              exceptionStats,
              currentSiteMatch,
              defaultConfigs,
              notifications: errorHandlers.notificationsEnabled,
              lastErrors: errorHandlers.getLastErrors(),
              version: chrome.runtime.getManifest().version,
            },
          };
        }

        case 'GET_FULL_EXCEPTIONS': {
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
          const pacMods = await pacKitchen.getPacMods();
          const exceptions = Object.assign({}, pacMods.exceptions || {});
          if (message.isProxy === null || message.isProxy === undefined) {
            delete exceptions[message.domain];
          } else {
            exceptions[message.domain] = Boolean(message.isProxy);
          }
          const updatedMods = Object.assign({}, pacMods, { exceptions });
          await pacKitchen.savePacMods(updatedMods);
          await pacSync.reapplyCurrentPac();
          const exceptionStats = pacKitchen.getCachedStats();
          const currentSiteMatch = matchExceptionDomain(message.domain, exceptions);
          return { success: true, data: { exceptionStats, currentSiteMatch } };
        }

        case 'IMPORT_EXCEPTIONS_BATCH': {
          const pacMods = await pacKitchen.getPacMods();
          const exceptions = Object.assign({}, pacMods.exceptions || {});
          const whitelist = [...(pacMods.whitelist || [])];
          const domains = message.domains || [];
          const target = message.target || 'excluded';

          if (target === 'included') {
            domains.forEach((d) => (exceptions[d] = true));
          } else if (target === 'excluded') {
            domains.forEach((d) => (exceptions[d] = false));
          } else if (target === 'whitelist') {
            domains.forEach((d) => {
              if (!whitelist.includes(d)) whitelist.push(d);
            });
          }

          const updatedMods = Object.assign({}, pacMods, { exceptions, whitelist });
          await pacKitchen.savePacMods(updatedMods);
          await pacSync.reapplyCurrentPac();
          const exceptionStats = pacKitchen.getCachedStats();
          return { success: true, data: { count: domains.length, exceptionStats } };
        }

        case 'SYNC_PAC': {
          await pacSync.syncWithPacProvider({ key: message.key, ifUnattended: false });
          return { success: true, data: pacSync.getState() };
        }

        case 'INSTALL_PAC': {
          await pacSync.installPac(message.key);
          return { success: true, data: pacSync.getState() };
        }

        case 'CLEAR_PAC': {
          await pacSync.clearPac();
          return { success: true, data: pacSync.getState() };
        }

        case 'SAVE_MODS': {
          const currentMods = await pacKitchen.getPacMods();
          const mergedMods = Object.assign({}, currentMods, message.mods);
          const parsedMods = await pacKitchen.savePacMods(mergedMods);
          await pacSync.reapplyCurrentPac();

          const returnMods = {
            ifProxyHttpsUrlsOnly: Boolean(parsedMods.ifProxyHttpsUrlsOnly),
            ifUseSecureProxiesOnly: Boolean(parsedMods.ifUseSecureProxiesOnly),
            ifProhibitDns: Boolean(parsedMods.ifProhibitDns),
            ifProxyOrDie: parsedMods.ifProxyOrDie !== false,
            ifUsePacScriptProxies: parsedMods.ifUsePacScriptProxies !== false,
            ifUseLocalTor: Boolean(parsedMods.ifUseLocalTor),
            ifUseLocalWarp: Boolean(parsedMods.ifUseLocalWarp),
            ifMindExceptions: parsedMods.ifMindExceptions !== false,
            ifMindWhitelist: Boolean(parsedMods.ifMindWhitelist),
            ifUseOwnProxiesOnlyForOwnSites: Boolean(parsedMods.ifUseOwnProxiesOnlyForOwnSites),
            customProxyStringRaw: parsedMods.customProxyStringRaw || '',
            ifProxyMoreDomains: Boolean(parsedMods.ifProxyMoreDomains),
            replaceDirectWith: parsedMods.replaceDirectWith || '',
          };
          if (message.includeExceptions) {
            returnMods.exceptions = parsedMods.exceptions || {};
            returnMods.whitelist = parsedMods.whitelist || [];
          }
          return { success: true, data: returnMods };
        }

        case 'CHECK_PROXY_HEALTH': {
          const res = await checkProxyHealth(message.proxy);
          return { success: true, data: res };
        }

        case 'GET_PAC_SCRIPT': {
          return {
            success: true,
            data: {
              rawPacData: pacSync.rawPacData,
              cookedPacData: pacSync.cookedPacData,
              currentProvider: pacSync.currentPacProviderKey,
            },
          };
        }

        case 'SET_RAW_PAC': {
          pacSync.rawPacData = message.pacData;
          await pacSync.applyPacData(message.pacData);
          await pacSync.persistState();
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
            const providerKey = syncState.currentPacProviderKey || 'Антизапрет';
            const prov = PAC_PROVIDERS[providerKey] || PAC_PROVIDERS['Антизапрет'];
            let testUrl = (prov.pacUrls && prov.pacUrls[0]) || 'https://anticensority.github.io/generated-pac-scripts/anticensority.pac';
            if (testUrl.startsWith('data:')) {
              testUrl = 'https://anticensority.github.io/generated-pac-scripts/anticensority.pac';
            }
            await httpLib.ifModifiedSince(testUrl, null);
            const latency = Date.now() - startTime;
            return { success: true, latency };
          } catch (err) {
            return { success: false, error: err.message || 'Сбой соединения' };
          }
        }

        case 'RESET_SETTINGS': {
          await storage.clear();
          await pacSync.clearPac();
          await pacSync.installPac('Антизапрет');
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
