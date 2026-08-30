'use strict';

import { expect } from 'chai';
import { formatLogEntryForClipboard } from '../src/extension-common/core/log-format.js';

describe('single log entry clipboard format', () => {
  it('copies all useful fields and structured details without UI markup', () => {
    const text = formatLogEntryForClipboard({
      timestamp: Date.UTC(2026, 7, 30, 8, 15, 0),
      level: 'error',
      category: 'pac',
      title: 'Ошибка синхронизации PAC',
      message: 'Response body too large',
      count: 3,
    }, '{\n  "provider": "Антицензорити"\n}');

    expect(text).to.include('[ERROR] [PAC]');
    expect(text).to.include('Ошибка синхронизации PAC');
    expect(text).to.include('Response body too large');
    expect(text).to.include('"provider": "Антицензорити"');
    expect(text).to.include('Повторено: 3');
    expect(text).to.not.include('<button');
  });
});
