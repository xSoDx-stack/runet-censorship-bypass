'use strict';

import { storage } from './storage.js';

const IP_STORAGE_KEY = 'ip-to-host';

const DEFAULT_PROXY_IPS = {
  // Local Tor / Xray / SOCKS5 / Shadowsocks / Sing-box proxies
  '127.0.0.1': 'localhost',
  '0.0.0.0': 'localhost',
  '::1': 'localhost',

  // Known Antizapret proxy server IPs
  '195.201.201.32': 'proxy.antizapret.prostovpn.org:8443',
  '51.158.176.144': 'proxy.antizapret.prostovpn.org:8443',
  '194.58.109.112': 'proxy.antizapret.prostovpn.org:8443',
  '140.238.220.198': 'proxy.antizapret.prostovpn.org:8443',
  '193.124.18.238': 'proxy.antizapret.prostovpn.org:8443',
  '188.130.137.66': 'proxy.antizapret.prostovpn.org:8443',
  '5.188.78.115': 'proxy.antizapret.prostovpn.org:8443',
  '185.112.102.133': 'proxy.antizapret.prostovpn.org:8443',
  '193.107.218.175': 'proxy.antizapret.prostovpn.org:8443',
  '176.119.157.170': 'proxy.antizapret.prostovpn.org:8443',
  '194.135.83.186': 'proxy.antizapret.prostovpn.org:8443',
  '185.204.1.203': 'proxy.antizapret.prostovpn.org:8443',
  '95.217.218.137': 'proxy.antizapret.prostovpn.org:8443',
  '159.69.208.243': 'proxy.antizapret.prostovpn.org:8443',
};

class IpToHostManager {
  constructor() {
    this.ipToHostMap = Object.assign({}, DEFAULT_PROXY_IPS);
    this.initialized = false;
  }

  async init() {
    const saved = await storage.get(IP_STORAGE_KEY, null);
    if (saved && typeof saved === 'object') {
      Object.assign(this.ipToHostMap, saved);
    }
    this.initialized = true;
  }

  get(ip) {
    if (!ip) return null;
    return this.ipToHostMap[ip] || null;
  }

  isProxyIp(ip) {
    if (!ip) return false;
    return Boolean(this.ipToHostMap[ip]);
  }

  addHost(host, ips = []) {
    if (!host) return;
    const cleanHost = String(host).trim();
    if (!cleanHost) return;

    // Safe IP extraction: handles bare IPs, host:port, [ipv6]:port and bare [ipv6]
    let bareIp = cleanHost;
    if (cleanHost.startsWith('[')) {
      bareIp = cleanHost.replace(/^\[([^\]]+)\](?::\d+)?$/, '$1');
    } else if (cleanHost.includes(':')) {
      bareIp = cleanHost.split(':')[0];
    }

    const isIPv4 = /^(\d{1,3}\.){3}\d{1,3}$/.test(bareIp);
    const isIPv6 = bareIp.includes(':') || bareIp === 'localhost';
    if (isIPv4 || isIPv6) {
      this.ipToHostMap[bareIp] = cleanHost;
    }

    if (Array.isArray(ips)) {
      for (const ip of ips) {
        if (ip && typeof ip === 'string') {
          this.ipToHostMap[ip.trim()] = cleanHost;
        }
      }
    }
  }

  updateFromProxyString(proxyString) {
    if (!proxyString) return;
    const parts = String(proxyString).split(/;\s*/);
    for (const part of parts) {
      const cleaned = part.replace(/^(HTTPS|HTTP|PROXY|SOCKS5?)\s+/i, '').trim();
      if (!cleaned || cleaned === 'DIRECT') continue;
      const hostOnly = cleaned.split('@').pop() || '';
      if (hostOnly) {
        this.addHost(hostOnly);
      }
    }
  }

  updateFromPac(pacData) {
    if (!pacData || typeof pacData !== 'string') return;
    const matches = pacData.matchAll(/(?:HTTPS|PROXY|SOCKS5?)\s+([a-zA-Z0-9.\-_:]+)/gi);
    for (const match of matches) {
      if (match[1] && match[1] !== 'DIRECT') {
        this.addHost(match[1]);
      }
    }
  }

  reset() {
    this.ipToHostMap = Object.assign({}, DEFAULT_PROXY_IPS);
    this.initialized = false;
  }

  async persistData() {
    await storage.set(IP_STORAGE_KEY, this.ipToHostMap);
  }

  async getIpsForHost(host) {
    if (!host || host.trim() === 'localhost') {
      return ['127.0.0.1', '0.0.0.0', '::1'];
    }
    return [];
  }
}

export const ipToHost = new IpToHostManager();
