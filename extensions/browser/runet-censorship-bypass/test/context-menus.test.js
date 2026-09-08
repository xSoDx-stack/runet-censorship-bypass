'use strict';

import { expect } from 'chai';
import { setupContextMenus } from '../src/extension-common/core/context-menus.js';

describe('Cross-browser context menus', () => {
  let originalChrome;

  before(() => {
    originalChrome = globalThis.chrome;
  });

  after(() => {
    globalThis.chrome = originalChrome;
  });

  it('registers and handles clicks when Firefox omits Event.hasListeners()', () => {
    let listener = null;
    const openedTabs = [];
    globalThis.chrome = {
      contextMenus: {
        onClicked: {
          addListener: (callback) => {
            listener = callback;
          },
          hasListener: () => false,
        },
      },
      tabs: {
        create: (details) => openedTabs.push(details),
      },
    };

    expect(() => setupContextMenus()).not.to.throw();
    expect(listener).to.be.a('function');

    listener({ menuItemId: 'web-archive' }, { url: 'https://example.com/path' });
    expect(openedTabs).to.deep.equal([{
      url: 'https://web.archive.org/web/*/https://example.com/path',
    }]);
  });

  it('does not register the same listener twice when hasListener is available', () => {
    let listener = null;
    let registrations = 0;
    globalThis.chrome = {
      contextMenus: {
        onClicked: {
          addListener: (callback) => {
            listener = callback;
            registrations += 1;
          },
          hasListener: (callback) => callback === listener,
        },
      },
      tabs: { create: () => {} },
    };

    setupContextMenus();
    setupContextMenus();
    expect(registrations).to.equal(1);
  });
});
