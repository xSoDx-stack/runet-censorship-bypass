'use strict';

import { expect } from 'chai';
import { ipToHost } from '../src/extension-common/core/ip-to-host.js';
import {
  blockInformer,
  classifyProxySource,
  normalizeProxyEndpoint,
} from '../src/extension-common/core/block-informer.js';
import { httpLib } from '../src/extension-common/core/http-lib.js';
import { logger } from '../src/extension-common/core/logger.js';

describe('BlockInformer & IpToHost', () => {
  let origHttpLibGet;

  before(() => {
    origHttpLibGet = httpLib.get;
    httpLib.get = async () => 'function FindProxyForURL(url, host) { return "DIRECT"; }';
  });

  after(() => {
    httpLib.get = origHttpLibGet;
  });
  it('should identify known default proxy IPs in ipToHost', () => {
    expect(ipToHost.get('195.201.201.32')).to.include('proxy.antizapret.prostovpn.org');
    expect(ipToHost.get('127.0.0.1')).to.equal('localhost');
    expect(ipToHost.isProxyIp('51.158.176.144')).to.be.true;
    expect(ipToHost.get('8.8.8.8')).to.be.null;
  });

  it('should dynamically register custom proxy IPs and hostnames', () => {
    // P2.4: '198.51.100.25:8080' contains a port so it is NOT a bare IPv4 address —
    // addHost with ips[] param is the correct way to map a specific IP to a proxy host
    ipToHost.addHost('198.51.100.25:8080', ['198.51.100.25']);
    expect(ipToHost.get('198.51.100.25')).to.equal('198.51.100.25:8080');

    ipToHost.updateFromPac('function FindProxyForURL() { return "HTTPS custom-proxy.net:443; SOCKS5 10.20.30.40:1080; DIRECT"; }');
    expect(ipToHost.get('10.20.30.40')).to.equal('10.20.30.40:1080');

    ipToHost.addHost('2001:db8::1');
    expect(ipToHost.get('2001:db8::1')).to.equal('2001:db8::1');
    ipToHost.addHost('not:a:valid:ipv6');
    expect(ipToHost.get('not:a:valid:ipv6')).to.equal(null);
  });

  it('should correctly track proxied hosts per tab in BlockInformer', () => {
    const tabId = 999;
    blockInformer.clearTab(tabId);

    blockInformer.recordProxiedHost(tabId, 'rutracker.org', 'proxy.antizapret.prostovpn.org:8443', true);
    let stats = blockInformer.getTabStats(tabId);
    expect(stats.count).to.equal(1);
    expect(stats.hosts).to.include('rutracker.org');

    // Add another subdomain on same tab
    blockInformer.recordProxiedHost(tabId, 'static.rutracker.org', 'proxy.antizapret.prostovpn.org:8443', false);
    stats = blockInformer.getTabStats(tabId);
    expect(stats.count).to.equal(2);
    expect(stats.hosts).to.include('rutracker.org');
    expect(stats.hosts).to.include('static.rutracker.org');

    // Clear tab on navigation
    blockInformer.clearTab(tabId);
    stats = blockInformer.getTabStats(tabId);
    expect(stats.count).to.equal(0);
  });

  it('classifies own and PAC proxy endpoints without exposing credentials', () => {
    expect(normalizeProxyEndpoint('HTTPS user:secret@Own.Proxy:443'))
      .to.equal('own.proxy:443');
    expect(classifyProxySource(
      'own.proxy:443',
      'HTTPS own.proxy:443; SOCKS5 127.0.0.1:9150'
    )).to.equal('own');
    expect(classifyProxySource('127.0.0.1:9150', '')).to.equal('own');
    expect(classifyProxySource('proxy.antizapret.prostovpn.org:8443', ''))
      .to.equal('antizapret');
    expect(classifyProxySource('provider-proxy.example:443', ''))
      .to.equal('pac');
  });

  it('keeps the observed main-frame route for the current tab and domain', async () => {
    const tabId = 1000;
    blockInformer.clearTab(tabId);
    blockInformer.recordProxiedHost(
      tabId,
      'docs.github.com',
      'HTTPS own.proxy:443',
      true,
      'own',
      'observed'
    );

    expect(await blockInformer.getTabRoute(tabId, 'github.com')).to.include({
      kind: 'proxy',
      source: 'own',
      hostname: 'docs.github.com',
      proxyHost: 'own.proxy:443',
      confidence: 'observed',
    });
    expect(await blockInformer.getTabRoute(tabId, 'example.com')).to.equal(null);

    blockInformer.recordDirectRoute(tabId, 'docs.github.com');
    expect(await blockInformer.getTabRoute(tabId, 'github.com')).to.include({
      kind: 'direct',
      source: 'direct',
      confidence: 'observed',
    });
    blockInformer.clearTab(tabId);
  });

  it('should safely handle handleRequest even during cold start and ignore internal URLs', async () => {
    const tabId = 1001;
    blockInformer.clearTab(tabId);

    // Internal browser/extension URLs should be ignored
    await blockInformer.handleRequest({ tabId, url: 'chrome-extension://xyz/options.html', ip: '195.201.201.32' });
    let stats = blockInformer.getTabStats(tabId);
    expect(stats.count).to.equal(0);

    // Proxy IP request
    await blockInformer.handleRequest({ tabId, url: 'https://rutracker.org/forum/index.php', ip: '195.201.201.32', type: 'main_frame' });
    stats = blockInformer.getTabStats(tabId);
    expect(stats.count).to.equal(1);
    expect(stats.hosts).to.include('rutracker.org');

    blockInformer.clearTab(tabId);
  });

  it('records only top-level proxy request failures as non-fatal warnings', () => {
    const originalAdd = logger.add;
    const entries = [];
    logger.add = (entry) => entries.push(entry);

    try {
      blockInformer.handleConnectionError({
        tabId: 7,
        url: 'https://docs.github.com/en',
        error: 'net::ERR_TUNNEL_CONNECTION_FAILED',
        type: 'main_frame',
      });
      blockInformer.handleConnectionError({
        tabId: 7,
        url: 'https://github.githubassets.com/app.js',
        error: 'net::ERR_TUNNEL_CONNECTION_FAILED',
        type: 'script',
      });
      blockInformer.handleConnectionError({
        tabId: -1,
        url: 'https://1.1.1.1/cdn-cgi/trace',
        error: 'net::ERR_PROXY_CONNECTION_FAILED',
        type: 'xmlhttprequest',
      });

      expect(entries).to.have.lengthOf(1);
      expect(entries[0]).to.include({
        level: 'warn',
        category: 'proxy',
        title: 'net::ERR_TUNNEL_CONNECTION_FAILED',
        groupKey: 'net::ERR_TUNNEL_CONNECTION_FAILED|docs.github.com|main_frame',
      });
      expect(entries[0].message).to.include('отдельный запрос');
      expect(entries[0].message).to.include('не означает');
      expect(entries[0].details).to.deep.equal({
        error: 'net::ERR_TUNNEL_CONNECTION_FAILED',
        domain: 'docs.github.com',
        type: 'main_frame',
      });
    } finally {
      logger.add = originalAdd;
    }
  });
});
