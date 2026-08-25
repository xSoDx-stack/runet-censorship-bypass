'use strict';

const MENU_ITEMS = [
  {
    id: 'google-translate',
    title: 'Через Google Translate',
    getUrl: (url) => `https://translate.google.com/translate?hl=&sl=en&tl=ru&anno=2&sandbox=1&u=${encodeURIComponent(url)}`,
  },
  {
    id: 'web-archive',
    title: 'Из архива Wayback Machine (archive.org)',
    getUrl: (url) => `https://web.archive.org/web/*/${url}`,
  },
  {
    id: 'rublacklist-check',
    title: 'Проверить в реестре блокировок (Роскомсвобода)',
    getUrl: (url) => {
      try {
        const host = new URL(url).hostname;
        return `https://reestr.rublacklist.net/?q=${encodeURIComponent(host)}`;
      } catch {
        return `https://reestr.rublacklist.net/?q=${encodeURIComponent(url)}`;
      }
    },
  },
  {
    id: 'docs-support',
    title: 'Справка и поддержка проекта',
    getUrl: () => 'https://github.com/anticensority/runet-censorship-bypass/wiki',
  },
];

export function createContextMenuItems() {
  if (!chrome.contextMenus) return;

  chrome.contextMenus.removeAll(() => {
    for (const item of MENU_ITEMS) {
      chrome.contextMenus.create({
        id: item.id,
        title: item.title,
        contexts: ['action'],
      }, () => {
        if (chrome.runtime.lastError) { /* ignore */ }
      });
    }
  });
}

export function setupContextMenus() {
  if (!chrome.contextMenus) return;

  if (chrome.contextMenus.onClicked && !chrome.contextMenus.onClicked.hasListeners()) {
    chrome.contextMenus.onClicked.addListener((info, tab) => {
      const item = MENU_ITEMS.find((m) => m.id === info.menuItemId);
      if (!item) return;

      const targetUrl = tab && tab.url ? item.getUrl(tab.url) : item.getUrl('');
      if (targetUrl) {
        chrome.tabs.create({ url: targetUrl });
      }
    });
  }
}
