'use strict';

import { storage } from './storage.js';

const STORAGE_LOGS_KEY = 'antiCensorLogs';
// P1.6: Match MAX_LOGS_LIMIT to getLogs default limit (150) so the limit param is meaningful
const MAX_LOGS_LIMIT = 150;

/**
 * Sanitize strings to redact passwords, auth credentials, tokens, and cookies
 * @param {string} str 
 * @returns {string} Sanitized string
 */
export function sanitizeLogString(str) {
  if (!str || typeof str !== 'string') return str;

  return str
    // Mask user:pass@host in proxy or URL strings (e.g. HTTPS user:password@host:port)
    .replace(/([a-zA-Z0-9+.-]+:\/\/)?([^:\s/@]+):([^@\s/]+)@/g, (match, proto) => {
      const p = proto || '';
      return `${p}***:***@`;
    })
    // Mask Basic authentication
    .replace(/(Authorization:\s*Basic\s+)[^\s]+/gi, '$1***')
    .replace(/(Basic\s+)[a-zA-Z0-9+/=]{10,}/gi, '$1***')
    // Mask Bearer tokens
    .replace(/(Bearer\s+)[a-zA-Z0-9._~+/-]{10,}/gi, '$1***')
    // Mask URL query params with credentials
    .replace(/([?&](?:password|pass|pwd|token|secret|auth|key|apiKey|cookie)=)[^&#\s]+/gi, '$1***');
}

/**
 * Recursively sanitize objects, arrays, and primitives to remove sensitive data
 * @param {any} data 
 * @returns {any} Cleaned, sanitized data
 */
export function sanitizeLogData(data) {
  if (data === null || data === undefined) {
    return data;
  }

  if (typeof data === 'string') {
    return sanitizeLogString(data);
  }

  if (typeof data === 'number' || typeof data === 'boolean') {
    return data;
  }

  if (Array.isArray(data)) {
    return data.map((item) => sanitizeLogData(item));
  }

  if (typeof data === 'object') {
    const cleanObj = {};
    const SENSITIVE_KEYS = /^(password|pass|pwd|secret|token|auth|authorization|cookie|cookies|credentials|proxycredentials|rawauth)$/i;

    for (const [key, value] of Object.entries(data)) {
      if (SENSITIVE_KEYS.test(key)) {
        cleanObj[key] = '***';
      } else {
        cleanObj[key] = sanitizeLogData(value);
      }
    }
    return cleanObj;
  }

  return sanitizeLogString(String(data));
}

/**
 * Structured Logging & Diagnostics Engine for Manifest V3
 */
class LoggerManager {
  constructor() {
    this.logs = [];
    this.saveTimeout = null;
    this.isInitialized = false;
  }

  async init() {
    if (this.isInitialized) return;
    try {
      const saved = await storage.get(STORAGE_LOGS_KEY, []);
      if (Array.isArray(saved)) {
        this.logs = saved.slice(0, MAX_LOGS_LIMIT);
      }
    } catch (err) {
      console.warn('[Logger] Failed to restore logs from storage:', err);
    }
    this.isInitialized = true;
  }

  /**
   * Add a new log entry with automatic sanitization
   * @param {Object} entry
   * @param {'error'|'warn'|'info'} [entry.level='error']
   * @param {'network'|'proxy'|'pac'|'auth'|'system'} [entry.category='system']
   * @param {string} entry.title
   * @param {string} [entry.message='']
   * @param {any} [entry.details=null]
   */
  add({ level = 'error', category = 'system', title = '', message = '', details = null }) {
    const timestamp = Date.now();
    const id = `${timestamp}-${Math.random().toString(36).slice(2, 7)}`;

    // Sanitize title and message against secrets
    const sanitizedTitle = sanitizeLogString(String(title || 'Неизвестная ошибка'));
    const sanitizedMessage = sanitizeLogString(String(message || ''));

    // Clean and sanitize details
    let cleanDetails = null;
    if (details !== null && details !== undefined) {
      if (typeof details === 'object') {
        try {
          cleanDetails = sanitizeLogData(JSON.parse(JSON.stringify(details)));
        } catch {
          cleanDetails = sanitizeLogString(String(details));
        }
      } else {
        cleanDetails = sanitizeLogString(String(details));
      }
    }

    const logEntry = {
      id,
      timestamp,
      level,
      category,
      title: sanitizedTitle,
      message: sanitizedMessage,
      details: cleanDetails,
    };

    // Avoid duplicate storm (same error and category within 1.5 seconds)
    const recent = this.logs[0];
    if (
      recent &&
      recent.category === category &&
      recent.title === logEntry.title &&
      recent.message === logEntry.message &&
      timestamp - recent.timestamp < 1500
    ) {
      recent.count = (recent.count || 1) + 1;
      recent.timestamp = timestamp;
      this.scheduleSave(level === 'error');
      return recent;
    }

    // Newest entry added to the top; maintain MAX_LOGS_LIMIT
    this.logs.unshift(logEntry);
    while (this.logs.length > MAX_LOGS_LIMIT) {
      this.logs.pop();
    }

    this.scheduleSave(level === 'error');
    return logEntry;
  }

  error(category, title, message, details) {
    return this.add({ level: 'error', category, title, message, details });
  }

  warn(category, title, message, details) {
    return this.add({ level: 'warn', category, title, message, details });
  }

  info(category, title, message, details) {
    return this.add({ level: 'info', category, title, message, details });
  }

  /**
   * Persistence to storage (immediate for errors, debounced for non-critical logs)
   */
  scheduleSave(immediate = false) {
    clearTimeout(this.saveTimeout);
    if (immediate) {
      this.saveTimeout = null;
      storage.set(STORAGE_LOGS_KEY, this.logs).catch((err) => {
        console.warn('[Logger] Failed to save logs to storage:', err);
      });
      return;
    }

    this.saveTimeout = setTimeout(() => {
      storage.set(STORAGE_LOGS_KEY, this.logs).catch((err) => {
        console.warn('[Logger] Failed to save logs to storage:', err);
      });
    }, 400);
  }

  /**
   * Get filtered logs
   */
  getLogs({ category = 'all', level = 'all', search = '', limit = 150 } = {}) {
    let result = this.logs;

    if (category && category !== 'all') {
      result = result.filter((log) => log.category === category);
    }

    if (level && level !== 'all') {
      result = result.filter((log) => log.level === level);
    }

    if (search && search.trim()) {
      const q = search.trim().toLowerCase();
      result = result.filter((log) => {
        const inTitle = (log.title || '').toLowerCase().includes(q);
        const inMessage = (log.message || '').toLowerCase().includes(q);
        const inDetails = log.details ? JSON.stringify(log.details).toLowerCase().includes(q) : false;
        return inTitle || inMessage || inDetails;
      });
    }

    return result.slice(0, limit);
  }

  /**
   * Get log counters by category & level
   */
  getStats() {
    const stats = {
      total: this.logs.length,
      network: 0,
      proxy: 0,
      pac: 0,
      auth: 0,
      system: 0,
      errors: 0,
      warnings: 0,
      info: 0,
    };

    for (const log of this.logs) {
      if (stats[log.category] !== undefined) {
        stats[log.category]++;
      }
      if (log.level === 'error') stats.errors++;
      else if (log.level === 'warn') stats.warnings++;
      else if (log.level === 'info') stats.info++;
    }

    return stats;
  }

  /**
   * Clear all stored logs
   */
  async clear() {
    this.logs = [];
    clearTimeout(this.saveTimeout);
    this.saveTimeout = null;
    await storage.set(STORAGE_LOGS_KEY, []);
    return true;
  }

  resetRuntimeState() {
    this.logs = [];
    clearTimeout(this.saveTimeout);
    this.saveTimeout = null;
    this.isInitialized = false;
  }

  /**
   * Export logs as a clean, sanitized text report
   */
  exportText(category = 'all', search = '') {
    const logs = this.getLogs({ category, search, limit: MAX_LOGS_LIMIT });
    if (!logs.length) {
      return '# Журнал ошибок и сбоев пуст.\n';
    }

    let report = `=======================================================\n`;
    report += ` Отчет об ошибках и сбоях расширения «АнтиЧебурнет»\n`;
    report += ` Дата выгрузки: ${new Date().toLocaleString('ru-RU')}\n`;
    report += ` Всего записей в отчете: ${logs.length}\n`;
    report += `=======================================================\n\n`;

    logs.forEach((item, index) => {
      const timeStr = new Date(item.timestamp).toLocaleString('ru-RU');
      const countStr = item.count > 1 ? ` (повторено ${item.count} раз)` : '';
      report += `[${index + 1}] [${timeStr}] [${item.level.toUpperCase()}] [${item.category.toUpperCase()}]${countStr}\n`;
      report += `  Заголовок: ${sanitizeLogString(item.title)}\n`;
      if (item.message) {
        report += `  Сообщение: ${sanitizeLogString(item.message)}\n`;
      }
      if (item.details) {
        const sanitizedDetails = sanitizeLogData(item.details);
        report += `  Детали: ${typeof sanitizedDetails === 'object' ? JSON.stringify(sanitizedDetails, null, 2) : sanitizedDetails}\n`;
      }
      report += `-------------------------------------------------------\n`;
    });

    return report;
  }
}

export const logger = new LoggerManager();
