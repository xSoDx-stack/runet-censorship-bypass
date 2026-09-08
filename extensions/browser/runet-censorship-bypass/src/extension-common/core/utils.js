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
  let type = defaultType ? defaultType.toUpperCase() : 'HTTPS';
  if (!ALLOWED_PROTOCOLS.has(type)) {
    type = 'HTTPS';
  }

  // Check if string starts with a protocol token
  if (/\s+/.test(str)) {
    const tokens = str.split(/\s+/);
    const firstToken = tokens[0].toUpperCase();
    if (ALLOWED_PROTOCOLS.has(firstToken)) {
      type = firstToken;
      str = tokens.slice(1).join(' ').trim();
    } else {
      // Unknown protocol with space (e.g. "FTP proxy:8080", "BANANA host:1234") -> REJECT
      return null;
    }
  }

  let username = '';
  let password = '';
  let creds = '';
  let addr = str;

  if (str.includes('@')) {
    const atIndex = str.lastIndexOf('@');
    creds = str.slice(0, atIndex);
    addr = str.slice(atIndex + 1);

    if (!creds) return null;
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
    if (!username) return null;
  }

  addr = addr.trim();
  if (!addr) return null;

  let hostname = '';
  let portStr = '';

  if (addr.startsWith('[')) {
    // Bracketed IPv6: e.g. [2001:db8::1]:1080 or [::1]:8080
    const closeBracket = addr.indexOf(']');
    if (closeBracket === -1) return null;
    const ipContent = addr.slice(1, closeBracket).trim();
    if (!ipContent || !ipContent.includes(':')) return null; // malformed IPv6
    hostname = `[${ipContent.toLowerCase()}]`;
    const rest = addr.slice(closeBracket + 1);
    if (!rest.startsWith(':')) return null; // port is mandatory
    portStr = rest.slice(1).trim();
  } else {
    // IPv4 or Hostname: host:port
    const colonIndex = addr.lastIndexOf(':');
    if (colonIndex === -1) return null; // port is mandatory
    hostname = addr.slice(0, colonIndex).toLowerCase().trim();
    portStr = addr.slice(colonIndex + 1).trim();
    if (hostname.includes(':')) return null; // IPv6 must use [address]:port form
  }

  if (!hostname) return null;

  // Reject whitespace, URL delimiters and malformed IP literals before they
  // can become an invalid PAC proxy directive. URL also canonicalizes IDNs.
  if (/[\s/?#@"'\\]/.test(hostname)) return null;
  try {
    hostname = new URL(`http://${hostname}/`).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return null;
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
    protocol: type,
    hostname,
    port,
    username,
    password,
    creds,
    hostPort,
    address: hostPort,
    canonicalEndpoint: `${type} ${hostPort}`,
    hasAuth: Boolean(username || password),
    raw: proxyAsStringRaw.trim(),
  };
}

/**
 * Separates an optional port from the structured proxy form's host field and
 * canonicalizes bare IPv6 addresses to the bracketed form used by PAC.
 */
export function parseProxyHostInput(rawHost, rawPort = '') {
  let host = typeof rawHost === 'string' ? rawHost.trim() : '';
  let port = rawPort === null || rawPort === undefined ? '' : String(rawPort).trim();
  if (!host) return null;

  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/.*$/, '').trim();
  if (!host) return null;

  if (host.startsWith('[')) {
    const match = host.match(/^\[([^\]]+)](?::([^:]+))?$/);
    if (!match) return null;
    host = `[${match[1]}]`;
    if (match[2]) {
      if (!/^\d+$/.test(match[2])) return null;
      if (!port) port = match[2];
    }
  } else {
    const colonCount = (host.match(/:/g) || []).length;
    if (colonCount === 1) {
      const separator = host.lastIndexOf(':');
      const embeddedPort = host.slice(separator + 1);
      if (!/^\d+$/.test(embeddedPort)) return null;
      host = host.slice(0, separator);
      if (!port) port = embeddedPort;
    } else if (colonCount > 1) {
      host = `[${host}]`;
    }
  }

  return host ? { host, port } : null;
}

/**
 * Parses raw multi-line custom proxy string using the single canonical parser.
 *
 * @param {string} rawString
 * @returns {Array<object>}
 */
export function parseCustomProxies(rawString = '') {
  if (!rawString || typeof rawString !== 'string') return [];
  const lines = rawString
    .replace(/#.*$/gm, '')
    .split(/(?:\s*(?:;\r?\n)+\s*|\r?\n+|;\s*)+/g)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const result = [];
  for (const line of lines) {
    const parsed = parseProxyScheme(line);
    if (parsed) {
      result.push(parsed);
    }
  }
  return result;
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
  parseProxyHostInput,
  parseCustomProxies,
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
        error: `Недопустимый протокол: ${proto}. Разрешён только https:`,
      };
    }

    const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const isLoopback = host === 'localhost' || host === '::1' ||
      /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);

    if (proto === 'http:' && !isLoopback) {
      return {
        valid: false,
        error: 'Разрешён только защищённый протокол https:. Небезопасный http: заблокирован.',
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

  /**
   * Revalidates the effective PAC response URL after Fetch redirects.
   * Direct private/local HTTP PAC URLs remain supported, while an HTTPS
   * request is never allowed to downgrade to HTTP during a redirect.
   *
   * @param {string} requestedUrl originally requested PAC URL
   * @param {string} finalUrl effective Response.url after redirects
   * @returns {{valid: boolean, error?: string, sanitizedUrl?: string}}
   */
  validatePacResponseUrl(requestedUrl, finalUrl) {
    const requested = this.validatePacUrl(requestedUrl);
    if (!requested.valid) return requested;

    const effective = this.validatePacUrl(finalUrl);
    if (!effective.valid) {
      return {
        valid: false,
        error: `Перенаправление PAC заблокировано: ${effective.error}`,
      };
    }

    const requestedProtocol = new URL(requested.sanitizedUrl).protocol;
    const finalProtocol = new URL(effective.sanitizedUrl).protocol;
    if (requestedProtocol === 'https:' && finalProtocol !== 'https:') {
      return {
        valid: false,
        error: 'Перенаправление PAC с HTTPS на небезопасный HTTP заблокировано.',
      };
    }

    return effective;
  },

  errors: {
    handleResponseError(res) {
      return new Error(`Response error: HTTP ${res.status}`);
    },
  },
};
