'use strict';

export const FIREFOX_PRIVATE_BROWSING_REQUIRED_ERROR_CODE =
  'FIREFOX_PRIVATE_BROWSING_REQUIRED';

export class Warning extends Error {
  constructor(message = 'Warning') {
    super(message);
    this.name = 'Warning';
  }
}

export function clarify(err, message, { data } = {}) {
  if (!err) {
    return err;
  }
  const warn = new Warning(message);
  warn.wrapped = err;
  if (data) {
    warn.data = data;
  }
  return warn;
}

export function clarifyThen(message, cb) {
  return (err, ...args) => cb(clarify(err, message), ...args);
}

export function formatErrorMessage(err) {
  if (!err) return '';
  if (typeof err === 'string') return err;
  let msg = err.message || (typeof err === 'object' ? JSON.stringify(err) : String(err));
  let wrapped = err.wrapped;
  while (wrapped) {
    const deeper = wrapped.message || (typeof wrapped === 'object' ? JSON.stringify(wrapped) : String(wrapped));
    if (deeper && deeper !== msg) {
      msg += ' > ' + deeper;
    }
    wrapped = wrapped.wrapped;
  }
  return msg;
}

export function getErrorCode(err) {
  let current = err;
  while (current) {
    if (typeof current.code === 'string' && current.code) {
      return current.code;
    }
    current = current.wrapped;
  }
  return '';
}
