'use strict';

import { expect } from 'chai';
import { utils } from '../src/extension-common/core/utils.js';

describe('Utils: parseProxyScheme', () => {
  it('should correctly parse standard HTTP proxy without auth', () => {
    const res = utils.parseProxyScheme('HTTP 127.0.0.1:8080');
    expect(res.type).to.equal('HTTP');
    expect(res.hostname).to.equal('127.0.0.1');
    expect(res.port).to.equal('8080');
    expect(res.username).to.equal('');
    expect(res.password).to.equal('');
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
    expect(res.username).to.equal('');
    expect(res.password).to.equal('');
  });

  it('should parse proxy with hostname only when port is omitted', () => {
    const httpRes = utils.parseProxyScheme('HTTP proxy.local');
    expect(httpRes.type).to.equal('HTTP');
    expect(httpRes.hostname).to.equal('proxy.local');
    expect(httpRes.port).to.equal('');
  });
});
