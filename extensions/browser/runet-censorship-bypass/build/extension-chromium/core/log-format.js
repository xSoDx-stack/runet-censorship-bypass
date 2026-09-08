'use strict';

export function formatLogEntryForClipboard(log, detailsText = '') {
  const date = new Date(log.timestamp);
  const lines = [
    `[${date.toLocaleString('ru-RU')}] [${String(log.level || 'error').toUpperCase()}] [${String(log.category || 'system').toUpperCase()}]`,
    log.title || 'Неизвестная ошибка',
  ];
  if (log.message) lines.push(log.message);
  if (detailsText) lines.push(detailsText);
  if (log.count > 1) lines.push(`Повторено: ${log.count}`);
  return lines.join('\n');
}
