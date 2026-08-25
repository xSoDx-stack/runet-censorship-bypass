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

  errors: {
    handleResponseError(res) {
      return new Error(`Response error: HTTP ${res.status}`);
    },
  },
};
