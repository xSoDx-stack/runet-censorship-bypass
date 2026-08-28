'use strict';

import { expect } from 'chai';
import { parseProxyScheme, getRootDomain } from '../src/extension-common/core/utils.js';

describe('Utils: parseProxyScheme & getRootDomain (Tasks 6 & 7.1)', () => {
  describe('Canonical Proxy Parser', () => {
    it('should correctly parse standard HTTP IPv4:port without auth', () => {
      const res = parseProxyScheme('HTTP 127.0.0.1:8080');
      expect(res).to.exist;
      expect(res.type).to.equal('HTTP');
      expect(res.hostname).to.equal('127.0.0.1');
      expect(res.port).to.equal('8080');
      expect(res.hostPort).to.equal('127.0.0.1:8080');
      expect(res.username).to.equal('');
      expect(res.password).to.equal('');
      expect(res.hasAuth).to.be.false;
    });

    it('should correctly parse HTTPS hostname:port with username and password', () => {
      const res = parseProxyScheme('HTTPS myuser:mypassword@proxy.example.com:443');
      expect(res).to.exist;
      expect(res.type).to.equal('HTTPS');
      expect(res.hostname).to.equal('proxy.example.com');
      expect(res.port).to.equal('443');
      expect(res.hostPort).to.equal('proxy.example.com:443');
      expect(res.username).to.equal('myuser');
      expect(res.password).to.equal('mypassword');
      expect(res.hasAuth).to.be.true;
    });

    it('should correctly parse SOCKS5 with bracketed [IPv6]:port', () => {
      const res = parseProxyScheme('SOCKS5 [2001:db8::1]:1080');
      expect(res).to.exist;
      expect(res.type).to.equal('SOCKS5');
      expect(res.hostname).to.equal('[2001:db8::1]');
      expect(res.port).to.equal('1080');
      expect(res.hostPort).to.equal('[2001:db8::1]:1080');
      expect(res.hasAuth).to.be.false;
    });

    it('should correctly parse HTTPS with [::1]:8080 loopback IPv6', () => {
      const res = parseProxyScheme('HTTPS user:pass@[::1]:8080');
      expect(res).to.exist;
      expect(res.type).to.equal('HTTPS');
      expect(res.hostname).to.equal('[::1]');
      expect(res.port).to.equal('8080');
      expect(res.username).to.equal('user');
      expect(res.password).to.equal('pass');
    });

    it('should reject proxy when port is omitted (mandatory port)', () => {
      const res = parseProxyScheme('HTTP proxy.local');
      expect(res).to.be.null;
    });

    it('should reject invalid ports (out of 1..65535 range, NaN, negative)', () => {
      expect(parseProxyScheme('HTTP proxy.example.com:0')).to.be.null;
      expect(parseProxyScheme('HTTP proxy.example.com:65536')).to.be.null;
      expect(parseProxyScheme('HTTP proxy.example.com:70000')).to.be.null;
      expect(parseProxyScheme('HTTP proxy.example.com:-80')).to.be.null;
      expect(parseProxyScheme('HTTP proxy.example.com:abc')).to.be.null;
      expect(parseProxyScheme('HTTP proxy.example.com:80.5')).to.be.null;
    });

    it('should reject unknown protocols and invalid prefixes', () => {
      expect(parseProxyScheme('FTP proxy.example.com:8080')).to.be.null;
      expect(parseProxyScheme('BANANA host:1234')).to.be.null;
      expect(parseProxyScheme('GOPHER gopher.net:70')).to.be.null;
    });

    it('should correctly decode URI-encoded credentials with special characters', () => {
      const res = parseProxyScheme('HTTPS user%40name:p%40ss%3Aword@proxy.example.com:443');
      expect(res).to.exist;
      expect(res.username).to.equal('user@name');
      expect(res.password).to.equal('p@ss:word');
    });

    it('should reject malformed input strings', () => {
      expect(parseProxyScheme('')).to.be.null;
      expect(parseProxyScheme('   ')).to.be.null;
      expect(parseProxyScheme(null)).to.be.null;
      expect(parseProxyScheme(undefined)).to.be.null;
      expect(parseProxyScheme('HTTP [::1')).to.be.null; // unclosed bracket
      expect(parseProxyScheme('HTTP [::1]:')).to.be.null; // empty port
      expect(parseProxyScheme('HTTP :8080')).to.be.null; // empty hostname
      expect(parseProxyScheme('HTTP []:8080')).to.be.null; // empty bracket
    });

    it('should parse multi-line custom proxy string using canonical parseCustomProxies', async () => {
      const { parseCustomProxies } = await import('../src/extension-common/core/utils.js');
      const raw = `
        # Comment line
        HTTPS user:pass@proxy1.com:443;
        SOCKS5 [::1]:1080
        FTP invalid:8080
        HTTP 127.0.0.1:8080 # trailing comment
      `;
      const list = parseCustomProxies(raw);
      expect(list).to.have.lengthOf(3);
      expect(list[0].hostname).to.equal('proxy1.com');
      expect(list[0].port).to.equal('443');
      expect(list[0].username).to.equal('user');
      expect(list[1].hostname).to.equal('[::1]');
      expect(list[1].type).to.equal('SOCKS5');
      expect(list[2].hostname).to.equal('127.0.0.1');
    });
  });

  describe('Public Suffix List getRootDomain (Task 7.1)', () => {
    it('should extract root domain for standard single-level TLDs', () => {
      expect(getRootDomain('example.com')).to.equal('example.com');
      expect(getRootDomain('sub.example.com')).to.equal('example.com');
      expect(getRootDomain('a.b.c.example.com')).to.equal('example.com');
      expect(getRootDomain('www.example.org')).to.equal('example.org');
    });

    it('should extract root domain for multi-level Public Suffixes (co.uk, org.ru, etc.)', () => {
      expect(getRootDomain('sub.domain.co.uk')).to.equal('domain.co.uk');
      expect(getRootDomain('news.bbc.co.uk')).to.equal('bbc.co.uk');
      expect(getRootDomain('my.site.org.ru')).to.equal('site.org.ru');
      expect(getRootDomain('user.github.io')).to.equal('user.github.io');
    });

    it('should safely fall back to full host for IP addresses, localhost, and internal hosts', () => {
      expect(getRootDomain('192.168.1.1')).to.equal('192.168.1.1');
      expect(getRootDomain('127.0.0.1')).to.equal('127.0.0.1');
      expect(getRootDomain('localhost')).to.equal('localhost');
      expect(getRootDomain('internal-host')).to.equal('internal-host');
    });
  });
});
