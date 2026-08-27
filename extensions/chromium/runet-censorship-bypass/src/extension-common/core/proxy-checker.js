'use strict';

import { utils } from './utils.js';
import { registerTemporaryCredentials, unregisterTemporaryCredentials } from './proxy-auth.js';
import { logger } from './logger.js';
import { pacSync } from './pac-sync.js';
import { pacKitchen } from './pac-kitchen.js';

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
  if (host === '1.1.1.1' || host === 'cloudflare.com' || host === 'cp.cloudflare.com' || host === 'connectivitycheck.gstatic.com' || host === 'dns.google') {
    return "${testProxyScheme}";
  }
  return __originalFindProxyForURL(url, host);
};
`;
}

/**
 * Proxy Health Checker for Chrome MV3
 * Safely executes health probes without disrupting active browser traffic, delegating non-probe
 * requests to the active PAC script and ensuring zero secret/password leakage into diagnostic logs.
 */
export function checkProxyHealth(proxyString) {
  const run = () => executeSingleProxyHealthCheck(proxyString);
  const resultPromise = checkQueue.then(run, run);
  checkQueue = resultPromise.catch(() => {});
  return resultPromise;
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
  if (!parsed.hostname || !parsed.port) {
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

  // 1. Register temporary credentials for test probe if present (in-memory only)
  if (parsed.username) {
    registerTemporaryCredentials(parsed.hostname, parsed.port, parsed.username, parsed.password);
  }

  // 2. Map protocol to PAC keyword
  let pacKeyword = parsed.type.toUpperCase();
  if (pacKeyword === 'HTTP') {
    pacKeyword = 'PROXY';
  } else if (pacKeyword === 'SOCKS4') {
    pacKeyword = 'SOCKS';
  } else if (pacKeyword === 'SOCKS5' || pacKeyword === 'SOCKS') {
    pacKeyword = 'SOCKS5; SOCKS';
  }

  const testProxyScheme = pacKeyword.includes(';')
    ? `SOCKS5 ${parsed.hostname}:${parsed.port}; SOCKS ${parsed.hostname}:${parsed.port}`
    : `${pacKeyword} ${parsed.hostname}:${parsed.port}`;

  // 3. Resolve active base PAC script with full top-level scope preservation
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

  // 4. Construct layered Test PAC via generateHealthCheckPac
  const testPac = generateHealthCheckPac(basePacScript, testProxyScheme);

  const testConfig = {
    mode: 'pac_script',
    pacScript: {
      data: testPac,
      mandatory: false,
    },
  };

  const startTime = Date.now();
  let result = null;

  try {
    // Apply layered test proxy configuration
    await new Promise((resolve, reject) => {
      chrome.proxy.settings.set({ value: testConfig, scope: 'regular' }, () => {
        if (chrome.runtime.lastError) {
          return reject(new Error(chrome.runtime.lastError.message));
        }
        resolve();
      });
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
    // 5. Guaranteed cleanup of temporary credentials in memory
    unregisterTemporaryCredentials(parsed.hostname, parsed.port);

    // 6. Restore active PAC safely: reapply current authoritative state to avoid stale snapshots
    try {
      await pacSync.reapplyCurrentPac();
    } catch (restoreErr) {
      console.warn('Failed to restore active PAC after health check:', restoreErr);
    }
  }

  return result || { ok: false, error: 'Неизвестная ошибка проверки' };
}
