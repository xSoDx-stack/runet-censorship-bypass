'use strict';

import { expect } from 'chai';
import vm from 'vm';
import { cookPac } from '../src/extension-common/core/pac-kitchen.js';

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
});
