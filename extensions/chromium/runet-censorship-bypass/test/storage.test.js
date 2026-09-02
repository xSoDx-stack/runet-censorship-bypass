'use strict';

import { expect } from 'chai';
import { storage } from '../src/extension-common/core/storage.js';

let mockStorage = {};
let simulatedError = null;

describe('Storage Manager: Strict Error Handling (Task 5)', () => {
  beforeEach(async () => {
    mockStorage = {};
    simulatedError = null;

    globalThis.chrome = {
      runtime: {
        get lastError() {
          return simulatedError;
        },
      },
      storage: {
        local: {
          get: (key, cb) => {
            if (typeof key === 'string') {
              cb({ [key]: mockStorage[key] });
            } else if (Array.isArray(key)) {
              const res = {};
              for (const k of key) res[k] = mockStorage[k];
              cb(res);
            } else {
              cb(Object.assign({}, mockStorage));
            }
          },
          set: (items, cb) => {
            if (!simulatedError) {
              Object.assign(mockStorage, items);
            }
            if (cb) cb();
          },
          remove: (keys, cb) => {
            if (!simulatedError) {
              const kArr = Array.isArray(keys) ? keys : [keys];
              kArr.forEach((k) => delete mockStorage[k]);
            }
            if (cb) cb();
          },
          clear: (cb) => {
            if (!simulatedError) {
              mockStorage = {};
            }
            if (cb) cb();
          },
        },
      },
    };
  });

  afterEach(() => {
    simulatedError = null;
  });

  it('should return defaultValue when key is absent in successful storage read', async () => {
    const val = await storage.get('non_existent_key', { fallback: true });
    expect(val).to.deep.equal({ fallback: true });

    const numVal = await storage.get('missing_number', 42);
    expect(numVal).to.equal(42);
  });

  it('should return actual stored value when present (not defaultValue)', async () => {
    mockStorage['existing_key'] = 'hello_world';
    const val = await storage.get('existing_key', 'fallback');
    expect(val).to.equal('hello_world');
  });

  it('should REJECT with Error when chrome.runtime.lastError is present', async () => {
    mockStorage['existing_key'] = 'critical_user_data';
    simulatedError = { message: 'Extension storage corrupted / quota exceeded' };

    let rejected = false;
    try {
      await storage.get('existing_key', 'defaultValue');
    } catch (err) {
      rejected = true;
      expect(err).to.be.an.instanceOf(Error);
      expect(err.message).to.equal('Extension storage corrupted / quota exceeded');
    }

    expect(rejected).to.be.true;
  });

  it('should reject set/remove/clear operations when runtime.lastError is present', async () => {
    simulatedError = { message: 'Write permission denied' };

    let setRejected = false;
    try {
      await storage.set('key', 'val');
    } catch (err) {
      setRejected = true;
      expect(err.message).to.equal('Write permission denied');
    }
    expect(setRejected).to.be.true;

    let clearRejected = false;
    try {
      await storage.clear();
    } catch (err) {
      clearRejected = true;
      expect(err.message).to.equal('Write permission denied');
    }
    expect(clearRejected).to.be.true;
  });

  it('restricts local storage to trusted extension contexts when supported', async () => {
    let requestedAccessLevel = null;
    chrome.storage.local.setAccessLevel = (options, cb) => {
      requestedAccessLevel = options.accessLevel;
      cb();
    };

    await storage.restrictLocalAccess();
    expect(requestedAccessLevel).to.equal('TRUSTED_CONTEXTS');
  });
});
