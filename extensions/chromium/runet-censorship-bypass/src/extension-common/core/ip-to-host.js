import { storage } from './storage.js';

const IP_STORAGE_KEY = 'ip-to-host';

class IpToHostManager {
  constructor() {
    this.ipToHostMap = {
      '127.0.0.1': 'localhost',
      '0.0.0.0': 'localhost',
      '::1': 'localhost',
    };
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

  async persistData() {
    await storage.set(IP_STORAGE_KEY, this.ipToHostMap);
  }

  async getIpsForHost(host) {
    if (!host || host.trim() === 'localhost') {
      return ['127.0.0.1', '0.0.0.0', '::1'];
    }
    return [];
  }

  async updateHosts() {
    // Completely offline: zero external DNS/DoH requests
  }
}

export const ipToHost = new IpToHostManager();
