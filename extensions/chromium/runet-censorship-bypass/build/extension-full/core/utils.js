'use strict';

import { getDomain } from '../vendor/tldts.esm.js';

export function getRootDomain(hostname) {
  if (!hostname || typeof hostname !== 'string') return '';
  let host = hostname.toLowerCase().trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/:\d+$/, '');
  host = host.replace(/^\.+|\.+$/g, '');
  if (host.startsWith('www.')) {
    host = host.slice(4);
  }
  if (!host) return '';
  try {
    const d = getDomain(host, { allowPrivateDomains: true });
    if (d) return d;
  } catch {
    // fallback
  }
  return host;
}

/**
 * Canonical proxy endpoint parser.
 * Handles hostname, IPv4, bracketed [IPv6]:port, credentials (user:pass@),
 * allowed protocols (HTTP, HTTPS, SOCKS4, SOCKS5, SOCKS), and mandatory port in 1..65535.
 *
 * @param {string} proxyAsStringRaw
 * @param {string} [defaultType='HTTPS']
 * @returns {{
 *   type: string,
 *   hostname: string,
 *   port: string,
 *   username: string,
 *   password: string,
 *   creds: string,
 *   hostPort: string,
 *   hasAuth: boolean,
 *   raw: string
 * } | null}
 */
export function parseProxyScheme(proxyAsStringRaw, defaultType = 'HTTPS') {
  if (!proxyAsStringRaw || typeof proxyAsStringRaw !== 'string') return null;
  let str = proxyAsStringRaw.trim();
  if (!str) return null;

  const ALLOWED_PROTOCOLS = new Set(['HTTP', 'HTTPS', 'SOCKS4', 'SOCKS5', 'SOCKS']);
  const firstToken = str.split(/\s+/)[0].toUpperCase();
  let type = defaultType.toUpperCase();
  if (ALLOWED_PROTOCOLS.has(firstToken)) {
    type = firstToken;
    str = str.slice(firstToken.length).trim();
  }

  let username = '';
  let password = '';
  let creds = '';
  let addr = str;

  if (str.includes('@')) {
    const atIndex = str.lastIndexOf('@');
    creds = str.slice(0, atIndex);
    addr = str.slice(atIndex + 1);

    if (creds) {
      const credParts = creds.split(':');
      const rawUser = credParts[0] || '';
      const rawPass = credParts.slice(1).join(':') || '';
      try {
        username = decodeURIComponent(rawUser);
      } catch {
        username = rawUser;
      }
      try {
        password = decodeURIComponent(rawPass);
      } catch {
        password = rawPass;
      }
    }
  }

  addr = addr.trim();
  if (!addr) return null;

  let hostname = '';
  let portStr = '';

  if (addr.startsWith('[')) {
    // Bracketed IPv6: e.g. [2001:db8::1]:1080 or [::1]:8080
    const closeBracket = addr.indexOf(']');
    if (closeBracket === -1) return null;
    hostname = addr.slice(0, closeBracket + 1).toLowerCase();
    const rest = addr.slice(closeBracket + 1);
    if (!rest.startsWith(':')) return null; // port is mandatory
    portStr = rest.slice(1);
  } else {
    // IPv4 or Hostname: host:port
    const colonIndex = addr.lastIndexOf(':');
    if (colonIndex === -1) return null; // port is mandatory
    hostname = addr.slice(0, colonIndex).toLowerCase().trim();
    portStr = addr.slice(colonIndex + 1).trim();
  }

  if (!hostname) return null;

  const portNum = Number(portStr);
  if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
    return null; // invalid port out of range
  }

  const port = String(portNum);
  const hostPort = `${hostname}:${port}`;

  return {
    type,
    hostname,
    port,
    username,
    password,
    creds,
    hostPort,
    hasAuth: Boolean(username || password),
    raw: proxyAsStringRaw.trim(),
  };
}

export const utils = {
  checkChromeError() {
    const err = chrome.runtime.lastError;
    if (!err) return null;
    console.warn('API returned error:', err);
    return new Error(err.message);
  },

  areSettingsControllableFor(details) {
    if (!details || !details.levelOfControl) return false;
    return details.levelOfControl.endsWith('this_extension');
  },

  areSettingsControlledFor(details) {
    if (!details || !details.levelOfControl) return false;
    return details.levelOfControl.startsWith('controlled_by_this');
  },

  messages: {
    searchSettingsForUrl(niddle) {
      return 'chrome://settings/?search=' + (chrome.i18n.getMessage(niddle) || niddle);
    },

    whichExtensionHtml() {
      return chrome.i18n.getMessage('noControl') +
        ` <a href="${this.searchSettingsForUrl('proxy')}">${chrome.i18n.getMessage('WhichQ')}</a>`;
    },
  },

  parseProxyScheme,
  getRootDomain,

  validatePacUrl(urlStr) {
    if (!urlStr || typeof urlStr !== 'string' || !urlStr.trim()) {
      return { valid: false, error: 'Введите адрес ссылки на PAC-скрипт' };
    }
    const cleanUrl = urlStr.trim();
    let parsed;
    try {
      parsed = new URL(cleanUrl);
    } catch {
      return { valid: false, error: 'Некорректный формат URL адреса' };
    }

    const proto = (parsed.protocol || '').toLowerCase();
    if (proto !== 'https:' && proto !== 'http:') {
      return {
        valid: false,
        error: `Недопустимый протокол: ${proto}. Разрешены только https: и http:`,
      };
    }

    if (parsed.username || parsed.password) {
      return {
        valid: false,
        error: 'URL не должен содержать встроенный логин и пароль (user:password@)',
      };
    }

    return {
      valid: true,
      sanitizedUrl: parsed.href,
      isHttp: proto === 'http:',
      hostname: parsed.hostname,
    };
  },

  errors: {
    handleResponseError(res) {
      return new Error(`Response error: HTTP ${res.status}`);
    },
  },
};
