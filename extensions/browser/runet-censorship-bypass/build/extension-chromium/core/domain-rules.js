'use strict';

const IPV4_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const HOST_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function validIpv4(host) {
  return IPV4_RE.test(host) && host.split('.').every((part) => Number(part) <= 255);
}

export function normalizeDomainRule(input, { allowWildcard = true } = {}) {
  if (typeof input !== 'string') return { valid: false, error: 'Домен должен быть строкой' };
  let value = input.trim().toLowerCase();
  if (!value) return { valid: false, error: 'Введите домен' };

  const wildcard = allowWildcard && (value.startsWith('*.') || value.startsWith('.'));
  value = value.replace(/^\*\./, '').replace(/^\./, '');
  try {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : 'https://' + value;
    const parsed = new URL(withScheme);
    if (parsed.username || parsed.password) {
      return { valid: false, error: 'Домен не должен содержать логин или пароль' };
    }
    value = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  } catch {
    return { valid: false, error: 'Некорректный домен' };
  }

  if (!value || value === 'localhost' || (!validIpv4(value) && !HOST_RE.test(value))) {
    return { valid: false, error: 'Некорректный домен или IP-адрес' };
  }
  return { valid: true, domain: wildcard ? '*.' + value : value };
}

export function parseDomainRuleLines(lines) {
  const values = Array.isArray(lines) ? lines : String(lines || '').split(/\r?\n/);
  const domains = new Set();
  const errors = [];
  values.forEach((line, index) => {
    let clean = String(line).replace(/^[\s\u00A0\u200B-\u200D\uFEFF\u3000]+|[\s\u00A0\u200B-\u200D\uFEFF\u3000]+$/g, '');
    if (!clean || /^(?:#|\/\/|;|!|--|=+$)/.test(clean)) return;
    clean = clean.replace(/\s+(?:#|\/\/|;|!).*$/, '').trim();
    if (!clean) return;
    const result = normalizeDomainRule(clean);
    if (result.valid) domains.add(result.domain);
    else errors.push({ line: index + 1, value: clean, error: result.error });
  });
  return { validDomains: [...domains], skippedCount: errors.length, errors };
}

export function sanitizeRuleCollections(exceptions = {}, whitelist = []) {
  const safeExceptions = {};
  if (exceptions && typeof exceptions === 'object' && !Array.isArray(exceptions)) {
    for (const [key, value] of Object.entries(exceptions)) {
      const normalized = normalizeDomainRule(key);
      if (normalized.valid && (value === true || value === false)) {
        safeExceptions[normalized.domain] = value;
      }
    }
  }
  const safeWhitelist = parseDomainRuleLines(Array.isArray(whitelist) ? whitelist : []).validDomains;
  return { exceptions: safeExceptions, whitelist: safeWhitelist };
}
