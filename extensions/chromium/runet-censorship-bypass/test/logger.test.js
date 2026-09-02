'use strict';

import { expect } from 'chai';
import { logger, sanitizeLogString, sanitizeLogData } from '../src/extension-common/core/logger.js';

describe('Logger: sanitizeLogString & sanitizeLogData', () => {
  it('should mask user:pass@ in proxy and URL strings', () => {
    const raw = 'Connecting to HTTPS mylogin:secretpassword123@proxy.example.com:443';
    const sanitized = sanitizeLogString(raw);
    expect(sanitized).to.not.include('secretpassword123');
    expect(sanitized).to.not.include('mylogin');
    expect(sanitized).to.include('HTTPS ***:***@proxy.example.com:443');
  });

  it('should mask Basic and Bearer auth tokens in strings', () => {
    const raw = 'Headers: Authorization: Basic dXNlcjpwYXNz, Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9';
    const sanitized = sanitizeLogString(raw);
    expect(sanitized).to.not.include('dXNlcjpwYXNz');
    expect(sanitized).to.include('Basic ***');
    expect(sanitized).to.include('Bearer ***');
  });

  it('should mask sensitive URL query params', () => {
    const raw = 'https://api.example.com/check?password=mysecret&token=abc123456';
    const sanitized = sanitizeLogString(raw);
    expect(sanitized).to.not.include('mysecret');
    expect(sanitized).to.not.include('abc123456');
    expect(sanitized).to.include('password=***');
    expect(sanitized).to.include('token=***');
  });

  it('should recursively sanitize object fields with sensitive keys', () => {
    const data = {
      action: 'CHECK_PROXY',
      password: 'superSecretPassword',
      token: 'jwt.token.here',
      details: {
        host: '1.2.3.4',
        pass: 'hidden',
        auth: 'secret',
        rawProxy: 'HTTPS user:pwd123@1.2.3.4:443'
      }
    };

    const sanitized = sanitizeLogData(data);
    expect(sanitized.password).to.equal('***');
    expect(sanitized.token).to.equal('***');
    expect(sanitized.details.pass).to.equal('***');
    expect(sanitized.details.auth).to.equal('***');
    expect(sanitized.details.rawProxy).to.equal('HTTPS ***:***@1.2.3.4:443');
    expect(sanitized.details.host).to.equal('1.2.3.4');
  });

  it('masks cookie headers, JSON secrets and common access-token fields', () => {
    const raw = 'Cookie: sid=private; token=value\n{"api_key":"key123", "access_token":"access123"}';
    const sanitized = sanitizeLogString(raw);
    expect(sanitized).to.not.include('private');
    expect(sanitized).to.not.include('key123');
    expect(sanitized).to.not.include('access123');

    const data = sanitizeLogData({
      sessionId: 'session-secret',
      refresh_token: 'refresh-secret',
    });
    expect(data.sessionId).to.equal('***');
    expect(data.refresh_token).to.equal('***');
  });

  it('aggregates a repeated proxy error instead of creating a log storm', () => {
    const originalScheduleSave = logger.scheduleSave;
    logger.resetRuntimeState();
    logger.scheduleSave = () => {};

    try {
      const first = logger.error(
        'proxy',
        'net::ERR_PROXY_CONNECTION_FAILED',
        'Браузер не смог установить соединение с прокси-сервером',
      );
      const repeated = logger.error(
        'proxy',
        'net::ERR_PROXY_CONNECTION_FAILED',
        'Браузер не смог установить соединение с прокси-сервером',
      );

      expect(repeated).to.equal(first);
      expect(first.count).to.equal(2);
      expect(logger.getLogs()).to.have.lengthOf(1);
    } finally {
      logger.scheduleSave = originalScheduleSave;
      logger.resetRuntimeState();
    }
  });
});
