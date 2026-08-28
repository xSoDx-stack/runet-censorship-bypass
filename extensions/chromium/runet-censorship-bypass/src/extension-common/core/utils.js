'use strict';

export const utils = {
  checkChromeError() {
    const err = chrome.runtime.lastError;
    if (!err) return null;
    console.warn('API returned error:', err);
    return new Error(err.message);
  },

  areSettingsControllableFor(details) {
    if (!details || !details.levelOfControl) return false;
    return details.levelOfControl.endsWith('this_extension');
  },

  areSettingsControlledFor(details) {
    if (!details || !details.levelOfControl) return false;
    return details.levelOfControl.startsWith('controlled_by_this');
  },

  messages: {
    searchSettingsForUrl(niddle) {
      return 'chrome://settings/?search=' + (chrome.i18n.getMessage(niddle) || niddle);
    },

    whichExtensionHtml() {
      return chrome.i18n.getMessage('noControl') +
        ` <a href="${this.searchSettingsForUrl('proxy')}">${chrome.i18n.getMessage('WhichQ')}</a>`;
    },
  },

  parseProxyScheme(proxyAsStringRaw) {
    const proxyAsString = (proxyAsStringRaw || '').trim();
    const [type] = proxyAsString.split(/\s+/);
    // P2.2: Escape regex special chars in type to prevent broken RegExp if type contains meta chars
    const escapedType = (type || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const typeRe = new RegExp(`^${escapedType}\\s+`, 'g');
    const crededAddr = proxyAsString.replace(typeRe, '');

    const parts = crededAddr.split('@');
    const creds = parts.slice(0, -1).join('@');
    const addr = parts[parts.length - 1] || '';

    // P2-7 fix: support IPv6 addresses like [::1]:8080.
    // Simple split(':') breaks on IPv6 → use regex that handles both [ipv6]:port and host:port
    const addrMatch = addr.match(/^(\[.+\]|[^:]+):(\d+)$/);
    const hostname = addrMatch ? addrMatch[1] : addr;
    const port = addrMatch ? addrMatch[2] : '';
    let username = '';
    let password = '';

    if (creds) {
      const credParts = creds.split(':');
      const rawUser = credParts[0] || '';
      const rawPass = credParts.slice(1).join(':') || '';
      try {
        username = decodeURIComponent(rawUser);
      } catch {
        username = rawUser;
      }
      try {
        password = decodeURIComponent(rawPass);
      } catch {
        password = rawPass;
      }
    }

    return {
      type: (type || 'HTTPS').toUpperCase(),
      username,
      password,
      hostname: (hostname || '').trim(),
      port: (port || '').trim(),
      creds,
    };
  },

  validatePacUrl(urlStr) {
    if (!urlStr || typeof urlStr !== 'string' || !urlStr.trim()) {
      return { valid: false, error: 'Введите адрес ссылки на PAC-скрипт' };
    }
    const cleanUrl = urlStr.trim();
    let parsed;
    try {
      parsed = new URL(cleanUrl);
    } catch {
      return { valid: false, error: 'Некорректный формат URL адреса' };
    }

    const proto = (parsed.protocol || '').toLowerCase();
    if (proto !== 'https:' && proto !== 'http:') {
      return {
        valid: false,
        error: `Недопустимый протокол: ${proto}. Разрешены только https: и http:`,
      };
    }

    if (parsed.username || parsed.password) {
      return {
        valid: false,
        error: 'URL не должен содержать встроенный логин и пароль (user:password@)',
      };
    }

    return {
      valid: true,
      sanitizedUrl: parsed.href,
      isHttp: proto === 'http:',
      hostname: parsed.hostname,
    };
  },

  errors: {
    handleResponseError(res) {
      return new Error(`Response error: HTTP ${res.status}`);
    },
  },
};

/**
 * P1-2 fix: Shared domain file validator extracted from options/app.js and exceptions/index.js.
 * Safely parses and validates domains from an uploaded File object.
 * @param {File} file
 * @returns {Promise<{validDomains: string[], skippedCount: number}>}
 */
export async function parseAndValidateDomainFile(file) {
  if (!file) {
    throw new Error('Файл не выбран');
  }

  const fileName = (file.name || '').toLowerCase();
  const ext = fileName.includes('.') ? fileName.split('.').pop() : '';
  const dangerousExts = [
    'exe', 'dll', 'bin', 'zip', 'rar', '7z', 'tar', 'gz', 'iso', 'pdf',
    'png', 'jpg', 'jpeg', 'gif', 'webp', 'mp4', 'mp3', 'avi', 'mkv',
    'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'apk', 'dmg', 'class',
    'jar', 'dat', 'db', 'sqlite',
  ];

  if (ext && dangerousExts.includes(ext)) {
    throw new Error(
      `Файл имеет неподдерживаемый формат (.${ext}). Поддерживаются только текстовые файлы (.txt) со списком доменов.`
    );
  }

  const MAX_SIZE = 5 * 1024 * 1024;
  if (file.size > MAX_SIZE) {
    throw new Error(
      `Файл слишком большой (${(file.size / (1024 * 1024)).toFixed(1)} МБ). Максимальный размер текстового файла: 5 МБ.`
    );
  }

  let rawText = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    const timer = setTimeout(() => {
      reader.abort();
      reject(new Error('Превышено время чтения файла'));
    }, 15000);

    reader.onload = () => { clearTimeout(timer); resolve(reader.result); };
    reader.onerror = () => { clearTimeout(timer); reject(new Error('Не удалось прочитать файл')); };
    reader.onabort = () => { clearTimeout(timer); reject(new Error('Чтение файла прервано')); };

    reader.readAsText(file, 'UTF-8');
  });

  if (typeof rawText !== 'string') {
    throw new Error('Не удалось декодировать содержимое файла');
  }

  if (rawText.charCodeAt(0) === 0xFEFF) {
    rawText = rawText.slice(1);
  }

  if (!rawText.trim()) {
    throw new Error('Файл пуст или содержит только пробелы');
  }

  const sample = rawText.slice(0, 8192);
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(sample)) {
    throw new Error(
      'Файл содержит нечитаемые бинарные данные. Поддерживаются только текстовые файлы (.txt) в кодировке UTF-8.'
    );
  }

  const allLines = rawText.split(/\r?\n|\r/);
  const lines = allLines.slice(0, 100000);

  const validSet = new Set();
  let skippedCount = 0;

  const asciiDomainRegex = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/i;
  const cyrillicDomainRegex = /^(?:[\u0400-\u04FF0-9](?:[\u0400-\u04FF0-9-]{0,61}[\u0400-\u04FF0-9])?\.)+[\u0400-\u04FF0-9-]{2,63}$/i;
  const ipv4Regex = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

  for (let rawLine of lines) {
    let line = rawLine.replace(/^[\s\u00A0\u200B-\u200D\uFEFF\u3000]+|[\s\u00A0\u200B-\u200D\uFEFF\u3000]+$/g, '');

    if (!line) continue;
    if (/^(?:#|\/\/|;|!|--)/.test(line)) continue;

    line = line.replace(/\s+(?:#|\/\/|;|!).*$/, '').trim();
    if (!line) continue;

    line = line.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '');
    line = line.replace(/^[^@\s]+@/, '');
    line = line.replace(/[/?#].*$/, '');
    line = line.replace(/:\d+$/, '');

    const isWildcard = line.startsWith('*.') || (line.startsWith('*') && line.length > 1);
    let baseHost = line.replace(/^\*\.?/, '').replace(/^\.+/, '').trim().toLowerCase();

    if (baseHost.endsWith('.')) baseHost = baseHost.slice(0, -1);

    if (!baseHost || baseHost.length > 253 || baseHost.includes('..') || /[\s<>"'{}[\]\\^~`]/.test(baseHost)) {
      skippedCount++;
      continue;
    }

    const isValid = asciiDomainRegex.test(baseHost) || cyrillicDomainRegex.test(baseHost) || ipv4Regex.test(baseHost);

    if (isValid) {
      validSet.add(isWildcard ? `*.${baseHost}` : baseHost);
    } else {
      skippedCount++;
    }
  }

  const validDomains = Array.from(validSet);

  if (validDomains.length === 0) {
    throw new Error(
      `В файле не найдено ни одного корректного доменного имени (пропущено некорректных строк: ${skippedCount}).`
    );
  }

  return { validDomains, skippedCount };
}

