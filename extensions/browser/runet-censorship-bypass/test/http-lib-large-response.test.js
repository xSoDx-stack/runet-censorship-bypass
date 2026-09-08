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

  it('rejects malformed UTF-8 instead of silently replacing invalid bytes', async () => {
    globalThis.fetch = async () => ({
      status: 200,
      url: 'https://trusted.example/proxy.pac',
      headers: { get: () => null },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([0x66, 0x6f, 0x80, 0x6f]));
          controller.close();
        },
      }),
    });

    let error = null;
    try {
      await httpLib.get('https://trusted.example/proxy.pac');
    } catch (err) {
      error = err;
    }

    expect(error).to.exist;
    expect(error.message).to.include('UTF-8');
  });

  it('validates the effective response URL after redirects before reading the body', async () => {
    globalThis.fetch = async () => ({
      status: 200,
      url: 'http://public.example/proxy.pac',
      headers: { get: () => null },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('function FindProxyForURL() {}'));
          controller.close();
        },
      }),
    });

    let validatedUrl = '';
    let error = null;
    try {
      await httpLib.get('https://trusted.example/proxy.pac', {
        validateFinalUrl: (finalUrl) => {
          validatedUrl = finalUrl;
          return { valid: false, error: 'redirect blocked' };
        },
      });
    } catch (err) {
      error = err;
    }

    expect(validatedUrl).to.equal('http://public.example/proxy.pac');
    expect(error).to.exist;
    expect(error.message).to.include('redirect blocked');
  });

  it('falls back to a one-byte GET probe when a server rejects HEAD', async () => {
    const requests = [];
    let bodyCancelled = false;
    globalThis.fetch = async (_url, options) => {
      requests.push(options);
      if (options.method === 'HEAD') {
        return { status: 405, url: 'https://example.com/proxy.pac' };
      }
      return {
        status: 206,
        url: 'https://example.com/proxy.pac',
        body: {
          cancel: async () => {
            bodyCancelled = true;
          },
        },
      };
    };

    const response = await httpLib.probe('https://example.com/proxy.pac');
    expect(response.status).to.equal(206);
    expect(requests.map((request) => request.method)).to.deep.equal(['HEAD', 'GET']);
    expect(requests[1].headers.get('Range')).to.equal('bytes=0-0');
    expect(bodyCancelled).to.equal(true);
  });
});
