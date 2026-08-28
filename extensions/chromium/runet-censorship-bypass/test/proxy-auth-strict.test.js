'use strict';

import { expect } from 'chai';
import {
  updateProxyCredentialsFromRaw,
  findCredentials,
  registerTemporaryCredentials,
  unregisterTemporaryCredentials,
} from '../src/extension-common/core/proxy-auth.js';
import { storage } from '../src/extension-common/core/storage.js';

let mockStorage = {};

globalThis.chrome = {
  runtime: { lastError: null },
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

describe('Proxy Auth: Strict Host:Port Scope & Multi-Port Isolation (Task 6)', () => {
  beforeEach(async () => {
    mockStorage = {};
    unregisterTemporaryCredentials();
    await updateProxyCredentialsFromRaw('');
    await storage.set('proxy-credentials-map', {});
  });

  it('Two proxies on the same host with DIFFERENT ports must never mix or leak credentials', async () => {
    // Two proxies on same host: proxy.example.com on port 443 and port 8443 with different users
    const rawProxyConfig = [
      'HTTPS user443:pass443@proxy.example.com:443',
      'HTTPS user8443:pass8443@proxy.example.com:8443',
    ].join(';\n');

    await updateProxyCredentialsFromRaw(rawProxyConfig);

    // Challenge on port 443 gets credentials for 443 only
    const creds443 = findCredentials('proxy.example.com', 443);
    expect(creds443).to.exist;
    expect(creds443.username).to.equal('user443');
    expect(creds443.password).to.equal('pass443');

    // Challenge on port 8443 gets credentials for 8443 only
    const creds8443 = findCredentials('proxy.example.com', 8443);
    expect(creds8443).to.exist;
    expect(creds8443.username).to.equal('user8443');
    expect(creds8443.password).to.equal('pass8443');

    // Challenge on an unconfigured port 9443 on the same host receives NOTHING (null)
    const credsUnknownPort = findCredentials('proxy.example.com', 9443);
    expect(credsUnknownPort).to.be.null;
  });

  it('IPv6 proxy endpoints with brackets must resolve strict auth correctly', async () => {
    await updateProxyCredentialsFromRaw('HTTPS ipv6user:ipv6pass@[2001:db8::1]:1080');

    const creds = findCredentials('[2001:db8::1]', 1080);
    expect(creds).to.exist;
    expect(creds.username).to.equal('ipv6user');
    expect(creds.password).to.equal('ipv6pass');

    // Different port on same IPv6
    expect(findCredentials('[2001:db8::1]', 8080)).to.be.null;
  });

  it('Temporary probe credentials with different ports on same host do not cross-pollute', () => {
    registerTemporaryCredentials('test-host.local', 8080, 'tempUser8080', 'tempPass8080');
    registerTemporaryCredentials('test-host.local', 9090, 'tempUser9090', 'tempPass9090');

    expect(findCredentials('test-host.local', 8080).username).to.equal('tempUser8080');
    expect(findCredentials('test-host.local', 9090).username).to.equal('tempUser9090');
    expect(findCredentials('test-host.local', 7070)).to.be.null;

    unregisterTemporaryCredentials('test-host.local', 8080);
    expect(findCredentials('test-host.local', 8080)).to.be.null;
    expect(findCredentials('test-host.local', 9090).username).to.equal('tempUser9090');
  });
});
