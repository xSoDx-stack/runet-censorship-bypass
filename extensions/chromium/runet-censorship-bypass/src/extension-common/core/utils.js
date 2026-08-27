'use strict';

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

  parseProxyScheme(proxyAsStringRaw) {
    const proxyAsString = (proxyAsStringRaw || '').trim();
    const [type] = proxyAsString.split(/\s+/);
    const typeRe = new RegExp(`^${type}\\s+`, 'g');
    const crededAddr = proxyAsString.replace(typeRe, '');

    const parts = crededAddr.split('@');
    const creds = parts.slice(0, -1).join('@');
    const addr = parts[parts.length - 1] || '';

    const [hostname, port] = addr.split(':');
    let username = '';
    let password = '';

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

    return {
      type: (type || 'HTTPS').toUpperCase(),
      username,
      password,
      hostname: (hostname || '').trim(),
      port: (port || '').trim(),
      creds,
    };
  },

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
