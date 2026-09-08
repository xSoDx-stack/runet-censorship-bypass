'use strict';

const PRIVATE_BROWSING_ERROR_CODE = 'FIREFOX_PRIVATE_BROWSING_REQUIRED';
const PAC_MIME_TYPE = 'application/x-ns-proxy-autoconfig';
const REVOKE_DELAY_MS = 1000;

let activePacData = '';
let activePacUrl = '';
let activeMandatory = false;

function callProxySetting(method, details) {
  return new Promise((resolve, reject) => {
    const settings = chrome.proxy && chrome.proxy.settings;
    if (!settings || typeof settings[method] !== 'function') {
      reject(new Error(`Firefox не поддерживает proxy.settings.${method}()`));
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

function revokePacUrlLater(url) {
  if (!url || typeof URL?.revokeObjectURL !== 'function') return;
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
}

function isPrivateBrowsingAllowed() {
  return new Promise((resolve) => {
    const checker = chrome.extension && chrome.extension.isAllowedIncognitoAccess;
    if (typeof checker !== 'function') {
      resolve(false);
      return;
    }
    checker.call(chrome.extension, (allowed) => {
      if (chrome.runtime.lastError) {
        resolve(false);
        return;
      }
      resolve(Boolean(allowed));
    });
  });
}

function createPrivateBrowsingError() {
  const error = new Error(
    'Firefox требует разрешить расширению работу в приватных окнах, ' +
    'поскольку настройка PAC действует на весь профиль браузера.'
  );
  error.name = 'FirefoxPrivateBrowsingPermissionError';
  error.code = PRIVATE_BROWSING_ERROR_CODE;
  return error;
}

function openOptionsInAddonsManager() {
  return new Promise((resolve, reject) => {
    const opener = chrome.runtime && chrome.runtime.openOptionsPage;
    if (typeof opener !== 'function') {
      reject(new Error('Firefox не предоставил доступ к странице управления расширением'));
      return;
    }

    opener.call(chrome.runtime, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

async function assertPrivateBrowsingAccess() {
  if (!await isPrivateBrowsingAllowed()) {
    throw createPrivateBrowsingError();
  }
}

function makeSnapshot(details) {
  return {
    nativeValue: details && details.value ? { ...details.value } : null,
    wasControlledByThisExtension:
      details && details.levelOfControl === 'controlled_by_this_extension',
    pacData: activePacData,
    pacUrl: activePacUrl,
    mandatory: activeMandatory,
  };
}

/**
 * Firefox uses a different proxy.settings schema. A Blob URL lets Gecko's
 * native PAC engine evaluate large, locally cooked PAC scripts without eval,
 * new Function, remote module loading, or data-URL size limits.
 */
export const proxyBackend = {
  platform: 'firefox',
  privateBrowsingErrorCode: PRIVATE_BROWSING_ERROR_CODE,

  async openPrivateBrowsingSettings() {
    await openOptionsInAddonsManager();
  },

  async getSettings() {
    const details = await callProxySetting('get', {});
    return {
      ...details,
      backendSnapshot: makeSnapshot(details),
    };
  },

  async applyPac(pacData, { mandatory = false } = {}) {
    await assertPrivateBrowsingAccess();
    if (typeof Blob !== 'function' || typeof URL?.createObjectURL !== 'function') {
      throw new Error('Firefox не предоставил Blob URL API для применения PAC-скрипта');
    }

    const nextPacUrl = URL.createObjectURL(new Blob([pacData], { type: PAC_MIME_TYPE }));
    const previousPacUrl = activePacUrl;
    try {
      await callProxySetting('set', {
        value: {
          proxyType: 'autoConfig',
          autoConfigUrl: nextPacUrl,
        },
      });
    } catch (error) {
      URL.revokeObjectURL(nextPacUrl);
      throw error;
    }

    activePacData = pacData;
    activePacUrl = nextPacUrl;
    activeMandatory = Boolean(mandatory);
    if (previousPacUrl && previousPacUrl !== nextPacUrl) {
      revokePacUrlLater(previousPacUrl);
    }
  },

  async clear() {
    await assertPrivateBrowsingAccess();
    await callProxySetting('clear', {});
    const previousPacUrl = activePacUrl;
    activePacData = '';
    activePacUrl = '';
    activeMandatory = false;
    revokePacUrlLater(previousPacUrl);
  },

  async restore(details) {
    await assertPrivateBrowsingAccess();
    const snapshot = details && details.backendSnapshot;
    if (snapshot && snapshot.pacData) {
      // Never restore the old Blob URL itself. Applying a temporary PAC queues
      // that URL for revocation, and an event-page restart releases Blob URLs
      // as well. Rebuild it from the captured PAC so rollback stays valid.
      await this.applyPac(snapshot.pacData, { mandatory: snapshot.mandatory });
      return;
    }

    if (snapshot && snapshot.wasControlledByThisExtension && snapshot.nativeValue) {
      await callProxySetting('set', { value: snapshot.nativeValue });
      activePacData = snapshot.pacData || '';
      activePacUrl = snapshot.pacUrl || '';
      activeMandatory = Boolean(snapshot.mandatory);
      return;
    }

    await this.clear();
  },

  isExpectedPacApplied(details, pacData) {
    const value = details && details.value;
    return Boolean(
      details &&
      details.levelOfControl === 'controlled_by_this_extension' &&
      value &&
      value.proxyType === 'autoConfig' &&
      value.autoConfigUrl === activePacUrl &&
      activePacData === pacData
    );
  },

  addSettingsChangeListener(listener) {
    return addEventListener(chrome.proxy?.settings?.onChange, listener);
  },

  addErrorListener(listener) {
    return addEventListener(chrome.proxy?.onError, listener);
  },

  async getCapabilities() {
    const privateBrowsingAllowed = await isPrivateBrowsingAllowed();
    return {
      platform: this.platform,
      canApplyPac: privateBrowsingAllowed,
      requiresPrivateBrowsing: true,
      privateBrowsingAllowed,
    };
  },
};
