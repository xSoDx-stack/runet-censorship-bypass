'use strict';

import { expect } from 'chai';
import {
  initProxyAuth,
  updateProxyCredentialsFromRaw,
  registerTemporaryCredentials,
  unregisterTemporaryCredentials,
  findCredentials,
  getPersistentCredentialsMap,
  getTemporaryCredentialsMap,
} from '../src/extension-common/core/proxy-auth.js';
import { storage } from '../src/extension-common/core/storage.js';

// Mock chrome storage for node test environment
let mockStorage = {};
globalThis.chrome = {
  runtime: { lastError: null },
  storage: {
    local: {
      get: (key, cb) => {
        if (key === null || key === undefined) {
          cb(Object.assign({}, mockStorage));
        } else if (typeof key === 'string') {
          cb({ [key]: mockStorage[key] });
        } else {
          cb(Object.assign({}, mockStorage));
        }
      },
      set: (items, cb) => {
        Object.assign(mockStorage, items);
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

describe('Proxy Authentication: Separate Temporary & Persistent Credentials', () => {
  beforeEach(async () => {
    mockStorage = {};
    unregisterTemporaryCredentials();
    await updateProxyCredentialsFromRaw('');
    await storage.set('proxy-credentials-map', {});
  });

  it('should isolate persistent and temporary credentials lifecycle', async () => {
    // 1. Persistent proxy A exists
    await updateProxyCredentialsFromRaw('HTTPS userA:passA@proxyA.example.com:443');

    const credsA = findCredentials('proxyA.example.com', 443);
    expect(credsA).to.exist;
    expect(credsA.username).to.equal('userA');
    expect(credsA.password).to.equal('passA');

    const persistentBefore = getPersistentCredentialsMap();
    expect(persistentBefore['proxya.example.com:443']).to.exist;

    // 2. Health check starts and registers temporary proxy B
    registerTemporaryCredentials('proxyB.example.com', 443, 'userB', 'passB');

    // 3. During health check: B is findable, A is still findable
    const duringCheckB = findCredentials('proxyB.example.com', 443);
    expect(duringCheckB).to.exist;
    expect(duringCheckB.username).to.equal('userB');
    expect(duringCheckB.password).to.equal('passB');

    const duringCheckA = findCredentials('proxyA.example.com', 443);
    expect(duringCheckA).to.exist;
    expect(duringCheckA.username).to.equal('userA');

    // Verify storage was NOT polluted by temporary credentials B
    const savedInStorage = await storage.get('proxy-credentials-map', {});
    expect(savedInStorage['proxyB.example.com:443']).to.be.undefined;
    expect(savedInStorage['proxyB.example.com']).to.be.undefined;

    // 4. Health check finishes in finally -> unregister B
    unregisterTemporaryCredentials('proxyB.example.com', 443);

    // 5. B is completely gone (neither host:port nor host remains)
    const afterCheckB = findCredentials('proxyB.example.com', 443);
    expect(afterCheckB).to.be.null;

    const tempMapAfter = getTemporaryCredentialsMap();
    expect(tempMapAfter['proxyB.example.com:443']).to.be.undefined;
    expect(tempMapAfter['proxyB.example.com']).to.be.undefined;

    // 6. A remains completely untouched
    const afterCheckA = findCredentials('proxyA.example.com', 443);
    expect(afterCheckA).to.exist;
    expect(afterCheckA.username).to.equal('userA');
    expect(afterCheckA.password).to.equal('passA');

    const persistentAfter = getPersistentCredentialsMap();
    expect(persistentAfter['proxya.example.com:443']).to.deep.equal({
      username: 'userA',
      password: 'passA',
    });
  });

  it('should enforce strict host and port isolation', async () => {
    await updateProxyCredentialsFromRaw('HTTPS user1:secret1@proxy1.example.com:443');
    registerTemporaryCredentials('proxy2.example.com', 443, 'user2', 'secret2');

    // proxy1 should NEVER receive credentials of proxy2
    const creds1 = findCredentials('proxy1.example.com', 443);
    expect(creds1.username).to.equal('user1');
    expect(creds1.username).to.not.equal('user2');

    // proxy2 should NEVER receive credentials of proxy1
    const creds2 = findCredentials('proxy2.example.com', 443);
    expect(creds2.username).to.equal('user2');
    expect(creds2.username).to.not.equal('user1');

    // Non-existent proxy receives nothing
    const credsUnknown = findCredentials('other-proxy.com', 443);
    expect(credsUnknown).to.be.null;
  });

  it('should prioritize temporary credentials over persistent credentials for the same endpoint during probe', async () => {
    // Persistent credentials for myproxy.com:443
    await updateProxyCredentialsFromRaw('HTTPS oldUser:oldPass@myproxy.com:443');

    // Temporary probe credentials for the same endpoint
    registerTemporaryCredentials('myproxy.com', 443, 'probeUser', 'probePass');

    // While temporary credentials exist, probe credentials take precedence
    const activeCreds = findCredentials('myproxy.com', 443);
    expect(activeCreds.username).to.equal('probeUser');
    expect(activeCreds.password).to.equal('probePass');

    // Clean up temporary credentials
    unregisterTemporaryCredentials('myproxy.com', 443);

    // After cleanup, persistent credentials are restored seamlessly
    const restoredCreds = findCredentials('myproxy.com', 443);
    expect(restoredCreds.username).to.equal('oldUser');
    expect(restoredCreds.password).to.equal('oldPass');
  });

  it('should preserve localhost and loopback alias matching', async () => {
    registerTemporaryCredentials('127.0.0.1', 8080, 'localUser', 'localPass');

    expect(findCredentials('127.0.0.1', 8080)?.username).to.equal('localUser');
    expect(findCredentials('localhost', 8080)?.username).to.equal('localUser');
    expect(findCredentials('::1', 8080)?.username).to.equal('localUser');
    expect(findCredentials('[::1]', 8080)?.username).to.equal('localUser');

    unregisterTemporaryCredentials('127.0.0.1', 8080);

    expect(findCredentials('localhost', 8080)).to.be.null;
    expect(findCredentials('127.0.0.1', 8080)).to.be.null;
  });

  it('should reload persistent credentials from storage on initProxyAuth', async () => {
    await storage.set('pac-kitchen-mods', {
      customProxyStringRaw: 'HTTP storedUser:storedPassword@persisted.local:8080',
    });

    await initProxyAuth();

    const creds = findCredentials('persisted.local', 8080);
    expect(creds).to.exist;
    expect(creds.username).to.equal('storedUser');
  });
});
