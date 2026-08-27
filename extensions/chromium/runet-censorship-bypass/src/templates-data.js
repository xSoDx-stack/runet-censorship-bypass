'use strict';

const pacUrls = [
  // GitHub.io (anticensority), cached:
  'https://anticensority.github.io/generated-pac-scripts/anticensority.pac',
  // GitHub repo (anticensority), cached:
  'https://raw.githubusercontent.com/anticensority/generated-pac-scripts/master/anticensority.pac',
];

const commonContext = {
  version: '2.2.15',
  anticensorityPacUrls: [
    ...pacUrls,
  ],
};

exports.contexts = {};

const extra_permissions = ', "webRequest", "webRequestAuthProvider", "webNavigation"';

exports.contexts.full = Object.assign({}, commonContext, {
  versionSuffix: '',
  nameSuffixEn: '',
  nameSuffixRu: '',
  extra_permissions,
  ifMini: false,
});

exports.contexts.mini = Object.assign({}, commonContext, {
  versionSuffix: '-mini',
  nameSuffixEn: ' MINI',
  nameSuffixRu: ' МИНИ',
  extra_permissions: '',
  ifMini: true,
});

exports.contexts.beta = Object.assign({}, commonContext, {
  anticensorityPacUrls: [
    'https://raw.githubusercontent.com/anticensority/for-testing/master/anticensority.pac',
    'https://anticensority.github.io/for-testing/anticensority.pac',
  ],
  version: '2.2.15',
  versionSuffix: '',
  nameSuffixEn: ' FOR TESTING',
  nameSuffixRu: ' ДЛЯ ТЕСТОВ',
  extra_permissions,
  ifMini: false,
});
