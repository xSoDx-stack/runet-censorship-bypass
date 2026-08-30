'use strict';

import { expect } from 'chai';
import { utils } from '../src/extension-common/core/utils.js';
import { PAC_PROVIDERS } from '../src/extension-common/core/pac-sync.js';
import { pacKitchen } from '../src/extension-common/core/pac-kitchen.js';

// Setup chrome mock for node tests
let mockStorage = {};

globalThis.chrome = {
  runtime: { lastError: null },
  storage: {
    local: {
      get: (key, cb) => {
        if (key === null || key === undefined) {
          cb(Object.assign({}, mockStorage));
        } else if (typeof key === 'string') {
          cb({ [key]: mockStorage[key] });
        } else {
          cb(Object.assign({}, mockStorage));
        }
      },
      set: (items, cb) => {
        Object.assign(mockStorage, items);
        if (cb) cb();
      },
      remove: (keys, cb) => {
        const kArr = Array.isArray(keys) ? keys : [keys];
        kArr.forEach((k) => delete mockStorage[k]);
        if (cb) cb();
      },
    },
  },
  proxy: {
    settings: {
      get: (opts, cb) => {
        cb({ levelOfControl: 'controlled_by_this_extension' });
      },
      set: (config, cb) => {
        if (cb) cb();
      },
      clear: (opts, cb) => {
        if (cb) cb();
      },
    },
  },
  action: {
    setIcon: (opts, cb) => { if (cb) cb(); },
    setTitle: (opts, cb) => { if (cb) cb(); },
  },
  alarms: {
    get: (name, cb) => { if (cb) cb(null); },
    create: () => {},
  },
};

describe('Custom PAC URL Pipeline and Validation', () => {
  beforeEach(async () => {
    mockStorage = {};
    await pacKitchen.savePacMods(pacKitchen.getDefaults());
  });

  describe('URL Validation Rules (utils.validatePacUrl)', () => {
    it('should accept valid HTTPS and HTTP PAC URLs', () => {
      const httpsRes = utils.validatePacUrl('https://mycompany.com/proxy.pac');
      expect(httpsRes.valid).to.be.true;
      expect(httpsRes.sanitizedUrl).to.equal('https://mycompany.com/proxy.pac');
      expect(httpsRes.isHttp).to.be.false;

      const httpRes = utils.validatePacUrl('http://192.168.1.100:8080/wpad.dat');
      expect(httpRes.valid).to.be.true;
      expect(httpRes.isHttp).to.be.true;

      const publicHttp = utils.validatePacUrl('http://example.com/proxy.pac');
      expect(publicHttp.valid).to.be.false;
      expect(publicHttp.error).to.include('Небезопасный http: заблокирован');
    });

    it('should reject dangerous or unsupported protocols (javascript, data, file, chrome)', () => {
      expect(utils.validatePacUrl('javascript:alert(1)').valid).to.be.false;
      expect(utils.validatePacUrl('data:application/x-ns-proxy-autoconfig,alert(1)').valid).to.be.false;
      expect(utils.validatePacUrl('file:///C:/proxy.pac').valid).to.be.false;
      expect(utils.validatePacUrl('chrome://settings').valid).to.be.false;
      expect(utils.validatePacUrl('blob:https://example.com/123').valid).to.be.false;
    });

    it('should strictly reject URLs containing embedded credentials', () => {
      const res = utils.validatePacUrl('https://admin:secret123@proxy.example.com/test.pac');
      expect(res.valid).to.be.false;
      expect(res.error).to.include('логин и пароль');
    });

    it('should reject empty or malformed strings', () => {
      expect(utils.validatePacUrl('').valid).to.be.false;
      expect(utils.validatePacUrl('not a url').valid).to.be.false;
      expect(utils.validatePacUrl(null).valid).to.be.false;
    });

    it('should revalidate redirect targets and block HTTPS downgrade', () => {
      expect(utils.validatePacResponseUrl(
        'https://example.com/proxy.pac',
        'https://cdn.example.com/proxy.pac'
      ).valid).to.be.true;

      const downgrade = utils.validatePacResponseUrl(
        'https://example.com/proxy.pac',
        'http://127.0.0.1/proxy.pac'
      );
      expect(downgrade.valid).to.be.false;
      expect(downgrade.error).to.include('HTTPS');

      expect(utils.validatePacResponseUrl(
        'http://192.168.1.10/proxy.pac',
        'http://192.168.1.11/proxy.pac'
      ).valid).to.be.true;

      expect(utils.validatePacResponseUrl(
        'http://192.168.1.10/proxy.pac',
        'http://public.example/proxy.pac'
      ).valid).to.be.false;
    });
  });

  describe('PAC Pipeline Integration: Cooking & User Exceptions', () => {
    it('should pass custom PAC through pacKitchen and apply user custom sites and proxies', async () => {
      const rawCustomPac = `
function FindProxyForURL(url, host) {
  if (host === 'corp-internal.net') return 'PROXY internal.proxy:3128';
  return 'DIRECT';
}
`;
      // User has custom exceptions and custom proxy
      const mods = Object.assign({}, pacKitchen.getDefaults(), {
        ifMindExceptions: true,
        exceptions: {
          'rutracker.org': true,
          'my-direct.com': false,
        },
        filteredCustomsString: 'HTTPS user-node.net:443',
        ifProxyOrDie: true,
      });

      const cooked = pacKitchen.cook(rawCustomPac, mods);

      // Verify that cooked PAC contains both base logic, user exceptions, and fail-closed Proxy Or Die
      expect(cooked).to.include('FindProxyForURL');
      expect(cooked).to.include('rutracker.org');
      expect(cooked).to.include('HTTPS user-node.net:443');
      expect(cooked).to.include('PROXY 127.0.0.1:0');
    });

    it('should preserve customPacUrl in PAC_PROVIDERS registry', () => {
      expect(PAC_PROVIDERS.customPacUrl).to.exist;
      expect(PAC_PROVIDERS.customPacUrl.distinctKey).to.equal('customPacUrl');
      expect(PAC_PROVIDERS.customPacUrl.order).to.equal(3);
      expect(PAC_PROVIDERS.customPacUrl.maxBytes).to.equal(undefined);
      expect(PAC_PROVIDERS['Антицензорити'].maxBytes).to.be.greaterThan(11642139);
      expect(PAC_PROVIDERS['Антизапрет'].maxBytes).to.equal(PAC_PROVIDERS['Антицензорити'].maxBytes);
    });
  });
});
