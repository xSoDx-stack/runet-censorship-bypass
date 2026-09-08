'use strict';

import { utils } from './utils.js';
import { registerTemporaryCredentials, unregisterTemporaryCredentials } from './proxy-auth.js';
import { logger } from './logger.js';
import { pacSync } from './pac-sync.js';
import { pacKitchen } from './pac-kitchen.js';
import {
  assertProxySettingsControllable,
  withProxySettingsLock,
} from './proxy-settings-lock.js';
import { proxyBackend } from './proxy-backend.js';

// Mutex queue to serialize health check probes and prevent race conditions on chrome.proxy.settings
let checkQueue = Promise.resolve();

/**
 * Constructs a layered Health Check PAC script that intercepts probe hostnames to route
 * through candidate test proxy, while delegating ALL other browser traffic to the original FindProxyForURL.
 *
 * NOTE: Uses variable assignment binding (FindProxyForURL = function(...) { ... }) instead of
 * a function declaration to prevent JavaScript hoisting from breaking the reference to the original function.
 */
export function generateHealthCheckPac(basePacScript, testProxyScheme) {
  const base = (basePacScript && basePacScript.trim())
    ? basePacScript
    : 'function FindProxyForURL(url, host) { return "DIRECT"; }';

  return `
${base}

var __originalFindProxyForURL = (typeof FindProxyForURL === 'function')
  ? FindProxyForURL
  : function(url, host) { return "DIRECT"; };

FindProxyForURL = function(url, host) {
  if (host === '1.1.1.1') {
    return ${JSON.stringify(testProxyScheme)};
  }
  return __originalFindProxyForURL(url, host);
};
`;
}

/**
 * Proxy Health Checker for Chromium and Firefox MV3
 * Safely executes health probes without disrupting active browser traffic, delegating non-probe
 * requests to the active PAC script and ensuring zero secret/password leakage into diagnostic logs.
 */
export function checkProxyHealth(proxyString) {
  const run = () => withProxySettingsLock(() => executeSingleProxyHealthCheck(proxyString));
  const resultPromise = checkQueue.then(run, run);
  checkQueue = resultPromise.catch(() => {});
  return resultPromise;
}

/**
 * Sequential batch check for multiple proxies through mutex queue
 */
export async function checkMultipleProxies(proxyList = []) {
  if (!Array.isArray(proxyList) || !proxyList.length) {
    return {};
  }
  const results = {};
  for (const proxyStr of proxyList) {
    if (proxyStr && typeof proxyStr === 'string' && proxyStr.trim()) {
      results[proxyStr] = await checkProxyHealth(proxyStr);
    }
  }
  return results;
}

/**
 * Internal execution of a single proxy health probe with PAC delegation and revision safety
 */
async function executeSingleProxyHealthCheck(proxyString) {
  if (!proxyString || !proxyString.trim()) {
    logger.warn('proxy', 'Проверка прокси: пустая строка', 'Передана пустая строка адреса прокси');
    return { ok: false, error: 'Пустая строка прокси' };
  }

  const parsed = utils.parseProxyScheme(proxyString);
  if (!parsed || !parsed.hostname || !parsed.port) {
    logger.warn('proxy', 'Проверка прокси: неверный формат', 'Не указан хост или порт для проверяемого прокси');
    return { ok: false, error: 'Не указан хост или порт' };
  }

  const portNum = parseInt(parsed.port, 10);
  if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
    logger.warn('proxy', 'Проверка прокси: неверный порт', `Номер порта ${parsed.port} вне диапазона (1-65535)`);
    return { ok: false, error: 'Неверный номер порта (1-65535)' };
  }

  // Safe sanitized proxy metadata for diagnostic logging (NEVER logs credentials)
  const proxyMeta = {
    scheme: parsed.type || 'unknown',
    host: parsed.hostname || 'unknown',
    port: parsed.port || 'unknown',
    hasAuth: Boolean(parsed.username),
  };

  const rawType = parsed.type.toUpperCase();
  if (parsed.hasAuth && rawType.startsWith('SOCKS')) {
    const msg = 'Прокси-API браузера не поддерживает авторизацию по логину и паролю для SOCKS4/SOCKS5 — ни в Chromium, ни в Firefox';
    logger.warn('auth', 'Неподдерживаемая авторизация SOCKS', msg, proxyMeta);
    return { ok: false, error: msg };
  }

  // 1. Map protocol to PAC keyword
  // P1.3: Use explicit isSocks flag instead of fragile includes(';') detection
  let pacKeyword;
  let isSocks = false;

  if (rawType === 'HTTP') {
    pacKeyword = 'PROXY';
  } else if (rawType === 'SOCKS4') {
    pacKeyword = 'SOCKS';
  } else if (rawType === 'SOCKS5' || rawType === 'SOCKS') {
    isSocks = true;
  } else {
    pacKeyword = rawType; // HTTPS or other
  }

  const testProxyScheme = isSocks
    ? `SOCKS5 ${parsed.hostname}:${parsed.port}; SOCKS ${parsed.hostname}:${parsed.port}`
    : `${pacKeyword} ${parsed.hostname}:${parsed.port}`;

  // 2. Resolve active base PAC script with full top-level scope preservation
  let basePacScript = '';
  if (pacSync.currentPacProviderKey !== 'none') {
    if (pacSync.cookedPacData) {
      basePacScript = pacSync.cookedPacData;
    } else if (pacSync.rawPacData) {
      try {
        const pacMods = await pacKitchen.getPacMods();
        basePacScript = pacKitchen.cook(pacSync.rawPacData, pacMods);
      } catch {
        basePacScript = pacSync.rawPacData;
      }
    }
  }
  if (!basePacScript || !basePacScript.trim()) {
    basePacScript = 'function FindProxyForURL(url, host) { return "DIRECT"; }';
  }

  // 3. Construct layered Test PAC via generateHealthCheckPac
  const testPac = generateHealthCheckPac(basePacScript, testProxyScheme);

  const activeMods = await pacKitchen.getPacMods();
  const startTime = Date.now();
  let result = null;
  let restorationError = null;
  const previousDetails = await assertProxySettingsControllable();

  // All asynchronous preflight steps are complete. Register credentials only
  // for the short interval in which the probe PAC may challenge for auth.
  if (parsed.username) {
    registerTemporaryCredentials(parsed.hostname, parsed.port, parsed.username, parsed.password);
  }

  try {
    // Apply layered test proxy configuration
    await assertProxySettingsControllable();
    await proxyBackend.applyPac(testPac, {
      mandatory: activeMods.ifProxyOrDie !== false,
    });

    // Execute probe fetch with timeout
    const timeoutMs = 5000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const probeUrl = `https://1.1.1.1/cdn-cgi/trace?_probe=${Date.now()}`;
      const res = await fetch(probeUrl, {
        cache: 'no-store',
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (res && (res.status === 200 || res.status === 204)) {
        const latency = Date.now() - startTime;
        result = { ok: true, latency };
      } else if (res && res.status === 407) {
        const msg = 'Ошибка авторизации (407 Proxy Authentication Required): неверный логин или пароль';
        logger.warn('auth', 'Ошибка авторизации прокси (407)', msg, proxyMeta);
        result = { ok: false, error: msg };
      } else {
        const msg = `Сервер вернул статус HTTP ${res ? res.status : 'нет ответа'}`;
        logger.warn('proxy', 'Прокси вернул некорректный статус', msg, { ...proxyMeta, status: res ? res.status : null });
        result = { ok: false, error: msg };
      }
    } catch (fetchErr) {
      clearTimeout(timer);
      if (fetchErr.name === 'AbortError') {
        const msg = 'Таймаут: прокси-сервер не ответил за 5 секунд';
        logger.warn('proxy', 'Таймаут подключения к прокси', msg, proxyMeta);
        result = { ok: false, error: msg };
      } else {
        const errStr = (fetchErr.message || String(fetchErr)).toLowerCase();
        let msg = '';
        if (errStr.includes('407') || errStr.includes('auth')) {
          msg = 'Ошибка авторизации (407): неверный логин или пароль';
          logger.warn('auth', 'Ошибка авторизации', msg, proxyMeta);
        } else if (errStr.includes('cert') || errStr.includes('tls') || errStr.includes('ssl')) {
          msg = 'Ошибка TLS/SSL: если ваш локальный прокси без SSL, выберите протокол HTTP вместо HTTPS';
          logger.warn('proxy', 'Ошибка SSL/TLS прокси', msg, { ...proxyMeta, error: fetchErr.message });
        } else {
          msg = 'Не удалось подключиться к прокси. Убедитесь, что сервер запущен и выбран правильный протокол (HTTP/HTTPS/SOCKS5)';
          logger.warn('proxy', 'Сбой подключения к прокси', msg, { ...proxyMeta, error: fetchErr.message });
        }
        result = { ok: false, error: msg };
      }
    }
  } finally {
    // 4. Restore exactly what was active before the probe. Permanent proxy
    // changes wait on the same lock and will run immediately afterwards.
    try {
      await assertProxySettingsControllable();
      await proxyBackend.restore(previousDetails);
    } catch (restoreErr) {
      const msg = `Не удалось восстановить настройки прокси после проверки: ${restoreErr.message || restoreErr}`;
      logger.error('proxy', 'Критическая ошибка восстановления прокси', msg);
      restorationError = new Error(msg);
    }
    if (parsed.username) {
      unregisterTemporaryCredentials(parsed.hostname, parsed.port);
    }
  }

  if (restorationError) throw restorationError;
  return result || { ok: false, error: 'Неизвестная ошибка проверки' };
}
