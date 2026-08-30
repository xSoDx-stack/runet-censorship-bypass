'use strict';

import { expect } from 'chai';
import { httpLib } from '../src/extension-common/core/http-lib.js';

describe('HTTP library large PAC streaming', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mockAsciiResponse(size) {
    const chunkSize = 1024 * 1024;
    return {
      status: 200,
      headers: { get: () => null },
      body: new ReadableStream({
        start(controller) {
          let remaining = size;
          while (remaining > 0) {
            const length = Math.min(chunkSize, remaining);
            controller.enqueue(new Uint8Array(length).fill(65));
            remaining -= length;
          }
          controller.close();
        },
      }),
    };
  }

  it('accepts the current 11.1 MiB trusted-provider payload under a 25 MiB limit', async () => {
    const currentPacBytes = 11642139;
    globalThis.fetch = async () => mockAsciiResponse(currentPacBytes);
    const text = await httpLib.get('https://trusted.example/proxy.pac', {
      maxBytes: 25 * 1024 * 1024,
    });
    expect(text.length).to.equal(currentPacBytes);
  });

  it('still rejects the same payload under the custom-PAC 10 MiB limit', async () => {
    globalThis.fetch = async () => mockAsciiResponse(11642139);
    let error = null;
    try {
      await httpLib.get('https://custom.example/proxy.pac', {
        maxBytes: 10 * 1024 * 1024,
      });
    } catch (err) {
      error = err;
    }
    expect(error).to.exist;
    expect(error.message).to.include('10 МБ');
  });

  it('keeps the timeout active while the response body is still streaming', async () => {
    globalThis.fetch = async (_url, { signal }) => ({
      status: 200,
      headers: { get: () => null },
      body: {
        getReader: () => ({
          read: () => new Promise((resolve, reject) => {
            signal.addEventListener('abort', () => {
              const error = new Error('aborted');
              error.name = 'AbortError';
              reject(error);
            }, { once: true });
          }),
          cancel: async () => {},
        }),
      },
    });

    let error = null;
    try {
      await httpLib.get('https://slow.example/proxy.pac', { timeoutMs: 10 });
    } catch (err) {
      error = err;
    }

    expect(error).to.exist;
    expect(error.message).to.include('Таймаут');
  });

  it('times out a HEAD update check instead of hanging indefinitely', async () => {
    globalThis.fetch = async (_url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    });

    let error = null;
    try {
      await httpLib.ifModifiedSince('https://slow.example/proxy.pac', null, { timeoutMs: 10 });
    } catch (err) {
      error = err;
    }

    expect(error).to.exist;
    expect(error.message).to.include('Таймаут');
  });

  it('rejects an unsuccessful HTTP status during an update check', async () => {
    globalThis.fetch = async () => ({
      status: 404,
      headers: { get: () => null },
    });

    let error = null;
    try {
      await httpLib.ifModifiedSince('https://missing.example/proxy.pac', null);
    } catch (err) {
      error = err;
    }

    expect(error).to.exist;
    expect(error.message).to.include('404');
  });
});
