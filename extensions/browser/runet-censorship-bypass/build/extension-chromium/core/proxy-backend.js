'use strict';

function callProxySetting(method, details) {
  return new Promise((resolve, reject) => {
    const settings = chrome.proxy && chrome.proxy.settings;
    if (!settings || typeof settings[method] !== 'function') {
      reject(new Error(`Браузер не поддерживает proxy.settings.${method}()`));
      return;
    }

    settings[method](details, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(result);
    });
  });
}

function addEventListener(event, listener) {
  if (!event || typeof event.addListener !== 'function') return false;
  if (typeof event.hasListener === 'function' && event.hasListener(listener)) {
    return true;
  }
  event.addListener(listener);
  return true;
}

/**
 * Chromium implementation of the profile-wide proxy contract used by the
 * shared application code. The Firefox build replaces this module at build
 * time, so Chromium keeps its native PAC configuration unchanged.
 */
export const proxyBackend = {
  platform: 'chromium',

  async getSettings() {
    return callProxySetting('get', {});
  },

  async applyPac(pacData, { mandatory = false } = {}) {
    await callProxySetting('set', {
      value: {
        mode: 'pac_script',
        pacScript: {
          data: pacData,
          mandatory: Boolean(mandatory),
        },
      },
      scope: 'regular',
    });
  },

  async clear() {
    await callProxySetting('clear', { scope: 'regular' });
  },

  async restore(details) {
    if (details && details.value) {
      await callProxySetting('set', {
        value: details.value,
        scope: 'regular',
      });
      return;
    }
    await this.clear();
  },

  isExpectedPacApplied(details, pacData) {
    return Boolean(
      details &&
      details.value &&
      details.value.mode === 'pac_script' &&
      details.value.pacScript &&
      details.value.pacScript.data === pacData
    );
  },

  addSettingsChangeListener(listener) {
    return addEventListener(chrome.proxy?.settings?.onChange, listener);
  },

  addErrorListener(listener) {
    return addEventListener(chrome.proxy?.onProxyError, listener);
  },

  async getCapabilities() {
    return {
      platform: this.platform,
      canApplyPac: true,
      requiresPrivateBrowsing: false,
      privateBrowsingAllowed: true,
    };
  },
};
