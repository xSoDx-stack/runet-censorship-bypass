'use strict';

/**
 * Storage Manager for Manifest V3 using chrome.storage.local
 */
export const storage = {
  async get(key, defaultValue = undefined) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.get(key, (items) => {
        if (chrome.runtime.lastError) {
          return reject(new Error(chrome.runtime.lastError.message));
        }
        if (key === null || key === undefined) {
          resolve(items || {});
        } else if (typeof key === 'string') {
          resolve(items && items[key] !== undefined ? items[key] : defaultValue);
        } else if (Array.isArray(key)) {
          const res = {};
          for (const k of key) {
            res[k] = items && items[k] !== undefined ? items[k] : defaultValue;
          }
          resolve(res);
        } else {
          resolve(items !== undefined ? items : defaultValue);
        }
      });
    });
  },

  async set(key, value) {
    return new Promise((resolve, reject) => {
      let items;
      if (typeof key === 'object' && key !== null) {
        items = key;
      } else {
        items = { [key]: value };
      }
      chrome.storage.local.set(items, () => {
        if (chrome.runtime.lastError) {
          return reject(new Error(chrome.runtime.lastError.message));
        }
        resolve();
      });
    });
  },

  async remove(keys) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.remove(keys, () => {
        if (chrome.runtime.lastError) {
          return reject(new Error(chrome.runtime.lastError.message));
        }
        resolve();
      });
    });
  },

  async clear() {
    return new Promise((resolve, reject) => {
      chrome.storage.local.clear(() => {
        if (chrome.runtime.lastError) {
          return reject(new Error(chrome.runtime.lastError.message));
        }
        resolve();
      });
    });
  },

  /**
   * Namespaced storage helper for compatibility with legacy prefixes
   */
  createNamespace(prefix) {
    return {
      async get(key, defaultValue = undefined) {
        return storage.get(prefix + key, defaultValue);
      },
      async set(key, value) {
        return storage.set(prefix + key, value);
      },
      async remove(key) {
        return storage.remove(prefix + key);
      },
    };
  },
};
