'use strict';

import { expect } from 'chai';
import {
  checkLocalProxyService,
  getLocalProxyService,
  LOCAL_PROXY_SERVICES,
} from '../src/extension-common/core/local-proxy-services.js';

describe('Local proxy services', () => {
  it('keeps the PAC candidates and service metadata in one validated registry', () => {
    expect(getLocalProxyService('tor')).to.equal(LOCAL_PROXY_SERVICES.tor);
    expect(LOCAL_PROXY_SERVICES.tor.proxies).to.deep.equal([
      'SOCKS5 localhost:9150',
      'SOCKS5 localhost:9050',
    ]);
    expect(LOCAL_PROXY_SERVICES.warp.proxies).to.deep.equal([
      'SOCKS5 localhost:40000',
      'HTTPS localhost:40000',
    ]);
  });

  it('rejects an unknown local service', async () => {
    expect(() => getLocalProxyService('unknown')).to.throw('Неизвестная');
    expect(() => getLocalProxyService('toString')).to.throw('Неизвестная');

    let error;
    try {
      await checkLocalProxyService('unknown', async () => ({ ok: true }));
    } catch (err) {
      error = err;
    }
    expect(error).to.be.instanceOf(TypeError);
  });

  it('tries fallback ports until one Tor endpoint works', async () => {
    const checked = [];
    const result = await checkLocalProxyService('tor', async (proxy) => {
      checked.push(proxy);
      return proxy.endsWith(':9050')
        ? { ok: true, latency: 27 }
        : { ok: false, error: 'connection refused' };
    });

    expect(checked).to.deep.equal([
      'SOCKS5 localhost:9150',
      'SOCKS5 localhost:9050',
    ]);
    expect(result).to.include({
      ok: true,
      workingProxy: 'SOCKS5 localhost:9050',
      latency: 27,
    });
  });

  it('stops after the first working endpoint', async () => {
    const checked = [];
    const result = await checkLocalProxyService('warp', async (proxy) => {
      checked.push(proxy);
      return { ok: true, latency: 11 };
    });

    expect(result.ok).to.equal(true);
    expect(checked).to.deep.equal(['SOCKS5 localhost:40000']);
  });

  it('does not report an absent service as available', async () => {
    const result = await checkLocalProxyService('warp', async () => ({
      ok: false,
      error: 'connection refused',
    }));

    expect(result.ok).to.equal(false);
    expect(result.workingProxy).to.equal(null);
    expect(result.attempts).to.have.length(2);
    expect(result.error).to.include('не обнаружен');
  });
});
