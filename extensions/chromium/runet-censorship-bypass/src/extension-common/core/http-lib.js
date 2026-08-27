'use strict';

import { clarify } from './errors-lib.js';

const checkCon = 'Что-то не так с сетью, проверьте соединение.';

export const httpLib = {
  async ifModifiedSince(url, lastModified) {
    if (url.startsWith('data:')) {
      return false;
    }
    const wasModifiedIn1970 = new Date(0).toUTCString();
    const notModifiedCode = 304;

    try {
      const res = await fetch(url, {
        method: 'HEAD',
        headers: new Headers({
          'If-Modified-Since': lastModified || wasModifiedIn1970,
        }),
      });

      if (res.status === notModifiedCode) {
        return false;
      }
      return res.headers.get('Last-Modified') || wasModifiedIn1970;
    } catch (err) {
      // P1.7: Throw instead of silently returning "1970" (which falsely signals "was modified")
      // Callers that want fire-and-forget should wrap in their own try/catch
      throw clarify(err, 'Нет связи с сервером для проверки обновлений.');
    }
  },

  async get(url, { timeoutMs = 15000 } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        cache: 'no-store',
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
      return await res.text();
    } catch (err) {
      clearTimeout(timer);
      if (err.name === 'AbortError') {
        throw clarify(err, 'Таймаут соединения с сервером.');
      }
      throw clarify(err, checkCon);
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
