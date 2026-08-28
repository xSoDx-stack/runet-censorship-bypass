'use strict';

import { expect } from 'chai';
import { ipToHost } from '../src/extension-common/core/ip-to-host.js';
import { blockInformer } from '../src/extension-common/core/block-informer.js';
import { httpLib } from '../src/extension-common/core/http-lib.js';

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
});

