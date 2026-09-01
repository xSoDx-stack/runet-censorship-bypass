'use strict';

import { expect } from 'chai';
import vm from 'vm';
import { cookPac, createPacModifiers } from '../src/extension-common/core/pac-kitchen.js';

describe('PAC Kitchen: Proxy Or Die Semantics & Routing Regression Tests', () => {
  const basePac = `
function FindProxyForURL(url, host) {
  if (host === 'blocked.example' || host.endsWith('.blocked.example')) {
    return 'HTTPS pac-proxy.example:8443; DIRECT';
  }
  if (host === 'insecure-blocked.example') {
    return 'PROXY http-proxy.example:8080; DIRECT';
  }
  return 'DIRECT';
}
  `;

  it('fresh default settings apply Proxy Or Die instead of returning raw PAC', () => {
    const [err, defaultMods] = createPacModifiers({});
    expect(err).to.equal(null);
    expect(defaultMods.ifProxyOrDie).to.equal(true);
    const cooked = cookPac(basePac, defaultMods);
    expect(cooked).to.not.equal(basePac);
    const findProxy = evaluateCookedPac(cooked);
    expect(findProxy('https://blocked.example/', 'blocked.example')).to.not.include('DIRECT');
  });

  it('treats a proxy without an explicit protocol as HTTPS in secure-only mode', () => {
    const [err, mods] = createPacModifiers({
      customProxyStringRaw: 'secure-default.example:443\nHTTP insecure.example:8080',
      ifUseSecureProxiesOnly: true,
    });

    expect(err).to.equal(null);
    expect(mods.filteredCustomsString).to.equal('HTTPS secure-default.example:443');
  });

  function evaluateCookedPac(cookedPacCode) {
    const sandbox = {};
    vm.createContext(sandbox);
    vm.runInContext(cookedPacCode, sandbox);
    return sandbox.FindProxyForURL;
  }

  it('Manual Proxy rule + ProxyOrDie ON should return CUSTOM_PROXY with NO direct fallback', () => {
    const mods = {
      ifMindExceptions: true,
      exceptions: {
        'custom-proxy.example': true,
      },
      filteredCustomsString: 'HTTPS custom-node.example:443',
      ifProxyOrDie: true,
      ifUsePacScriptProxies: true,
    };

    const cooked = cookPac(basePac, mods);
    const findProxy = evaluateCookedPac(cooked);

    const result = findProxy('https://custom-proxy.example/page', 'custom-proxy.example');
    expect(result).to.equal('HTTPS custom-node.example:443');
    expect(result).to.not.include('DIRECT');
  });

  it('Manual Proxy rule + ProxyOrDie OFF should return CUSTOM_PROXY with DIRECT fallback', () => {
    const mods = {
      ifMindExceptions: true,
      exceptions: {
        'custom-proxy.example': true,
      },
      filteredCustomsString: 'HTTPS custom-node.example:443',
      ifProxyOrDie: false,
      ifUsePacScriptProxies: true,
    };

    const cooked = cookPac(basePac, mods);
    const findProxy = evaluateCookedPac(cooked);

    const result = findProxy('https://custom-proxy.example/page', 'custom-proxy.example');
    expect(result).to.equal('HTTPS custom-node.example:443; DIRECT');
  });

  it('Manual Proxy rule without own or PAC proxies falls back to DIRECT instead of a dead proxy', () => {
    const mods = {
      ifMindExceptions: true,
      exceptions: {
        'custom-proxy.example': true,
      },
      filteredCustomsString: '',
      ifProxyOrDie: true,
      ifUsePacScriptProxies: true,
    };

    const cooked = cookPac(basePac, mods);
    const findProxy = evaluateCookedPac(cooked);

    const result = findProxy('https://custom-proxy.example/page', 'custom-proxy.example');
    expect(result).to.equal('DIRECT');
    expect(result).to.not.equal('PROXY 127.0.0.1:0');
  });

  it('Manual DIRECT exception should ALWAYS return DIRECT regardless of ProxyOrDie status', () => {
    // 1. With ProxyOrDie ON
    const modsOn = {
      ifMindExceptions: true,
      exceptions: {
        'blocked.example': false, // user explicit DIRECT override on a blocked domain
        'my-direct.example': false,
      },
      filteredCustomsString: 'HTTPS custom-node.example:443',
      ifProxyOrDie: true,
      ifUsePacScriptProxies: true,
    };

    const cookedOn = cookPac(basePac, modsOn);
    const findProxyOn = evaluateCookedPac(cookedOn);

    expect(findProxyOn('https://blocked.example/', 'blocked.example')).to.equal('DIRECT');
    expect(findProxyOn('https://my-direct.example/', 'my-direct.example')).to.equal('DIRECT');

    // 2. With ProxyOrDie OFF
    const modsOff = {
      ifMindExceptions: true,
      exceptions: {
        'blocked.example': false,
        'my-direct.example': false,
      },
      filteredCustomsString: 'HTTPS custom-node.example:443',
      ifProxyOrDie: false,
      ifUsePacScriptProxies: true,
    };

    const cookedOff = cookPac(basePac, modsOff);
    const findProxyOff = evaluateCookedPac(cookedOff);

    expect(findProxyOff('https://blocked.example/', 'blocked.example')).to.equal('DIRECT');
    expect(findProxyOff('https://my-direct.example/', 'my-direct.example')).to.equal('DIRECT');
  });

  it('Original PAC traffic without user overrides should route blocked to PAC proxy and unblocked to DIRECT', () => {
    // ProxyOrDie ON
    const modsOn = {
      ifProxyOrDie: true,
      ifUsePacScriptProxies: true,
    };
    const findProxyOn = evaluateCookedPac(cookPac(basePac, modsOn));

    // Blocked site in base PAC has DIRECT stripped
    expect(findProxyOn('https://blocked.example/path', 'blocked.example')).to.equal('HTTPS pac-proxy.example:8443');
    // Unblocked site remains DIRECT
    expect(findProxyOn('https://unblocked.example/path', 'unblocked.example')).to.equal('DIRECT');

    // ProxyOrDie OFF
    const modsOff = {
      ifProxyOrDie: false,
      ifUsePacScriptProxies: true,
    };
    const findProxyOff = evaluateCookedPac(cookPac(basePac, modsOff));

    // Blocked site has DIRECT fallback
    expect(findProxyOff('https://blocked.example/path', 'blocked.example')).to.equal('HTTPS pac-proxy.example:8443; DIRECT');
    // Unblocked site remains DIRECT
    expect(findProxyOff('https://unblocked.example/path', 'unblocked.example')).to.equal('DIRECT');
  });

  it('Empty proxy list after filtering with ProxyOrDie ON must fail-closed (PROXY 127.0.0.1:0) and NEVER leak DIRECT', () => {
    // 1. Manual proxy rule but no custom proxies and no PAC proxies available
    const modsProxyOrDieOn = {
      ifMindExceptions: true,
      exceptions: {
        'must-be-proxied.example': true,
      },
      filteredCustomsString: '', // empty proxy list
      ifProxyOrDie: true,
      ifUsePacScriptProxies: false, // pac proxies disabled
    };

    const findProxyOn = evaluateCookedPac(cookPac(basePac, modsProxyOrDieOn));
    const resultOn = findProxyOn('https://must-be-proxied.example/', 'must-be-proxied.example');

    expect(resultOn).to.equal('PROXY 127.0.0.1:0');
    expect(resultOn).to.not.equal('DIRECT');

    // 2. ifUseSecureProxiesOnly filters out all insecure proxies when ProxyOrDie is ON
    const modsSecureFilterOn = {
      ifUseSecureProxiesOnly: true,
      ifProxyOrDie: true,
      ifUsePacScriptProxies: true,
    };
    const findProxySecureOn = evaluateCookedPac(cookPac(basePac, modsSecureFilterOn));

    // insecure-blocked.example only has HTTP proxy -> all proxies filtered -> must fail-closed
    const resultInsecureOn = findProxySecureOn('https://insecure-blocked.example/', 'insecure-blocked.example');
    expect(resultInsecureOn).to.equal('PROXY 127.0.0.1:0');

    // 3. With ProxyOrDie OFF, empty filtered list falls back to DIRECT
    const modsSecureFilterOff = {
      ifUseSecureProxiesOnly: true,
      ifProxyOrDie: false,
      ifUsePacScriptProxies: true,
    };
    const findProxySecureOff = evaluateCookedPac(cookPac(basePac, modsSecureFilterOff));
    const resultInsecureOff = findProxySecureOff('https://insecure-blocked.example/', 'insecure-blocked.example');
    expect(resultInsecureOff).to.equal('DIRECT');
  });

  describe('Browser-Level PAC mandatory setting (Task 1)', () => {
    let appliedProxyConfigs = [];
    let savedStorage = {};
    let controlLevel = 'controlled_by_this_extension';

    beforeEach(() => {
      appliedProxyConfigs = [];
      savedStorage = {};
      controlLevel = 'controlled_by_this_extension';
      globalThis.chrome = {
        runtime: { lastError: null },
        action: {
          setIcon: () => {},
          setTitle: () => {},
          setBadgeText: () => {},
          setBadgeBackgroundColor: () => {},
        },
        proxy: {
          settings: {
            get: (opts, cb) => {
              if (cb) {
                cb({
                  levelOfControl: controlLevel,
                  value: appliedProxyConfigs[appliedProxyConfigs.length - 1] || {},
                });
              }
            },
            set: (opts, cb) => {
              appliedProxyConfigs.push(opts.value);
              if (cb) cb();
            },
            clear: (opts, cb) => {
              appliedProxyConfigs.push({ mode: 'direct' });
              if (cb) cb();
            },
          },
        },
        storage: {
          local: {
            get: (key, cb) => {
              if (typeof key === 'string') {
                cb({ [key]: savedStorage[key] });
              } else {
                cb(Object.assign({}, savedStorage));
              }
            },
            set: (items, cb) => {
              Object.assign(savedStorage, items);
              if (cb) cb();
            },
            remove: (keys, cb) => {
              const kArr = Array.isArray(keys) ? keys : [keys];
              kArr.forEach((k) => delete savedStorage[k]);
              if (cb) cb();
            },
            clear: (cb) => {
              savedStorage = {};
              if (cb) cb();
            },
          },
        },
      };
    });

    it('1. Proxy Or Die OFF -> mandatory === false', async () => {
      const { pacSync } = await import('../src/extension-common/core/pac-sync.js');
      const { pacKitchen } = await import('../src/extension-common/core/pac-kitchen.js');

      await pacKitchen.savePacMods({ ifProxyOrDie: false });
      await pacSync.applyPacData('function FindProxyForURL(url, host) { return "DIRECT"; }');

      const lastConfig = appliedProxyConfigs[appliedProxyConfigs.length - 1];
      expect(lastConfig.mode).to.equal('pac_script');
      expect(lastConfig.pacScript.mandatory).to.be.false;
    });

    it('2. Proxy Or Die ON -> mandatory === true', async () => {
      const { pacSync } = await import('../src/extension-common/core/pac-sync.js');
      const { pacKitchen } = await import('../src/extension-common/core/pac-kitchen.js');

      await pacKitchen.savePacMods({ ifProxyOrDie: true });
      await pacSync.applyPacData('function FindProxyForURL(url, host) { return "DIRECT"; }');

      const lastConfig = appliedProxyConfigs[appliedProxyConfigs.length - 1];
      expect(lastConfig.mode).to.equal('pac_script');
      expect(lastConfig.pacScript.mandatory).to.be.true;
    });

    it('3. Changing ifProxyOrDie reapplies PAC with new mandatory value', async () => {
      const { pacSync } = await import('../src/extension-common/core/pac-sync.js');
      const { pacKitchen } = await import('../src/extension-common/core/pac-kitchen.js');

      // Start with ON
      await pacKitchen.savePacMods({ ifProxyOrDie: true });
      await pacSync.applyPacData('function FindProxyForURL(url, host) { return "DIRECT"; }');
      expect(appliedProxyConfigs[appliedProxyConfigs.length - 1].pacScript.mandatory).to.be.true;

      // Toggle to OFF
      await pacKitchen.savePacMods({ ifProxyOrDie: false });
      await pacSync.reapplyCurrentPac();
      expect(appliedProxyConfigs[appliedProxyConfigs.length - 1].pacScript.mandatory).to.be.false;

      // Toggle back to ON
      await pacKitchen.savePacMods({ ifProxyOrDie: true });
      await pacSync.reapplyCurrentPac();
      expect(appliedProxyConfigs[appliedProxyConfigs.length - 1].pacScript.mandatory).to.be.true;
    });

    it('4. Refuses to overwrite proxy settings controlled by another extension', async () => {
      const { pacSync } = await import('../src/extension-common/core/pac-sync.js');
      const { pacKitchen } = await import('../src/extension-common/core/pac-kitchen.js');

      await pacKitchen.savePacMods({ ifProxyOrDie: true });
      controlLevel = 'controlled_by_other_extensions';

      let error = null;
      try {
        await pacSync.applyPacData('function FindProxyForURL(url, host) { return "DIRECT"; }');
      } catch (err) {
        error = err;
      }

      expect(error).to.exist;
      expect(error.code).to.equal('PROXY_NOT_CONTROLLABLE');
      expect(appliedProxyConfigs).to.have.lengthOf(0);
    });
  });

  describe('Hierarchical Suffix & Wildcard PAC Exception Matching', () => {
    it('should correctly match wildcard domains and subdomains via O(1) hash hierarchy', () => {
      const mods = {
        ifMindExceptions: true,
        exceptions: {
          '*.rutracker.org': true,
          'exact-only.com': true,
          '*.direct-exception.net': false,
        },
        filteredCustomsString: 'HTTPS proxy-node.org:443',
        ifProxyOrDie: true,
        ifUsePacScriptProxies: true,
      };

      const cooked = cookPac(basePac, mods);
      const findProxy = evaluateCookedPac(cooked);

      // Root domain of wildcard
      expect(findProxy('https://rutracker.org/', 'rutracker.org')).to.equal('HTTPS proxy-node.org:443');
      // Subdomain of wildcard
      expect(findProxy('https://forum.rutracker.org/', 'forum.rutracker.org')).to.equal('HTTPS proxy-node.org:443');
      // Deep nested subdomain of wildcard
      expect(findProxy('https://sub.deep.rutracker.org/', 'sub.deep.rutracker.org')).to.equal('HTTPS proxy-node.org:443');

      // Exact domain match
      expect(findProxy('https://exact-only.com/path', 'exact-only.com')).to.equal('HTTPS proxy-node.org:443');

      // Negative wildcard match (DIRECT exception)
      expect(findProxy('https://api.direct-exception.net/', 'api.direct-exception.net')).to.equal('DIRECT');

      // Non-matching domain should fall back to original PAC (DIRECT)
      expect(findProxy('https://unrelated-domain.com/', 'unrelated-domain.com')).to.equal('DIRECT');
    });

    it('precedence: more specific wildcard rule (*.sub.example.com) takes precedence over shallower exact rule (example.com)', () => {
      const mods = {
        ifMindExceptions: true,
        exceptions: {
          'example.com': true,
          '*.sub.example.com': false,
        },
        filteredCustomsString: 'HTTPS custom-proxy.example:443',
        ifProxyOrDie: true,
        ifUsePacScriptProxies: true,
      };

      const cooked = cookPac(basePac, mods);
      const findProxy = evaluateCookedPac(cooked);

      // x.sub.example.com matches deeper wildcard *.sub.example.com (DIRECT) before shallower exact example.com
      expect(findProxy('https://x.sub.example.com/', 'x.sub.example.com')).to.equal('DIRECT');
      // other.example.com matches shallower exact example.com parent
      expect(findProxy('https://other.example.com/', 'other.example.com')).to.equal('HTTPS custom-proxy.example:443');
    });

    it('precedence: more specific exact parent rule (sub.example.com) takes precedence over shallower wildcard rule (*.example.com)', () => {
      const mods = {
        ifMindExceptions: true,
        exceptions: {
          '*.example.com': false,
          'sub.example.com': true,
        },
        filteredCustomsString: 'HTTPS custom-proxy.example:443',
        ifProxyOrDie: true,
        ifUsePacScriptProxies: true,
      };

      const cooked = cookPac(basePac, mods);
      const findProxy = evaluateCookedPac(cooked);

      // x.sub.example.com matches deeper sub.example.com (PROXIED) before shallower wildcard *.example.com (DIRECT)
      expect(findProxy('https://x.sub.example.com/', 'x.sub.example.com')).to.equal('HTTPS custom-proxy.example:443');
      // other.example.com matches shallower *.example.com (DIRECT)
      expect(findProxy('https://other.example.com/', 'other.example.com')).to.equal('DIRECT');
    });
  });
});

