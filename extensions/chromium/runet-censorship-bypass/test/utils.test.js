'use strict';

import { expect } from 'chai';
import { utils } from '../src/extension-common/core/utils.js';

describe('Utils: parseProxyScheme', () => {
  it('should correctly parse standard HTTP proxy without auth', () => {
    const res = utils.parseProxyScheme('HTTP 127.0.0.1:8080');
    expect(res.type).to.equal('HTTP');
    expect(res.hostname).to.equal('127.0.0.1');
    expect(res.port).to.equal('8080');
    expect(res.username).to.be.undefined;
    expect(res.password).to.be.undefined;
  });

  it('should correctly parse HTTPS proxy with username and password', () => {
    const res = utils.parseProxyScheme('HTTPS myuser:mypassword@proxy.example.com:443');
    expect(res.type).to.equal('HTTPS');
    expect(res.hostname).to.equal('proxy.example.com');
    expect(res.port).to.equal('443');
    expect(res.username).to.equal('myuser');
    expect(res.password).to.equal('mypassword');
  });

  it('should correctly parse SOCKS5 proxy', () => {
    const res = utils.parseProxyScheme('SOCKS5 10.0.0.1:1080');
    expect(res.type).to.equal('SOCKS5');
    expect(res.hostname).to.equal('10.0.0.1');
    expect(res.port).to.equal('1080');
  });

  it('should fallback to default ports when port is omitted', () => {
    const httpRes = utils.parseProxyScheme('HTTP proxy.local');
    expect(httpRes.port).to.equal('8080');

    const httpsRes = utils.parseProxyScheme('HTTPS secure.local');
    expect(httpsRes.port).to.equal('443');

    const socksRes = utils.parseProxyScheme('SOCKS5 socks.local');
    expect(socksRes.port).to.equal('1080');
  });
});
