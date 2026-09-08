'use strict';

const statusElement = document.getElementById('permissionStatus');
const openSettingsButton = document.getElementById('openExtensionSettings');

function updatePermissionStatus() {
  const checker = chrome.extension && chrome.extension.isAllowedIncognitoAccess;
  if (typeof checker !== 'function') {
    statusElement.textContent = 'Не удалось проверить разрешение.';
    return;
  }

  checker.call(chrome.extension, (allowed) => {
    if (chrome.runtime.lastError) {
      statusElement.textContent = 'Не удалось проверить разрешение.';
      return;
    }
    statusElement.classList.toggle('allowed', Boolean(allowed));
    statusElement.classList.toggle('denied', !allowed);
    statusElement.textContent = allowed
      ? '✓ Работа в приватных окнах уже разрешена.'
      : 'Разрешение пока не выдано.';
  });
}

openSettingsButton.addEventListener('click', () => {
  chrome.tabs.create({
    url: chrome.runtime.getURL('pages/options/index.html'),
  });
});

updatePermissionStatus();
