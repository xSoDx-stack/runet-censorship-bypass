'use strict';

import { storage } from './storage.js';

const STORAGE_LOGS_KEY = 'antiCensorLogs';
const MAX_LOGS_LIMIT = 30;

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
   * Add a new log entry
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

    // Clean details to ensure JSON-serializable
    let cleanDetails = null;
    if (details !== null && details !== undefined) {
      if (typeof details === 'object') {
        try {
          cleanDetails = JSON.parse(JSON.stringify(details));
        } catch {
          cleanDetails = String(details);
        }
      } else {
        cleanDetails = String(details);
      }
    }

    const logEntry = {
      id,
      timestamp,
      level,
      category,
      title: String(title || 'Неизвестная ошибка'),
      message: String(message || ''),
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
      this.scheduleSave();
      return recent;
    }

    // Newest entry added to the very top; oldest entries beyond limit are removed
    this.logs.unshift(logEntry);
    while (this.logs.length > MAX_LOGS_LIMIT) {
      this.logs.pop();
    }

    this.scheduleSave();
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
   * Debounced persistence to avoid storage rate limits
   */
  scheduleSave() {
    clearTimeout(this.saveTimeout);
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
    await storage.set(STORAGE_LOGS_KEY, []);
    return true;
  }

  /**
   * Export logs as a readable text report
   */
  exportText(category = 'all', search = '') {
    const logs = this.getLogs({ category, search, limit: MAX_LOGS_LIMIT });
    if (!logs.length) {
      return '# Журнал ошибок и сбоев пуст.\n';
    }

    let report = `=======================================================\n`;
    report += ` Отчет об ошибках и сбоях расширения «Обход блокировок Рунета»\n`;
    report += ` Дата выгрузки: ${new Date().toLocaleString('ru-RU')}\n`;
    report += ` Всего записей в отчете: ${logs.length}\n`;
    report += `=======================================================\n\n`;

    logs.forEach((item, index) => {
      const timeStr = new Date(item.timestamp).toLocaleString('ru-RU');
      const countStr = item.count > 1 ? ` (повторено ${item.count} раз)` : '';
      report += `[${index + 1}] [${timeStr}] [${item.level.toUpperCase()}] [${item.category.toUpperCase()}]${countStr}\n`;
      report += `  Заголовок: ${item.title}\n`;
      if (item.message) {
        report += `  Сообщение: ${item.message}\n`;
      }
      if (item.details) {
        report += `  Детали: ${typeof item.details === 'object' ? JSON.stringify(item.details, null, 2) : item.details}\n`;
      }
      report += `-------------------------------------------------------\n`;
    });

    return report;
  }
}

export const logger = new LoggerManager();
