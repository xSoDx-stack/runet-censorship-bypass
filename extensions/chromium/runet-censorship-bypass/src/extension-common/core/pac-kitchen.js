'use strict';

import { storage } from './storage.js';
import { utils } from './utils.js';
import {
  buildProxyCredentialsMap,
  commitProxyCredentials,
  setupAuthListener,
  initProxyAuth,
} from './proxy-auth.js';

const KITCHEN_STARTS_MARK = '\n\n//%#@@@@@@ PAC_KITCHEN_STARTS @@@@@@#%';
const MODS_KEY = 'pac-kitchen-mods';

export { setupAuthListener, initProxyAuth };

export function matchExceptionDomain(host, exceptions = {}) {
  if (!host || !exceptions || typeof exceptions !== 'object') return { matched: false };
  host = host.toLowerCase().trim();

  // 1. Direct exact match
  if (Object.prototype.hasOwnProperty.call(exceptions, host)) {
    return {
      matched: true,
      ruleKey: host,
      isProxied: exceptions[host] === true,
      isExact: true,
    };
  }

  // 2. Exact wildcard match
  const exactWild = `*.${host}`;
  if (Object.prototype.hasOwnProperty.call(exceptions, exactWild)) {
    return {
      matched: true,
      ruleKey: exactWild,
      isProxied: exceptions[exactWild] === true,
      isExact: true,
    };
  }

  // 3. Parent domain suffix matches
  const parts = host.split('.');
  for (let i = 1; i < parts.length; i++) {
    const parent = parts.slice(i).join('.');
    const parentWild = `*.${parent}`;
    if (Object.prototype.hasOwnProperty.call(exceptions, parentWild)) {
      return {
        matched: true,
        ruleKey: parentWild,
        isProxied: exceptions[parentWild] === true,
        isExact: false,
      };
    }
    if (Object.prototype.hasOwnProperty.call(exceptions, parent)) {
      return {
        matched: true,
        ruleKey: parent,
        isProxied: exceptions[parent] === true,
        isExact: false,
      };
    }
  }

  return { matched: false };
}

export function getDefaultConfigs() {
  return {
    ifProxyHttpsUrlsOnly: {
      dflt: false,
      label: 'проксировать только HTTP<em>S</em>-сайты',
      desc: 'Проксировать только сайты, доступные по шифрованному протоколу HTTPS. Прокси и провайдер смогут видеть только адреса проксируемых HTTPS-сайтов, но не их содержимое.',
      order: 0,
      category: 'general',
    },
    ifUseSecureProxiesOnly: {
      dflt: false,
      label: 'только шифрованная связь с прокси',
      desc: 'Шифровать соединение до прокси от провайдера, используя только прокси типа HTTPS или локальный Tor.',
      order: 1,
      category: 'general',
    },
    ifProhibitDns: {
      dflt: false,
      label: 'запретить определение по IP/DNS',
      desc: 'Запрещает скрипту использовать DNS в браузере для проверки IP-адресов.',
      order: 2,
      category: 'general',
    },
    ifProxyOrDie: {
      dflt: true,
      ifDfltMods: true,
      label: 'проксируй или умри!',
      desc: 'Запрещает прямое соединение без прокси в случаях, когда прокси отказывает.',
      order: 3,
      category: 'general',
    },
    ifUsePacScriptProxies: {
      dflt: true,
      category: 'ownProxies',
      label: 'использовать прокси PAC-скрипта',
      desc: 'Использовать официальные прокси-сервера от авторов PAC-скрипта.',
      order: 4,
    },
    ifUseLocalTor: {
      dflt: false,
      category: 'ownProxies',
      label: 'использовать СВОЙ локальный Tor',
      desc: 'Использовать локально установленный Tor (SOCKS5 127.0.0.1:9150 / 9050) в качестве прокси.',
      order: 5,
    },
    ifUseLocalWarp: {
      dflt: false,
      category: 'ownProxies',
      label: 'использовать WARP как прокси',
      desc: 'Использовать локальный Cloudflare WARP (SOCKS5 / HTTPS localhost:40000).',
      order: 5.5,
    },
    exceptions: {
      dflt: null,
      category: 'exceptions',
    },
    ifMindExceptions: {
      dflt: true,
      category: 'exceptions',
      label: 'учитывать исключения',
      desc: 'Учитывать сайты, добавленные вручную (списки включений и исключений).',
      order: 6,
    },
    whitelist: {
      dflt: [],
      category: 'exceptions',
    },
    ifMindWhitelist: {
      dflt: false,
      category: 'exceptions',
      label: 'Ограничиться только белым списком',
      desc: 'Разрешить расширению работать только с адресами из белого списка.',
      order: 6.5,
    },
    ifUseOwnProxiesOnlyForOwnSites: {
      dflt: false,
      category: 'ownProxies',
      label: 'использовать СВОИ прокси только для СВОИХ сайтов',
      desc: 'Использовать свои прокси только для сайтов, добавленных в список вручную.',
      order: 7,
    },
    customProxyStringRaw: {
      dflt: '',
      category: 'ownProxies',
      order: 8,
    },
    ifProxyMoreDomains: {
      dflt: false,
      category: 'general',
      label: 'проксировать также .onion, .i2p, OpenNIC',
      desc: 'Проксировать сайты в зонах альтернативных сетей (OpenNIC, EmerCoin, I2P, Tor).',
      order: 8.5,
    },
    replaceDirectWith: {
      dflt: '',
      category: 'general',
      label: 'заменить DIRECT на',
      desc: 'Использовать указанную строку вместо DIRECT для неблокируемых запросов.',
      order: 9,
    },
  };
}

export function getDefaults() {
  const configs = getDefaultConfigs();
  return Object.keys(configs).reduce((acc, key) => {
    acc[key] = configs[key].dflt;
    return acc;
  }, {});
}

export function createPacModifiers(mods = {}) {
  mods = mods || {};
  const configs = getDefaultConfigs();
  const ifNoMods = Object.keys(configs).every((dProp) => {
    const ifDflt = !(dProp in mods && Boolean(configs[dProp].dflt) !== Boolean(mods[dProp]));
    const ifMods = configs[dProp].ifDfltMods;
    return ifDflt ? !ifMods : ifMods;
  });

  const defaults = getDefaults();
  const self = {
    ifProxyHttpsUrlsOnly: mods.ifProxyHttpsUrlsOnly !== undefined ? Boolean(mods.ifProxyHttpsUrlsOnly) : defaults.ifProxyHttpsUrlsOnly,
    ifUseSecureProxiesOnly: mods.ifUseSecureProxiesOnly !== undefined ? Boolean(mods.ifUseSecureProxiesOnly) : defaults.ifUseSecureProxiesOnly,
    ifProhibitDns: mods.ifProhibitDns !== undefined ? Boolean(mods.ifProhibitDns) : defaults.ifProhibitDns,
    ifProxyOrDie: mods.ifProxyOrDie !== undefined ? Boolean(mods.ifProxyOrDie) : defaults.ifProxyOrDie,
    ifUsePacScriptProxies: mods.ifUsePacScriptProxies !== undefined ? Boolean(mods.ifUsePacScriptProxies) : defaults.ifUsePacScriptProxies,
    ifUseLocalTor: Boolean(mods.ifUseLocalTor),
    ifUseLocalWarp: Boolean(mods.ifUseLocalWarp),
    ifMindExceptions: mods.ifMindExceptions !== false,
    ifMindWhitelist: Boolean(mods.ifMindWhitelist),
    ifUseOwnProxiesOnlyForOwnSites: Boolean(mods.ifUseOwnProxiesOnlyForOwnSites),
    customProxyStringRaw: mods.customProxyStringRaw || '',
    ifProxyMoreDomains: Boolean(mods.ifProxyMoreDomains),
    replaceDirectWith: mods.replaceDirectWith || '',
    exceptions: mods.exceptions || {},
    whitelist: mods.whitelist || [],
    ifNoMods,
  };

  let customProxyArray = [];
  if (self.customProxyStringRaw) {
    customProxyArray = self.customProxyStringRaw
      .replace(/#.*$/gm, '')
      .split(/(?:\s*(?:;\r?\n)+\s*|\r?\n+|;\s*)+/g)
      .map((p) => p.trim())
      .filter((p) => p && /\s+/g.test(p));
    if (self.ifUseSecureProxiesOnly) {
      customProxyArray = customProxyArray.filter((pStr) => /^HTTPS\s/i.test(pStr));
    }
  }

  if (self.ifUseLocalWarp) {
    self.warpPoints = ['SOCKS5 localhost:40000', 'HTTPS localhost:40000'];
    customProxyArray.push(...self.warpPoints);
  }
  if (self.ifUseLocalTor) {
    self.torPoints = ['SOCKS5 localhost:9150', 'SOCKS5 localhost:9050'];
    customProxyArray.push(...self.torPoints);
  }

  // Handle and sanitize protected proxies (strip user:pass@ for PAC compatibility and normalize HTTP -> PROXY)
  customProxyArray = customProxyArray.map((proxyScheme) => {
    let scheme = proxyScheme;
    if (scheme.includes('@')) {
      const proxy = utils.parseProxyScheme(scheme);
      let proto = proxy.type.toUpperCase();
      if (proto === 'HTTP') proto = 'PROXY';
      else if (proto === 'SOCKS4') proto = 'SOCKS';
      return `${proto} ${proxy.hostname}:${proxy.port || '443'}`;
    }
    const parts = scheme.split(/\s+/);
    if (parts[0] && parts[0].toUpperCase() === 'HTTP') {
      return `PROXY ${parts.slice(1).join(' ')}`;
    }
    return scheme;
  });

  self.filteredCustomsString = '';
  if (customProxyArray.length) {
    self.customProxyArray = customProxyArray;
    self.filteredCustomsString = customProxyArray.join('; ');
  } else {
    if (!self.ifUsePacScriptProxies) {
      return [new TypeError('Нет ни одного прокси, удовлетворяющего вашим требованиям!')];
    }
    self.customProxyArray = false;
  }

  self.included = [];
  self.excluded = [];
  if (self.ifProxyMoreDomains) {
    self.moreDomains = [
      'onion', 'i2p',
      'bbs', 'chan', 'dyn', 'free', 'geek', 'gopher', 'indy',
      'libre', 'neo', 'null', 'o', 'oss', 'oz', 'parody', 'pirate',
      'bazar', 'bit', 'coin', 'emc', 'fur', 'ku', 'lib', 'te', 'ti', 'uu'
    ];
  }

  return [null, self];
}

export function cookPac(pacData, pacMods) {
  if (!pacData) return '';
  pacData = pacData.replace(new RegExp(KITCHEN_STARTS_MARK + '[\\s\\S]*$', 'g'), '').trim();

  if (pacMods.ifNoMods) {
    return pacData;
  }

  let generatedPac = `${KITCHEN_STARTS_MARK}
;(function(global) {
  "use strict";
  const originalFindProxyForURL = typeof FindProxyForURL === 'function' ? FindProxyForURL : function() { return "DIRECT"; };
  let tmp = function(url, host) {
    const dotHost = '.' + host;
`;

  if (pacMods.ifMindWhitelist && pacMods.whitelist && pacMods.whitelist.length) {
    generatedPac += `
    const ifWhitelisted = ${JSON.stringify(pacMods.whitelist)}.some((whiteHost) => {
      const clean = whiteHost.replace(/^\\*\\.?/, '').replace(/^\\./, '');
      return dotHost.endsWith('.' + clean);
    });
    if (!ifWhitelisted) {
      return 'DIRECT';
    }
`;
  }

  if (pacMods.ifProhibitDns) {
    generatedPac += `
    global.dnsResolve = function(h) { return null; };
`;
  }

  if (pacMods.ifProxyHttpsUrlsOnly) {
    generatedPac += `
    if (!url.startsWith("https")) {
      return "DIRECT";
    }
`;
  }

  if (pacMods.ifUseLocalTor && pacMods.torPoints) {
    generatedPac += `
    if (host.endsWith(".onion")) {
      return ${JSON.stringify(pacMods.torPoints.join('; '))};
    }
`;
  }

  const ifProxyOrDie = Boolean(pacMods.ifProxyOrDie);
  const failClosedProxy = 'PROXY 127.0.0.1:0';

  generatedPac += `
    const failClosedProxy = ${JSON.stringify(failClosedProxy)};
    const ifProxyOrDie = ${ifProxyOrDie};
    const directIfAllowed = ifProxyOrDie ? "" : "DIRECT";
    const filteredCustomProxies = ${JSON.stringify(pacMods.filteredCustomsString || '')};

    function formatProxyChain(proxyList, isRouteMustProxy) {
      const allDirectives = [];
      (proxyList || []).forEach(function(item) {
        if (!item) return;
        item.split(/(?:\\s*;\\s*)+/g).forEach(function(p) {
          const trimmed = (p || '').trim();
          if (trimmed && !/^DIRECT$/i.test(trimmed)) {
            allDirectives.push(trimmed);
          }
        });
      });

      if (allDirectives.length === 0) {
        if (isRouteMustProxy) {
          return ifProxyOrDie ? failClosedProxy : "DIRECT";
        }
        return "DIRECT";
      }

      if (ifProxyOrDie) {
        return allDirectives.join("; ");
      } else {
        return allDirectives.join("; ") + "; DIRECT";
      }
    }

    function getCustomProxiedDestination(url, host) {
      const list = [];
      if (filteredCustomProxies) {
        list.push(filteredCustomProxies);
      }
      ${pacMods.ifUsePacScriptProxies && !pacMods.ifUseOwnProxiesOnlyForOwnSites ? `
      const pacRes = originalFindProxyForURL(url, host);
      if (pacRes && !/^DIRECT$/i.test(pacRes.trim())) {
        ${pacMods.ifUseSecureProxiesOnly ? `
        const secureOnly = pacRes.split(/(?:\\s*;\\s*)+/g).filter(function(pStr) { return /^HTTPS\\s/i.test(pStr.trim()); });
        if (secureOnly.length) list.push(secureOnly.join("; "));
        ` : `
        list.push(pacRes);
        `}
      }
      ` : ''}
      return formatProxyChain(list, true);
    }
`;

  let finalExceptions = {};
  if (pacMods.ifProxyMoreDomains && pacMods.moreDomains) {
    finalExceptions = pacMods.moreDomains.reduce((acc, tld) => {
      acc['*.' + tld] = true;
      return acc;
    }, finalExceptions);
  }
  if (pacMods.ifMindExceptions && pacMods.exceptions) {
    Object.assign(finalExceptions, pacMods.exceptions);
  }

  const ifExceptions = Object.keys(finalExceptions).length;
  if (ifExceptions) {
    const exactMap = {};
    const wildMap = {};

    for (const key in finalExceptions) {
      if (Object.prototype.hasOwnProperty.call(finalExceptions, key)) {
        const isProxy = Boolean(finalExceptions[key]);
        const clean = key.toLowerCase().trim();
        if (clean.startsWith('*.')) {
          wildMap[clean.slice(2)] = isProxy ? 1 : 0;
        } else if (clean.startsWith('.')) {
          wildMap[clean.slice(1)] = isProxy ? 1 : 0;
        } else {
          exactMap[clean] = isProxy ? 1 : 0;
        }
      }
    }

    generatedPac += `
    /* EXCEPTIONS - Instant O(1) Hash Map Hierarchy
     * При конфликте между exact- и wildcard-правилами на разных уровнях домена
     * побеждает более специфичное (более глубокое) правило — независимо от того,
     * exact оно или wildcard. Например:
     * - при exact-правиле 'example.com' и wildcard-правиле '*.sub.example.com',
     *   для хоста 'x.sub.example.com' побеждает '*.sub.example.com' (более специфичное).
     * - при wildcard-правиле '*.example.com' и exact-правиле 'sub.example.com',
     *   для хоста 'x.sub.example.com' побеждает 'sub.example.com' (более специфичное).
     */
    const excExact = ${JSON.stringify(exactMap)};
    const excWild = ${JSON.stringify(wildMap)};

    // 1. Direct hostname exact or wildcard match
    if (excExact[host] !== undefined) {
      return excExact[host] === 1 ? getCustomProxiedDestination(url, host) : "DIRECT";
    }
    if (excWild[host] !== undefined) {
      return excWild[host] === 1 ? getCustomProxiedDestination(url, host) : "DIRECT";
    }

    // 2. Parent domain suffix lookups (O(k) where k is domain depth)
    const hostParts = host.split('.');
    for (let pIdx = 1; pIdx < hostParts.length; pIdx++) {
      const parentDomain = hostParts.slice(pIdx).join('.');
      if (excWild[parentDomain] !== undefined) {
        return excWild[parentDomain] === 1 ? getCustomProxiedDestination(url, host) : "DIRECT";
      }
      if (excExact[parentDomain] !== undefined) {
        return excExact[parentDomain] === 1 ? getCustomProxiedDestination(url, host) : "DIRECT";
      }
    }
`;
  }

  generatedPac += `
    const pacRes = originalFindProxyForURL(url, host);
    if (!pacRes || /^DIRECT$/i.test(pacRes.trim())) {
      return "DIRECT";
    }

    const candidates = [];
    ${pacMods.filteredCustomsString && !pacMods.ifUseOwnProxiesOnlyForOwnSites ? `
    candidates.push(filteredCustomProxies);
    ` : ''}

    ${pacMods.ifUsePacScriptProxies ? `
      ${pacMods.ifUseSecureProxiesOnly ? `
      const securePac = pacRes.split(/(?:\\s*;\\s*)+/g).filter(function(pStr) { return /^HTTPS\\s/i.test(pStr.trim()); });
      if (securePac.length) candidates.push(securePac.join("; "));
      ` : `
      candidates.push(pacRes);
      `}
    ` : ''}

    return formatProxyChain(candidates, true);
  };
`;

  if (pacMods.replaceDirectWith) {
    const directReplacementJson = JSON.stringify(pacMods.replaceDirectWith);
    generatedPac += `
  const directReplacement = ${directReplacementJson};
  const oldTmp = tmp;
  tmp = function(url, host) {
    const res = oldTmp.call(this, url, host);
    if (typeof res !== 'string') return res;
    return res.replace(/(;|^)\\s*DIRECT\\s*(?=;|$)/g, function(match, p1) {
      return (p1 ? p1 + " " : "") + directReplacement;
    });
  };
`;
  }

  generatedPac += `
  if (typeof global !== 'undefined') {
    global.FindProxyForURL = tmp;
  }
  if (typeof self !== 'undefined') {
    self.FindProxyForURL = tmp;
  }
})(this);
`;

  return pacData + generatedPac;
}

// In-memory cache for ultra-fast O(1) reads without disk LevelDB deserialization
let _cachedRawMods = null;
let _cachedParsedMods = null;
let _cachedStats = null;

export function calculateExceptionStats(exceptions = {}, whitelist = []) {
  let includedCount = 0;
  let excludedCount = 0;
  if (exceptions && typeof exceptions === 'object') {
    const keys = Object.keys(exceptions);
    for (let i = 0; i < keys.length; i++) {
      const val = exceptions[keys[i]];
      if (val === true) includedCount++;
      else if (val === false) excludedCount++;
    }
  }
  const whitelistCount = (whitelist && whitelist.length) || 0;
  return { includedCount, excludedCount, whitelistCount };
}

// NOTE: getExceptionStats intentionally does NOT cache — use pacKitchen.getCachedStats()
// for the cached version. This function is a pure alias for calculateExceptionStats.
export function getExceptionStats(exceptions = {}, whitelist = []) {
  return calculateExceptionStats(exceptions, whitelist);
}

let _mutationQueue = Promise.resolve();

/**
 * P1-2: Serialized mutation queue for PAC settings.
 * Ensures concurrent modifications (UI toggles, imports, single exception adds)
 * execute strictly sequentially without lost updates or race conditions.
 *
 * @param {(currentRawMods: object) => (object | Promise<object>)} mutator
 * @returns {Promise<object>}
 */
export function updatePacMods(mutator) {
  if (typeof mutator !== 'function') {
    return Promise.reject(new TypeError('mutator must be a function'));
  }

  const run = async () => {
    let currentRaw = _cachedRawMods;
    if (!currentRaw) {
      currentRaw = await storage.get(MODS_KEY, {});
      _cachedRawMods = currentRaw;
    }
    // Deep clone state to prevent mutators from mutating shared cache directly
    const cloned = JSON.parse(JSON.stringify(currentRaw || {}));
    const mutated = await mutator(cloned);
    if (!mutated || typeof mutated !== 'object') {
      throw new Error('mutator must return an object');
    }
    return pacKitchen.savePacMods(mutated);
  };

  const next = _mutationQueue.then(run, run);
  _mutationQueue = next.catch(() => {});
  return next;
}

export const pacKitchen = {
  async getPacMods() {
    if (_cachedParsedMods) {
      return _cachedParsedMods;
    }
    const [rawMods, savedStats] = await Promise.all([
      storage.get(MODS_KEY, {}),
      storage.get('pac-exception-stats', null),
    ]);
    _cachedRawMods = rawMods;
    const newCredsMap = buildProxyCredentialsMap(rawMods.customProxyStringRaw || '');
    commitProxyCredentials(newCredsMap);
    const [, mods] = createPacModifiers(rawMods);
    _cachedParsedMods = mods || getDefaults();
    if (savedStats && typeof savedStats === 'object' && savedStats.includedCount !== undefined) {
      _cachedStats = savedStats;
    } else {
      _cachedStats = calculateExceptionStats(rawMods.exceptions, rawMods.whitelist);
      storage.set('pac-exception-stats', _cachedStats).catch(() => {});
    }
    return _cachedParsedMods;
  },

  async getRawPacMods() {
    if (_cachedRawMods) {
      return _cachedRawMods;
    }
    const rawMods = await storage.get(MODS_KEY, {});
    _cachedRawMods = rawMods;
    return rawMods;
  },

  /**
   * P1-3: Persist-first savePacMods with transactional credentials consistency.
   * Validates input, persists all storage items, and ONLY updates RAM caches if storage write succeeds.
   */
  async savePacMods(newMods) {
    const [err, parsedMods] = createPacModifiers(newMods);
    if (err) {
      throw err;
    }
    const newStats = calculateExceptionStats(newMods.exceptions, newMods.whitelist);
    const newCredsMap = buildProxyCredentialsMap(newMods.customProxyStringRaw || '');

    // 1. Persist ALL storage records FIRST
    await Promise.all([
      storage.set('proxy-credentials-map', newCredsMap),
      storage.set(MODS_KEY, newMods),
      storage.set('pac-exception-stats', newStats),
    ]);

    // 2. Only on success, publish to in-memory caches
    _cachedRawMods = newMods;
    _cachedParsedMods = parsedMods;
    _cachedStats = newStats;
    commitProxyCredentials(newCredsMap);

    return parsedMods;
  },

  updatePacMods,

  getCachedStats() {
    if (_cachedStats) return _cachedStats;
    if (_cachedParsedMods) {
      _cachedStats = calculateExceptionStats(_cachedParsedMods.exceptions, _cachedParsedMods.whitelist);
      return _cachedStats;
    }
    return { includedCount: 0, excludedCount: 0, whitelistCount: 0 };
  },

  invalidateCache() {
    _cachedRawMods = null;
    _cachedParsedMods = null;
    _cachedStats = null;
  },

  // P0.3: Public accessor for block-informer and other consumers needing sync access to parsed mods
  getCachedMods() {
    return _cachedParsedMods;
  },

  getDefaults() {
    return createPacModifiers({})[1];
  },

  cook: cookPac,
};
