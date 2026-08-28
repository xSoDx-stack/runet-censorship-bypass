'use strict';

import { expect } from 'chai';
import { pacKitchen, updatePacMods } from '../src/extension-common/core/pac-kitchen.js';
import { storage } from '../src/extension-common/core/storage.js';

let mockStorage = {};
let storageWriteShouldFail = false;

describe('PAC Kitchen: Concurrency, Persist-First & Reset (Tasks 2, 3, 4)', () => {
  beforeEach(async () => {
    mockStorage = {};
    storageWriteShouldFail = false;

    globalThis.chrome = {
      runtime: {
        get lastError() {
          return storageWriteShouldFail ? { message: 'Simulated Disk I/O Write Failure' } : null;
        },
      },
      storage: {
        local: {
          get: (key, cb) => {
            if (typeof key === 'string') {
              cb({ [key]: mockStorage[key] });
            } else {
              cb(Object.assign({}, mockStorage));
            }
          },
          set: (items, cb) => {
            if (!storageWriteShouldFail) {
              Object.assign(mockStorage, items);
            }
            if (cb) cb();
          },
          remove: (keys, cb) => {
            const kArr = Array.isArray(keys) ? keys : [keys];
            kArr.forEach((k) => delete mockStorage[k]);
            if (cb) cb();
          },
          clear: (cb) => {
            mockStorage = {};
            if (cb) cb();
          },
        },
      },
    };

    pacKitchen.invalidateCache();
    await storage.clear();
  });

  it('Task 2: Concurrent mutations via updatePacMods must serialize without losing updates', async () => {
    // Initial state
    await pacKitchen.savePacMods({
      exceptions: { 'initial.example': true },
      ifUseSecureProxiesOnly: false,
      ifProxyOrDie: true,
    });

    // Run two concurrent updates that modify DIFFERENT fields of pacMods
    const op1 = updatePacMods(async (current) => {
      // simulate slight async delay
      await new Promise((r) => setTimeout(r, 10));
      const exceptions = Object.assign({}, current.exceptions || {}, { 'site1.example': true });
      return Object.assign({}, current, { exceptions });
    });

    const op2 = updatePacMods(async (current) => {
      await new Promise((r) => setTimeout(r, 5));
      return Object.assign({}, current, { ifUseSecureProxiesOnly: true });
    });

    const [res1, res2] = await Promise.all([op1, op2]);

    // Both operations completed
    expect(res1).to.exist;
    expect(res2).to.exist;

    // Verify final state has BOTH changes (neither was lost due to race condition)
    const finalMods = await pacKitchen.getPacMods();
    expect(finalMods.exceptions['site1.example']).to.equal(true);
    expect(finalMods.exceptions['initial.example']).to.equal(true);
    expect(finalMods.ifUseSecureProxiesOnly).to.equal(true);
  });

  it('Task 3: When storage write fails, savePacMods rejects and RAM cache remains unchanged', async () => {
    // Initial valid state
    await pacKitchen.savePacMods({
      exceptions: { 'saved.example': true },
      ifUseSecureProxiesOnly: false,
    });

    const beforeMods = await pacKitchen.getPacMods();
    expect(beforeMods.exceptions['saved.example']).to.equal(true);

    // Turn on simulated storage failure
    storageWriteShouldFail = true;

    let threw = false;
    try {
      await pacKitchen.savePacMods({
        exceptions: { 'unsaved.example': true },
        ifUseSecureProxiesOnly: true,
      });
    } catch (err) {
      threw = true;
      expect(err.message).to.include('Simulated Disk I/O Write Failure');
    }

    expect(threw).to.be.true;

    // Cache must still hold the previous authoritative state
    const afterMods = await pacKitchen.getPacMods();
    expect(afterMods.exceptions['saved.example']).to.equal(true);
    expect(afterMods.exceptions['unsaved.example']).to.be.undefined;
    expect(afterMods.ifUseSecureProxiesOnly).to.equal(false);
  });

  it('Task 3b: When storage write fails, proxyAuth active in-memory credentials do NOT switch to new unpersisted credentials', async () => {
    // 1. Initially saved valid proxy credentials
    await pacKitchen.savePacMods({
      customProxyStringRaw: 'HTTPS initialUser:initialPass@valid.proxy.com:443',
    });

    const { findCredentials } = await import('../src/extension-common/core/proxy-auth.js');
    expect(findCredentials('valid.proxy.com', 443)).to.deep.equal({
      username: 'initialUser',
      password: 'initialPass',
    });

    // 2. Storage write fails on new update
    storageWriteShouldFail = true;

    let threw = false;
    try {
      await pacKitchen.savePacMods({
        customProxyStringRaw: 'HTTPS newUser:newPass@unwritten.proxy.com:443',
      });
    } catch {
      threw = true;
    }

    expect(threw).to.be.true;

    // 3. Verify in-memory proxyAuth map STILL has initial credentials and did NOT adopt unwritten ones
    expect(findCredentials('valid.proxy.com', 443)).to.deep.equal({
      username: 'initialUser',
      password: 'initialPass',
    });
    expect(findCredentials('unwritten.proxy.com', 443)).to.be.null;
  });

  it('Task 4: RESET_SETTINGS clears storage and RAM cache, returning to default state', async () => {
    // 1. Save custom mods
    await pacKitchen.savePacMods({
      exceptions: { 'custom.example': true, 'direct.example': false },
      ifUseSecureProxiesOnly: true,
      customProxyStringRaw: 'HTTPS custom-proxy.local:8443',
    });

    // 2. Warm RAM cache
    const warmed = await pacKitchen.getPacMods();
    expect(warmed.exceptions['custom.example']).to.equal(true);
    expect(warmed.ifUseSecureProxiesOnly).to.equal(true);

    // 3. Perform RESET
    await storage.clear();
    pacKitchen.invalidateCache();

    // 4. Verify no old values returned from storage or RAM cache
    const freshMods = await pacKitchen.getPacMods();
    expect(freshMods.exceptions).to.deep.equal({});
    expect(freshMods.ifUseSecureProxiesOnly).to.equal(false); // default
    expect(freshMods.customProxyStringRaw).to.equal('');
  });
});
