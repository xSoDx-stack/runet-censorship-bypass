'use strict';

import { clarify, Warning } from './errors-lib.js';

const checkCon = 'Что-то не так с сетью, проверьте соединение.';
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024; // 2 MB

export const httpLib = {
  async ifModifiedSince(url, lastModified, { timeoutMs = 10000 } = {}) {
    if (url.startsWith('data:')) {
      return false;
    }
    const wasModifiedIn1970 = new Date(0).toUTCString();
    const notModifiedCode = 304;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        method: 'HEAD',
        signal: controller.signal,
        headers: new Headers({
          'If-Modified-Since': lastModified || wasModifiedIn1970,
        }),
      });

      if (res.status === notModifiedCode) {
        return false;
      }
      if (res.status < 200 || res.status >= 300) {
        throw clarify(
          new Error(`HTTP ${res.status}`),
          `Получен ответ с неудачным HTTP-кодом ${res.status}.`
        );
      }
      return res.headers.get('Last-Modified') || wasModifiedIn1970;
    } catch (err) {
      if (err instanceof Warning) {
        throw err;
      }
      if (err.name === 'AbortError') {
        throw clarify(err, 'Таймаут соединения с сервером.');
      }
      throw clarify(err, 'Нет связи с сервером для проверки обновлений.');
    } finally {
      clearTimeout(timer);
    }
  },

  async get(url, { timeoutMs = 15000, maxBytes = DEFAULT_MAX_BYTES } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        cache: 'no-store',
        signal: controller.signal,
      });

      const status = res.status;
      if (!( (status >= 200 && status < 300) || status === 304 )) {
        throw clarify(
          new Error(`HTTP ${status}`),
          `Получен ответ с неудачным HTTP-кодом ${status}.`
        );
      }

      const formatLimit = (bytes) => {
        if (bytes >= 1024 * 1024) {
          return `${(bytes / (1024 * 1024)).toFixed(0)} МБ`;
        }
        return `${Math.round(bytes / 1024)} КБ`;
      };

      const contentLength = res.headers && res.headers.get && res.headers.get('content-length');
      if (contentLength && Number(contentLength) > maxBytes) {
        throw clarify(
          new Error('Response body too large'),
          `Размер ответа превышает допустимый лимит (${formatLimit(maxBytes)}).`
        );
      }

      if (res.body && typeof res.body.getReader === 'function') {
        const reader = res.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let receivedBytes = 0;
        const textChunks = [];

        let reading = true;
        while (reading) {
          const { done, value } = await reader.read();
          if (done) {
            reading = false;
            break;
          }
          receivedBytes += value.length;
          if (receivedBytes > maxBytes) {
            try {
              await reader.cancel();
            } catch { }
            throw clarify(
              new Error('Response body too large'),
              `Размер ответа превышает допустимый лимит (${formatLimit(maxBytes)}).`
            );
          }
          textChunks.push(decoder.decode(value, { stream: true }));
        }
        textChunks.push(decoder.decode());
        return textChunks.join('');
      }

      const text = await res.text();
      const textBytes = text ? new TextEncoder().encode(text).byteLength : 0;
      if (textBytes > maxBytes) {
        throw clarify(
          new Error('Response body too large'),
          `Размер ответа превышает допустимый лимит (${formatLimit(maxBytes)}).`
        );
      }
      return text;
    } catch (err) {
      if (err instanceof Warning) {
        throw err;
      }
      if (err.name === 'AbortError') {
        throw clarify(err, 'Таймаут соединения с сервером.');
      }
      throw clarify(err, checkCon);
    } finally {
      // Keep the timeout active until the complete response body has been read.
      clearTimeout(timer);
    }
  },

  async head(url, { timeoutMs = 10000 } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        cache: 'no-store',
        method: 'HEAD',
        signal: controller.signal,
      });
      clearTimeout(timer);

      const status = res.status;
      if (!( (status >= 200 && status < 300) || status === 304 )) {
        throw clarify(
          new Error(`HTTP ${status}`),
          `Получен ответ с неудачным HTTP-кодом ${status}.`
        );
      }
      return res;
    } catch (err) {
      clearTimeout(timer);
      throw clarify(err, checkCon);
    }
  },
};
