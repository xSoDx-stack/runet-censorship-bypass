'use strict';

import { utils } from './utils.js';
import { registerTemporaryCredentials, unregisterTemporaryCredentials } from './proxy-auth.js';
import { logger } from './logger.js';

/**
 * Proxy Health Checker for Chrome MV3
 */
export async function checkProxyHealth(proxyString) {
  if (!proxyString || !proxyString.trim()) {
    logger.warn('proxy', 'Проверка прокси: пустая строка', 'Передана пустая строка адреса прокси');
    return { ok: false, error: 'Пустая строка прокси' };
  }

  const parsed = utils.parseProxyScheme(proxyString);
  if (!parsed.hostname || !parsed.port) {
    logger.warn('proxy', 'Проверка прокси: неверный формат', `Не указан хост или порт для "${proxyString}"`);
    return { ok: false, error: 'Не указан хост или порт' };
  }

  const portNum = parseInt(parsed.port, 10);
  if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
    logger.warn('proxy', 'Проверка прокси: неверный порт', `Номер порта ${parsed.port} вне диапазона (1-65535)`);
    return { ok: false, error: 'Неверный номер порта (1-65535)' };
  }

  // 1. Notice for SOCKS5 auth in Chromium
  let isSocksWithAuth = parsed.type.startsWith('SOCKS') && Boolean(parsed.username);

  // 2. Register temporary credentials for test probe
  if (parsed.username) {
    registerTemporaryCredentials(parsed.hostname, parsed.port, parsed.username, parsed.password);
  }

  // 4. Active Probe Test via strict temporary PAC test route (WITHOUT DIRECT fallback!)
  return new Promise((resolve) => {
    const startTime = Date.now();

    // Get current proxy settings to restore after check
    chrome.proxy.settings.get({}, (originalSettings) => {
      let restored = false;
      const restoreOriginal = () => {
        if (restored) return;
        restored = true;
        if (parsed.username) {
          unregisterTemporaryCredentials(parsed.hostname, parsed.port);
        }
        if (originalSettings && originalSettings.value) {
          chrome.proxy.settings.set({ value: originalSettings.value, scope: 'regular' }, () => {});
        }
      };

      // Map protocol to standard PAC keyword
      let pacKeyword = parsed.type.toUpperCase();
      if (pacKeyword === 'HTTP') {
        pacKeyword = 'PROXY';
      } else if (pacKeyword === 'SOCKS4') {
        pacKeyword = 'SOCKS';
      }

      const testProxyScheme = `${pacKeyword} ${parsed.hostname}:${parsed.port}`;

      // CRITICAL: NO DIRECT FALLBACK! All probe domains MUST route exclusively through the test proxy.
      const testPac = `
        function FindProxyForURL(url, host) {
          if (host === '1.1.1.1' || host === 'cloudflare.com' || host === 'cp.cloudflare.com' || host === 'connectivitycheck.gstatic.com' || host === 'dns.google') {
            return "${testProxyScheme}";
          }
          return "DIRECT";
        }
      `;

      const testConfig = {
        mode: 'pac_script',
        pacScript: {
          data: testPac,
          mandatory: false,
        },
      };

      // Apply test proxy temporarily
      chrome.proxy.settings.set({ value: testConfig, scope: 'regular' }, async () => {
        const timeoutMs = 5000;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        try {
          // Probe via lightweight test endpoint
          const probeUrl = `https://1.1.1.1/cdn-cgi/trace?_probe=${Date.now()}`;
          const res = await fetch(probeUrl, {
            cache: 'no-store',
            signal: controller.signal,
          });

          clearTimeout(timer);
          restoreOriginal();

          if (res && (res.status === 200 || res.status === 204)) {
            const latency = Date.now() - startTime;
            resolve({ ok: true, latency });
          } else if (res && res.status === 407) {
            const msg = 'Ошибка авторизации (407 Proxy Authentication Required): неверный логин или пароль';
            logger.warn('auth', 'Ошибка авторизации прокси (407)', msg, { proxy: proxyString });
            resolve({ ok: false, error: msg });
          } else {
            const msg = `Сервер вернул статус HTTP ${res ? res.status : 'нет ответа'}`;
            logger.warn('proxy', 'Прокси вернул некорректный статус', msg, { proxy: proxyString, status: res ? res.status : null });
            resolve({ ok: false, error: msg });
          }
        } catch (fetchErr) {
          clearTimeout(timer);
          restoreOriginal();

          if (fetchErr.name === 'AbortError') {
            const msg = 'Таймаут: прокси-сервер не ответил за 5 секунд';
            logger.warn('proxy', 'Таймаут подключения к прокси', msg, { proxy: proxyString });
            resolve({ ok: false, error: msg });
          } else {
            const errStr = (fetchErr.message || String(fetchErr)).toLowerCase();
            let msg = '';
            if (errStr.includes('407') || errStr.includes('auth')) {
              msg = 'Ошибка авторизации (407): неверный логин или пароль';
              logger.warn('auth', 'Ошибка авторизации', msg, { proxy: proxyString });
            } else if (errStr.includes('cert') || errStr.includes('tls') || errStr.includes('ssl')) {
              msg = 'Ошибка TLS/SSL: если ваш локальный прокси без SSL, выберите протокол HTTP вместо HTTPS';
              logger.warn('proxy', 'Ошибка SSL/TLS прокси', msg, { proxy: proxyString, error: fetchErr.message });
            } else {
              msg = 'Не удалось подключиться к прокси. Убедитесь, что сервер запущен и выбран правильный протокол (HTTP/HTTPS)';
              logger.warn('proxy', 'Сбой подключения к прокси', msg, { proxy: proxyString, error: fetchErr.message });
            }
            resolve({ ok: false, error: msg });
          }
        }
      });
    });
  });
}
