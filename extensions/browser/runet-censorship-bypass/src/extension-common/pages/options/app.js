'use strict';

import { parseCustomProxies, getRootDomain, parseProxyHostInput } from '../../core/utils.js';
import { normalizeDomainRule, parseDomainRuleLines } from '../../core/domain-rules.js';
import { formatLogEntryForClipboard } from '../../core/log-format.js';
import { buildRknBlocklistUrl, normalizeRknLookupUrl } from '../../core/rkn-blocklist.js';
import { FIREFOX_PRIVATE_BROWSING_REQUIRED_ERROR_CODE } from '../../core/errors-lib.js';

/**
 * Options & Popup Application Logic for Manifest V3
 */

// Single source of truth for fallback version placeholder
const DEFAULT_VERSION = '';
const PROXY_HEALTH_FRESH_MS = 15 * 60 * 1000;
const PAC_MODS_STORAGE_KEY = 'pac-kitchen-mods';

// State
let appState = {
  syncState: {
    currentPacProviderKey: 'Антизапрет',
    lastPacUpdateStamp: 0,
    isSyncing: false,
    isControlled: false,
    isControllable: false,
    providers: {},
  },
  pacMods: {},
  defaultConfigs: {},
  notifications: {},
  lastErrors: [],
  version: DEFAULT_VERSION,
  activeTab: 'exceptions',
  currentSiteDomain: '',
  currentSiteTabId: null,
  exceptionStats: { includedCount: 0, excludedCount: 0, whitelistCount: 0 },
  currentSiteMatch: { matched: false },
  currentSiteRoute: null,
  proxyHealthMap: {},
  logsState: {
    category: 'all',
    search: '',
    items: [],
    stats: {},
  },
};
let stateLoadRevision = 0;
let externalStateRefreshTimer = null;

function formatVersion(ver) {
  if (!ver) return DEFAULT_VERSION ? `v${DEFAULT_VERSION}` : '';
  let clean = String(ver).replace(/^0\.0\./, '').replace(/^v+/i, '').trim();
  return clean ? `v${clean}` : '';
}

// DOM Elements Cache
const el = {};

function initElements() {
  el.headerStatus = document.getElementById('headerStatus');
  el.statusText = document.getElementById('statusText');
  el.extVersion = document.getElementById('extVersion');
  el.syncDate = document.getElementById('syncDate');
  el.syncBtn = document.getElementById('syncBtn');
  el.syncBtnIcon = document.getElementById('syncBtnIcon');
  el.toast = document.getElementById('toast');
  el.navTabs = document.querySelectorAll('.nav-tab-btn');
  el.tabContents = document.querySelectorAll('.tab-content');
  el.providerCards = document.querySelectorAll('.provider-card');
  el.onlyOwnSitesCard = document.getElementById('onlyOwnSitesCard');
  el.customPacUrlCard = document.getElementById('customPacUrlCard');
  el.customPacUrlBox = document.getElementById('customPacUrlBox');
  el.customPacUrlInput = document.getElementById('customPacUrlInput');
  el.saveCustomPacUrlBtn = document.getElementById('saveCustomPacUrlBtn');
  el.customPacUrlHint = document.getElementById('customPacUrlHint');
  el.homeProxyWarningBanner = document.getElementById('homeProxyWarningBanner');
  el.homeProxyWarningText = document.getElementById('homeProxyWarningText');
  // Current Site Widget
  el.currentSiteWidget = document.getElementById('currentSiteWidget');
  el.currentSiteDomainText = document.getElementById('currentSiteDomainText');
  el.currentSiteStatusBadge = document.getElementById('currentSiteStatusBadge');
  el.setSiteProxyBtn = document.getElementById('setSiteProxyBtn');
  el.setSiteDirectBtn = document.getElementById('setSiteDirectBtn');
  el.resetSitePacBtn = document.getElementById('resetSitePacBtn');
  // Exceptions (Sites Tab)
  el.excQuickInput = document.getElementById('excQuickInput');
  el.addExcQuickBtn = document.getElementById('addExcQuickBtn');
  el.importTxtFileInput = document.getElementById('importTxtFileInput');
  el.importTxtBtn = document.getElementById('importTxtBtn');
  el.exportTxtBtn = document.getElementById('exportTxtBtn');
  el.clearProxiedDomainsBtn = document.getElementById('clearProxiedDomainsBtn');
  el.importModal = document.getElementById('importModal');
  el.closeImportModalBtn = document.getElementById('closeImportModalBtn');
  el.cancelImportBtn = document.getElementById('cancelImportBtn');
  el.confirmImportBtn = document.getElementById('confirmImportBtn');
  el.importModalCount = document.getElementById('importModalCount');
  el.importModalSummary = document.getElementById('importModalSummary');
  el.statIncludedCount = document.getElementById('statIncludedCount');
  el.statExcludedCount = document.getElementById('statExcludedCount');
  el.statWhitelistCount = document.getElementById('statWhitelistCount');
  el.openExceptionsPageBtn = document.getElementById('openExceptionsPageBtn');
  // Own Proxies Form & Controls
  el.proxyFormView = document.getElementById('proxyFormView');
  el.proxyRawView = document.getElementById('proxyRawView');
  el.proxyEditorModeToggle = document.getElementById('proxyEditorModeToggle');
  el.proxyFormAlert = document.getElementById('proxyFormAlert');
  el.proxyFormAlertText = document.getElementById('proxyFormAlertText');
  el.proxyProtocol = document.getElementById('proxyProtocol');
  el.proxyHost = document.getElementById('proxyHost');
  el.proxyPort = document.getElementById('proxyPort');
  el.authSectionWrapper = document.getElementById('authSectionWrapper');
  el.proxyAuthCheck = document.getElementById('proxyAuthCheck');
  el.proxyAuthFields = document.getElementById('proxyAuthFields');
  el.proxyUser = document.getElementById('proxyUser');
  el.proxyPass = document.getElementById('proxyPass');
  el.socksNotice = document.getElementById('socksNotice');
  el.addProxyBtn = document.getElementById('addProxyBtn');
  el.addProxyBtnIcon = document.getElementById('addProxyBtnIcon');
  el.addProxyBtnText = document.getElementById('addProxyBtnText');
  el.recheckAllProxiesBtn = document.getElementById('recheckAllProxiesBtn');
  el.proxyCardsList = document.getElementById('proxyCardsList');
  el.customProxyText = document.getElementById('customProxyText');
  el.saveProxiesBtn = document.getElementById('saveProxiesBtn');
  el.torToggle = document.getElementById('torToggle');
  el.warpToggle = document.getElementById('warpToggle');
  el.ownOnlyToggle = document.getElementById('ownOnlyToggle');
  // Modifiers
  el.httpsOnlyToggle = document.getElementById('httpsOnlyToggle');
  el.secureProxiesOnlyToggle = document.getElementById('secureProxiesOnlyToggle');
  el.prohibitDnsToggle = document.getElementById('prohibitDnsToggle');
  el.proxyOrDieToggle = document.getElementById('proxyOrDieToggle');
  el.moreDomainsToggle = document.getElementById('moreDomainsToggle');
  el.saveModsBtn = document.getElementById('saveModsBtn');
  // Notifications
  el.notifPacErrorToggle = document.getElementById('notifPacErrorToggle');
  el.notifExtErrorToggle = document.getElementById('notifExtErrorToggle');
  el.notifNoControlToggle = document.getElementById('notifNoControlToggle');
  // Diagnostics
  el.testConnBtn = document.getElementById('testConnBtn');
  el.connResult = document.getElementById('connResult');
  el.checkBlacklistBtn = document.getElementById('checkBlacklistBtn');
  el.viewPacScriptBtn = document.getElementById('viewPacScriptBtn');
  el.pacScriptModal = document.getElementById('pacScriptModal');
  el.pacScriptContent = document.getElementById('pacScriptContent');
  el.closePacModalBtn = document.getElementById('closePacModalBtn');
  el.resetSettingsBtn = document.getElementById('resetSettingsBtn');
  // Logs Tab
  el.logsNavBadge = document.getElementById('logsNavBadge');
  el.logsTotalCountPill = document.getElementById('logsTotalCountPill');
  el.logsFilterGroup = document.getElementById('logsFilterGroup');
  el.logsFilterBtns = document.querySelectorAll('.log-filter-btn');
  el.countNetwork = document.getElementById('countNetwork');
  el.countProxy = document.getElementById('countProxy');
  el.countPac = document.getElementById('countPac');
  el.countAuth = document.getElementById('countAuth');
  el.countSystem = document.getElementById('countSystem');
  el.logsSearchInput = document.getElementById('logsSearchInput');
  el.clearLogsSearchBtn = document.getElementById('clearLogsSearchBtn');
  el.refreshLogsBtn = document.getElementById('refreshLogsBtn');
  el.copyLogsBtn = document.getElementById('copyLogsBtn');
  el.exportLogsBtn = document.getElementById('exportLogsBtn');
  el.clearLogsBtn = document.getElementById('clearLogsBtn');
  el.logsContainer = document.getElementById('logsContainer');
}

// Messaging helper
function sendMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (res) => {
      if (chrome.runtime.lastError) {
        console.warn('sendMessage error:', chrome.runtime.lastError);
        resolve({ success: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(res || { success: false });
      }
    });
  });
}

function isFirefoxRuntime() {
  try {
    return chrome.runtime.getURL('').startsWith('moz-extension://');
  } catch {
    return false;
  }
}

function openStandaloneDomainImport() {
  const url = chrome.runtime.getURL('pages/exceptions/index.html?import=1&target=included');
  chrome.tabs.create({ url }, () => {
    if (chrome.runtime.lastError) {
      showToast(`Ошибка открытия импорта: ${chrome.runtime.lastError.message}`);
    }
  });
}

function isPrivateBrowsingPermissionError(value) {
  return Boolean(
    value &&
    (value.errorCode === FIREFOX_PRIVATE_BROWSING_REQUIRED_ERROR_CODE ||
      value.lastErrorCode === FIREFOX_PRIVATE_BROWSING_REQUIRED_ERROR_CODE)
  );
}

function setActionableErrorElement(element, enabled) {
  if (!element) return;
  element.classList.toggle('actionable-error', enabled);
  if (enabled) {
    element.dataset.errorAction = 'open-private-browsing-settings';
    element.setAttribute('role', 'button');
    element.setAttribute('tabindex', '0');
    element.title = 'Открыть управление расширением в Firefox';
    return;
  }
  delete element.dataset.errorAction;
  element.removeAttribute('role');
  element.removeAttribute('tabindex');
  element.removeAttribute('title');
}

async function openPrivateBrowsingSettings() {
  showToast('Открываем управление расширением в Firefox…');
  const response = await sendMessage({ action: 'OPEN_PRIVATE_BROWSING_SETTINGS' });
  if (!response.success) {
    showToast(`Не удалось открыть настройки Firefox: ${response.error || 'сбой'}`, 4500);
  }
}

// Toast notification
let toastTimer = null;
let toastAction = null;
function showToast(text, duration = 2400, action = null) {
  if (!el.toast) return;
  toastAction = typeof action === 'function' ? action : null;
  setActionableErrorElement(el.toast, Boolean(toastAction));
  el.toast.textContent = text;
  el.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.toast.classList.remove('show');
    toastAction = null;
    setActionableErrorElement(el.toast, false);
  }, duration);
}

function showResponseError(response, {
  prefix = 'Ошибка: ',
  fallback = 'Сбой',
  duration = 2400,
} = {}) {
  const actionable = isPrivateBrowsingPermissionError(response);
  const suffix = actionable
    ? ' Нажмите, чтобы открыть разрешения Firefox.'
    : '';
  if (actionable) {
    appState.syncState.lastError = response.error || fallback;
    appState.syncState.lastErrorCode = response.errorCode;
  }
  showToast(
    `${prefix}${response?.error || fallback}${suffix}`,
    actionable ? Math.max(duration, 8000) : duration,
    actionable ? openPrivateBrowsingSettings : null
  );
}


/**
 * Validates whether a URL is a real public web page and not a browser service/internal/extension page.
 * Returns { fullHost, rootDomain } or null.
 */
function extractValidWebDomain(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') return null;
  const trimmed = urlStr.trim().toLowerCase();

  // 1. Strict scheme whitelist: only real web pages (http: and https:)
  const prohibitedSchemes = [
    'chrome:', 'chrome-extension:', 'chrome-untrusted:', 'chrome-search:',
    'chrome-devtools:', 'devtools:', 'edge:', 'brave:', 'opera:', 'vivaldi:',
    'about:', 'blob:', 'data:', 'javascript:', 'file:', 'view-source:', 'filesystem:'
  ];
  if (prohibitedSchemes.some((scheme) => trimmed.startsWith(scheme))) {
    return null;
  }

  if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
    return null;
  }

  try {
    const parsed = new URL(trimmed);
    let host = (parsed.hostname || '').toLowerCase().trim().replace(/^\.+|\.+$/g, '');

    if (!host) return null;

    // 2. Prohibit internal/service hostnames, localhost, private IPs
    if (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '0.0.0.0' ||
      host === '::1' ||
      host.endsWith('.localhost') ||
      host.endsWith('.local') ||
      host.endsWith('.internal') ||
      host.includes('chrome-extension') ||
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(host) ||
      /^169\.254\./.test(host)
    ) {
      return null;
    }

    // 3. Must contain at least one valid dot and proper TLD
    const parts = host.split('.');
    if (parts.length < 2) return null;

    const tld = parts[parts.length - 1];
    if (!tld || tld.length < 2 || (/^\d+$/.test(tld) && parts.length !== 4)) {
      return null;
    }

    const rootDomain = getRootDomain(host);
    return { fullHost: host, rootDomain: rootDomain || host };
  } catch {
    return null;
  }
}

/**
 * Pre-fill quick add input in the Sites tab with active web domain
 */
function prefillQuickAddInput() {
  if (!el.excQuickInput) return;
  if (document.activeElement === el.excQuickInput) return;

  if (appState.currentSiteDomain) {
    el.excQuickInput.value = appState.currentSiteDomain;
    el.excQuickInput.placeholder = `Домен (напр. ${appState.currentSiteDomain})`;
  } else {
    if (!el.excQuickInput.value) {
      el.excQuickInput.placeholder = 'Домен (напр. rutracker.org)';
    }
  }
}

// Check if any custom proxies / Tor / WARP are configured
function hasAnyConfiguredProxy() {
  const raw = (appState.pacMods.customProxyStringRaw || '').trim();
  const customList = parseCustomProxies(raw);
  const tor = Boolean(appState.pacMods.ifUseLocalTor);
  const warp = Boolean(appState.pacMods.ifUseLocalWarp);
  return customList.length > 0 || tor || warp;
}

function renderObservedCurrentSiteRoute() {
  const route = appState.currentSiteRoute;
  if (!el.currentSiteStatusBadge || !route || route.confidence !== 'observed') {
    return false;
  }

  if (route.kind === 'direct') {
    el.currentSiteStatusBadge.className = 'site-status-badge direct';
    el.currentSiteStatusBadge.textContent = '⚪ Напрямую';
    el.currentSiteStatusBadge.title = 'Фактический маршрут последней успешной загрузки: без прокси';
    return true;
  }

  if (route.kind !== 'proxy') return false;
  const endpoint = route.proxyHost ? ` (${route.proxyHost})` : '';
  if (route.source === 'own') {
    el.currentSiteStatusBadge.className = 'site-status-badge proxied';
    el.currentSiteStatusBadge.textContent = '🟢 Свой прокси';
    el.currentSiteStatusBadge.title = `Фактический маршрут последней успешной загрузки: ваш прокси${endpoint}`;
    return true;
  }

  const providerKey = appState.syncState.currentPacProviderKey || '';
  const isAntizapret = route.source === 'antizapret' || providerKey === 'Антизапрет';
  el.currentSiteStatusBadge.className = 'site-status-badge pac';
  el.currentSiteStatusBadge.textContent = isAntizapret ? '🔵 Антизапрет' : '🔵 Прокси PAC';
  el.currentSiteStatusBadge.title = isAntizapret
    ? `Фактический маршрут последней успешной загрузки: прокси Антизапрета${endpoint}`
    : `Фактический маршрут последней успешной загрузки: прокси активного PAC${endpoint}`;
  return true;
}

// Render Current Active Site Widget
function renderCurrentSiteWidget() {
  if (!el.currentSiteWidget || !appState.currentSiteDomain) {
    if (el.currentSiteWidget) el.currentSiteWidget.style.display = 'none';
    return;
  }

  const domain = appState.currentSiteDomain;
  el.currentSiteWidget.style.display = 'flex';
  if (el.currentSiteDomainText) {
    el.currentSiteDomainText.textContent = domain;
    el.currentSiteDomainText.title = domain;
  }

  const match = appState.currentSiteMatch || { matched: false };
  const hasObservedRoute = renderObservedCurrentSiteRoute();

  if (match.matched) {
    if (match.isProxied) {
      const isConfigured = hasAnyConfiguredProxy();
      const hasWorking = hasAnyWorkingProxy();

      if (!hasObservedRoute) {
        if (!isConfigured || !hasWorking) {
          el.currentSiteStatusBadge.className = 'site-status-badge offline';
          el.currentSiteStatusBadge.textContent = match.isExact ? '🔴 В проксируемых' : `🔴 Прокси (*.${match.ruleKey || domain})`;
          el.currentSiteStatusBadge.title = !isConfigured
            ? 'Прокси-сервер не настроен во вкладке «Прокси»'
            : 'Все настроенные прокси-серверы недоступны';
        } else {
          el.currentSiteStatusBadge.className = 'site-status-badge proxied';
          el.currentSiteStatusBadge.textContent = match.isExact ? '🟢 В проксируемых' : `🟢 Прокси (*.${match.ruleKey || domain})`;
          el.currentSiteStatusBadge.title = 'Сайт настроен на использование вашего прокси-сервера';
        }
      }
      if (el.setSiteProxyBtn) el.setSiteProxyBtn.style.display = 'none';
      if (el.setSiteDirectBtn) el.setSiteDirectBtn.style.display = 'inline-flex';
      if (el.resetSitePacBtn) el.resetSitePacBtn.style.display = 'inline-flex';
    } else {
      if (!hasObservedRoute) {
        el.currentSiteStatusBadge.className = 'site-status-badge direct';
        el.currentSiteStatusBadge.textContent = match.isExact ? '⚪ Напрямую' : `⚪ Напрямую (*.${match.ruleKey || domain})`;
        el.currentSiteStatusBadge.title = 'Сайт настроен на прямое соединение в обход PAC и прокси';
      }
      if (el.setSiteProxyBtn) el.setSiteProxyBtn.style.display = 'inline-flex';
      if (el.setSiteDirectBtn) el.setSiteDirectBtn.style.display = 'none';
      if (el.resetSitePacBtn) el.resetSitePacBtn.style.display = 'inline-flex';
    }
  } else {
    // Default: governed by PAC rules
    const isPacActive = appState.syncState.currentPacProviderKey !== 'none';
    if (!hasObservedRoute) {
      if (isPacActive) {
        el.currentSiteStatusBadge.className = 'site-status-badge pac';
        el.currentSiteStatusBadge.textContent = '⚡ По правилам PAC';
        el.currentSiteStatusBadge.title = 'Точный маршрут ещё не наблюдался; выбор выполняется правилами PAC-скрипта';
      } else {
        el.currentSiteStatusBadge.className = 'site-status-badge direct';
        el.currentSiteStatusBadge.textContent = '⚪ Отключено';
        el.currentSiteStatusBadge.title = 'Расширение отключено';
      }
    }
    if (el.setSiteProxyBtn) el.setSiteProxyBtn.style.display = 'inline-flex';
    if (el.setSiteDirectBtn) el.setSiteDirectBtn.style.display = 'inline-flex';
    if (el.resetSitePacBtn) el.resetSitePacBtn.style.display = 'none';
  }
}

// Action: Set Current Site to Proxy
async function handleSetCurrentSiteProxy() {
  if (!appState.currentSiteDomain) return;
  const domain = getRootDomain(appState.currentSiteDomain) || appState.currentSiteDomain;
  const res = await sendMessage({
    action: 'SET_SINGLE_EXCEPTION',
    domain,
    isProxy: true,
    currentTabId: appState.currentSiteTabId,
  });
  if (res.success && res.data) {
    appState.currentSiteRoute = null;
    appState.exceptionStats = res.data.exceptionStats || appState.exceptionStats;
    appState.currentSiteMatch = res.data.currentSiteMatch || { matched: true, isProxied: true, isExact: true };
    render();
    if (!hasAnyConfiguredProxy()) {
      showToast(`⚠️ ${domain} добавлен! Для работы настройте свой прокси во вкладке «Прокси»`, 4500);
    } else {
      showToast(`✓ ${domain} (и все его поддомены): добавлено в проксируемые!`);
    }
  }
}

// Action: Set Current Site to Direct (Exclude)
async function handleSetCurrentSiteDirect() {
  if (!appState.currentSiteDomain) return;
  const domain = getRootDomain(appState.currentSiteDomain) || appState.currentSiteDomain;
  const res = await sendMessage({
    action: 'SET_SINGLE_EXCEPTION',
    domain,
    isProxy: false,
    currentTabId: appState.currentSiteTabId,
  });
  if (res.success && res.data) {
    appState.currentSiteRoute = null;
    appState.exceptionStats = res.data.exceptionStats || appState.exceptionStats;
    appState.currentSiteMatch = res.data.currentSiteMatch || { matched: true, isProxied: false, isExact: true };
    render();
    showToast(`✓ ${domain} (и все его поддомены): переведено на прямое соединение`);
  }
}

// Action: Reset Current Site back to PAC rules
async function handleResetCurrentSitePac() {
  if (!appState.currentSiteDomain) return;
  const domain = getRootDomain(appState.currentSiteDomain) || appState.currentSiteDomain;
  const res = await sendMessage({
    action: 'SET_SINGLE_EXCEPTION',
    domain,
    isProxy: null,
    currentTabId: appState.currentSiteTabId,
  });
  if (res.success && res.data) {
    appState.currentSiteRoute = null;
    appState.exceptionStats = res.data.exceptionStats || appState.exceptionStats;
    appState.currentSiteMatch = res.data.currentSiteMatch || { matched: false };
    render();
    const removedRules = res.data.removedRuleKeys || [];
    const removalDetails = removedRules.length
      ? ` Удалено: ${removedRules.join(', ')}`
      : '';
    showToast(`🔄 ${domain} (и все поддомены): сброшено на стандартные правила PAC.${removalDetails}`);
  }
}

// Check if at least one proxy / tor / warp is working
function hasAnyWorkingProxy() {
  const tor = Boolean(appState.pacMods?.ifUseLocalTor);
  const warp = Boolean(appState.pacMods?.ifUseLocalWarp);
  if (tor || warp) return true;

  const customList = parseCustomProxies(appState.pacMods?.customProxyStringRaw || '');
  if (!customList.length) return false;

  return customList.some((p) => {
    const st = appState.proxyHealthMap[p.raw];
    if (!st || st.checking) return true;
    if (!isProxyHealthFresh(st)) return true;
    return st.ok === true;
  });
}

function isProxyHealthFresh(health, now = Date.now()) {
  const checkedAt = Number(health?.checkedAt);
  return Number.isFinite(checkedAt) && checkedAt > 0 && now - checkedAt <= PROXY_HEALTH_FRESH_MS;
}

// Check Health of a Single Proxy
async function checkProxyAvailability(proxyRaw) {
  appState.proxyHealthMap[proxyRaw] = Object.assign(
    {},
    appState.proxyHealthMap[proxyRaw],
    { checking: true },
  );
  renderCustomProxiesList();
  updateHomeWarning();

  const res = await sendMessage({ action: 'CHECK_PROXY_HEALTH', proxy: proxyRaw });
  if (res.success && res.data) {
    appState.proxyHealthMap[proxyRaw] = {
      checking: false,
      ok: res.data.ok,
      latency: res.data.latency,
      error: res.data.error,
      checkedAt: res.data.checkedAt,
    };
  } else {
    appState.proxyHealthMap[proxyRaw] = {
      checking: false,
      ok: false,
      error: res.error || 'Ошибка проверки',
      checkedAt: Date.now(),
    };
  }

  renderCustomProxiesList();
  updateHomeWarning();
  renderCurrentSiteWidget();
  return appState.proxyHealthMap[proxyRaw];
}

// Check Health of All Configured Proxies
async function checkAllProxiesHealth() {
  const customList = parseCustomProxies(appState.pacMods.customProxyStringRaw);
  if (!customList.length) {
    updateHomeWarning();
    return;
  }

  for (const proxy of customList) {
    await checkProxyAvailability(proxy.raw);
  }
}

// Update Home Page Warning Banner if proxies are dead
function updateHomeWarning() {
  if (!el.homeProxyWarningBanner) return;

  setActionableErrorElement(el.homeProxyWarningBanner, false);
  const syncError = appState.syncState && appState.syncState.lastError;
  if (syncError) {
    const actionable = isPrivateBrowsingPermissionError(appState.syncState);
    setActionableErrorElement(el.homeProxyWarningBanner, actionable);
    el.homeProxyWarningBanner.style.display = 'flex';
    el.homeProxyWarningText.textContent = actionable
      ? `Не удалось применить PAC: ${syncError} Нажмите, чтобы открыть разрешения Firefox.`
      : `Не удалось применить PAC: ${syncError}`;
    return;
  }

  const customList = parseCustomProxies(appState.pacMods.customProxyStringRaw);
  if (!customList.length) {
    el.homeProxyWarningBanner.style.display = 'none';
    return;
  }

  const deadProxies = customList.filter((p) => {
    const status = appState.proxyHealthMap[p.raw];
    return status && status.ok === false && !status.checking && isProxyHealthFresh(status);
  });

  if (deadProxies.length > 0) {
    el.homeProxyWarningBanner.style.display = 'flex';
    if (deadProxies.length === customList.length) {
      el.homeProxyWarningText.textContent = `Внимание: Все ваши прокси (${deadProxies.length}) недоступны!`;
    } else {
      el.homeProxyWarningText.textContent = `Внимание: ${deadProxies.length} из ${customList.length} ваших прокси недоступен.`;
    }
  } else {
    el.homeProxyWarningBanner.style.display = 'none';
  }
}

// Update Protocol Controls Visibility
function updateProtocolUI() {
  const proto = (el.proxyProtocol?.value || 'HTTP').toUpperCase();
  const isHttpFamily = proto === 'HTTP' || proto === 'HTTPS';

  if (isHttpFamily) {
    if (el.authSectionWrapper) el.authSectionWrapper.style.display = 'block';
    if (el.socksNotice) el.socksNotice.style.display = 'none';
    if (el.proxyPort && !el.proxyPort.value) {
      el.proxyPort.placeholder = proto === 'HTTP' ? '8080' : '443';
    }
  } else {
    // SOCKS5 or SOCKS4
    if (el.authSectionWrapper) el.authSectionWrapper.style.display = 'none';
    if (el.proxyAuthCheck) el.proxyAuthCheck.checked = false;
    if (el.proxyAuthFields) el.proxyAuthFields.style.display = 'none';
    if (el.socksNotice) el.socksNotice.style.display = 'flex';
    if (el.proxyPort && !el.proxyPort.value) {
      el.proxyPort.placeholder = '1080';
    }
  }
}

// Render State
function render() {
  const { syncState, pacMods, notifications, version } = appState;

  if (el.extVersion) {
    el.extVersion.textContent = formatVersion(version);
  }

  // Header status pill
  if (el.headerStatus && el.statusText) {
    if (syncState.currentPacProviderKey === 'none') {
      el.headerStatus.className = 'status-pill inactive';
      el.statusText.textContent = 'Отключено';
    } else if (!syncState.isControlled) {
      el.headerStatus.className = 'status-pill warning';
      el.statusText.textContent = 'Нет контроля';
    } else {
      el.headerStatus.className = 'status-pill active';
      el.statusText.textContent = 'Работает';
    }
  }

  // Sync date & loading icon
  if (el.syncDate) {
    if (syncState.lastPacUpdateStamp) {
      const date = new Date(syncState.lastPacUpdateStamp);
      el.syncDate.textContent = date.toLocaleString('ru-RU', {
        day: 'numeric',
        month: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } else {
      el.syncDate.textContent = 'Не обновлялся';
    }
  }

  if (el.syncBtnIcon) {
    if (syncState.isSyncing) {
      el.syncBtnIcon.classList.add('spinning');
      el.syncBtn.disabled = true;
    } else {
      el.syncBtnIcon.classList.remove('spinning');
      el.syncBtn.disabled = false;
    }
  }

  // Selected Provider Radio Card & Individual Provider Update Dates
  const provStamps = syncState.providerUpdateStamps || {};
  const isCustomSelected = (syncState.currentPacProviderKey === 'customPacUrl');
  if (el.customPacUrlBox) {
    el.customPacUrlBox.style.display = isCustomSelected ? 'block' : 'none';
  }
  if (el.customPacUrlInput && syncState.customPacUrl && !el.customPacUrlInput.value) {
    el.customPacUrlInput.value = syncState.customPacUrl;
  }

  el.providerCards.forEach((card) => {
    const provKey = card.dataset.provider;
    const isSelected = provKey === (syncState.currentPacProviderKey || 'none');
    card.classList.toggle('selected', isSelected);
    const radio = card.querySelector('input[type="radio"]');
    if (radio) radio.checked = isSelected;

    const dateEl = card.querySelector('[data-provider-date]');
    if (dateEl) {
      if (provKey === 'onlyOwnSites') {
        dateEl.textContent = '🕒 Локальные правила';
      } else if (provKey === 'customPacUrl' && !syncState.customPacUrl) {
        dateEl.textContent = '🕒 Укажите ссылку';
      } else {
        const stamp = provStamps[provKey] || (provKey === syncState.currentPacProviderKey ? syncState.lastPacUpdateStamp : 0);
        if (stamp) {
          const d = new Date(stamp);
          dateEl.textContent = `🕒 Обновлен: ${d.toLocaleString('ru-RU', {
            day: 'numeric',
            month: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          })}`;
        } else {
          dateEl.textContent = '🕒 Еще не обновлялся';
        }
      }
    }
  });

  // Tor, WARP, Custom proxies
  if (el.torToggle) el.torToggle.checked = Boolean(pacMods.ifUseLocalTor);
  if (el.warpToggle) el.warpToggle.checked = Boolean(pacMods.ifUseLocalWarp);
  if (el.ownOnlyToggle) el.ownOnlyToggle.checked = Boolean(pacMods.ifUseOwnProxiesOnlyForOwnSites);
  if (el.customProxyText && !document.activeElement?.isSameNode(el.customProxyText)) {
    el.customProxyText.value = pacMods.customProxyStringRaw || '';
  }

  // Modifiers
  if (el.httpsOnlyToggle) el.httpsOnlyToggle.checked = Boolean(pacMods.ifProxyHttpsUrlsOnly);
  if (el.secureProxiesOnlyToggle) el.secureProxiesOnlyToggle.checked = Boolean(pacMods.ifUseSecureProxiesOnly);
  if (el.prohibitDnsToggle) el.prohibitDnsToggle.checked = Boolean(pacMods.ifProhibitDns);
  if (el.proxyOrDieToggle) el.proxyOrDieToggle.checked = pacMods.ifProxyOrDie !== false;
  if (el.moreDomainsToggle) el.moreDomainsToggle.checked = Boolean(pacMods.ifProxyMoreDomains);

  // Notifications
  if (el.notifPacErrorToggle) el.notifPacErrorToggle.checked = notifications['pac-error'] !== false;
  if (el.notifExtErrorToggle) el.notifExtErrorToggle.checked = notifications['ext-error'] !== false;
  if (el.notifNoControlToggle) el.notifNoControlToggle.checked = notifications['no-control'] !== false;

  // Render Stats, Current Site, and Proxies
  renderSitesStats();
  renderCurrentSiteWidget();
  renderCustomProxiesList();
  updateHomeWarning();
  updateProtocolUI();
  prefillQuickAddInput();
}

// Render Stats Counters in Sites Tab (Instant O(1) from lightweight state)
function renderSitesStats() {
  const stats = appState.exceptionStats || { includedCount: 0, excludedCount: 0, whitelistCount: 0 };
  if (el.statIncludedCount) el.statIncludedCount.textContent = stats.includedCount;
  if (el.statExcludedCount) el.statExcludedCount.textContent = stats.excludedCount;
  if (el.statWhitelistCount) el.statWhitelistCount.textContent = stats.whitelistCount;
}

// Render Custom Proxies in Structured Form View
function renderCustomProxiesList() {
  if (!el.proxyCardsList) return;

  const rawString = appState.pacMods.customProxyStringRaw || '';
  const list = parseCustomProxies(rawString);

  el.proxyCardsList.innerHTML = '';

  if (list.length === 0) {
    el.proxyCardsList.innerHTML = `<div class="empty-state">Свои прокси не добавлены</div>`;
    return;
  }

  list.forEach((item) => {
    const health = appState.proxyHealthMap[item.raw] || {};

    const itemEl = document.createElement('div');
    itemEl.className = 'proxy-item';

    const infoDiv = document.createElement('div');
    infoDiv.style.display = 'flex';
    infoDiv.style.alignItems = 'center';
    infoDiv.style.overflow = 'hidden';
    infoDiv.style.flex = '1';

    const badgeSpan = document.createElement('span');
    badgeSpan.className = 'proxy-badge';
    badgeSpan.textContent = item.type;
    infoDiv.appendChild(badgeSpan);

    const addrSpan = document.createElement('span');
    addrSpan.className = 'proxy-addr';
    addrSpan.title = item.address;
    addrSpan.textContent = item.address;
    infoDiv.appendChild(addrSpan);

    if (item.hasAuth) {
      const authSpan = document.createElement('span');
      authSpan.className = 'proxy-auth-tag';
      authSpan.title = item.username ? `Логин: ${item.username}` : 'Авторизация';
      authSpan.textContent = '🔒';
      infoDiv.appendChild(authSpan);
    }

    const statusSpan = document.createElement('span');
    const checkedAt = Number(health.checkedAt);
    const checkedAtText = Number.isFinite(checkedAt) && checkedAt > 0
      ? new Date(checkedAt).toLocaleString('ru-RU')
      : '';
    const isStale = typeof health.ok === 'boolean' && !isProxyHealthFresh(health);
    if (health.checking) {
      statusSpan.className = 'proxy-status-tag checking';
      statusSpan.textContent = '🔄 Проверка';
    } else if (health.ok === true) {
      statusSpan.className = `proxy-status-tag ${isStale ? 'stale' : 'online'}`;
      const latency = Number.isFinite(health.latency) ? `${health.latency}мс` : 'Доступен';
      statusSpan.title = checkedAtText
        ? `Задержка: ${latency}. Последняя проверка: ${checkedAtText}${isStale ? '. Результат мог устареть' : ''}`
        : `Задержка: ${latency}`;
      statusSpan.textContent = `${isStale ? '🕘' : '🟢'} ${latency}`;
    } else if (health.ok === false) {
      statusSpan.className = `proxy-status-tag ${isStale ? 'stale' : 'offline'}`;
      const errorText = health.error || 'Недоступен';
      statusSpan.title = checkedAtText
        ? `${errorText}. Последняя проверка: ${checkedAtText}${isStale ? '. Результат мог устареть' : ''}`
        : errorText;
      statusSpan.textContent = isStale ? '🕘 Нет связи' : '🔴 Недоступен';
    } else {
      statusSpan.className = 'proxy-status-tag checking';
      statusSpan.textContent = '❓ Не проверен';
    }
    infoDiv.appendChild(statusSpan);

    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'proxy-actions';

    const recheckBtn = document.createElement('button');
    recheckBtn.className = 'icon-btn recheck-btn';
    recheckBtn.title = 'Проверить доступность';
    recheckBtn.textContent = '🔄';
    recheckBtn.addEventListener('click', async () => {
      showToast(`Проверка ${item.address}...`);
      const res = await checkProxyAvailability(item.raw);
      if (res.ok) {
        showToast(`✓ ${item.address} доступен (${res.latency} мс)`);
      } else {
        showToast(`✕ ${item.address} недоступен: ${res.error || 'Сбой'}`);
      }
    });
    actionsDiv.appendChild(recheckBtn);

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'icon-btn delete delete-btn';
    deleteBtn.title = 'Удалить';
    deleteBtn.textContent = '✕';
    deleteBtn.addEventListener('click', async () => {
      const currentList = parseCustomProxies(appState.pacMods.customProxyStringRaw || '');
      let deleted = false;
      const newList = currentList.filter((p) => {
        if (!deleted && p.raw === item.raw) {
          deleted = true;
          return false;
        }
        return true;
      });
      delete appState.proxyHealthMap[item.raw];
      const newRaw = newList.map((p) => p.raw).join(';\n');
      const mods = { customProxyStringRaw: newRaw };
      const res = await sendMessage({ action: 'SAVE_MODS', mods });
      if (res.success) {
        appState.pacMods = res.data;
        render();
        showToast('Прокси удалён');
      }
    });
    actionsDiv.appendChild(deleteBtn);

    itemEl.appendChild(infoDiv);
    itemEl.appendChild(actionsDiv);
    el.proxyCardsList.appendChild(itemEl);
  });
}

// Add Proxy from Structured Form with Instant Health Check
async function handleAddStructuredProxy() {
  if (el.proxyFormAlert) el.proxyFormAlert.style.display = 'none';

  const protocol = (el.proxyProtocol?.value || 'HTTP').toUpperCase();
  let host = (el.proxyHost?.value || '').trim();
  let port = (el.proxyPort?.value || '').trim();
  const hasAuth = el.proxyAuthCheck?.checked && (protocol === 'HTTP' || protocol === 'HTTPS');
  const user = (el.proxyUser?.value || '').trim();
  const pass = (el.proxyPass?.value || '').trim();

  if (!host) {
    showFormAlert('Укажите IP-адрес или хост (напр. 127.0.0.1)');
    el.proxyHost?.focus();
    return;
  }

  const parsedHostInput = parseProxyHostInput(host, port);
  if (!parsedHostInput) {
    showFormAlert('Некорректный IP-адрес или хост');
    el.proxyHost?.focus();
    return;
  }
  host = parsedHostInput.host;
  port = parsedHostInput.port;

  if (!port) {
    port = protocol === 'HTTP' ? '8080' : protocol === 'HTTPS' ? '443' : '1080';
  }

  let proxyLine = '';
  if (hasAuth && (user || pass)) {
    proxyLine = `${protocol} ${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
  } else {
    proxyLine = `${protocol} ${host}:${port}`;
  }

  const [candidateProxy] = parseCustomProxies(proxyLine);
  if (!candidateProxy) {
    showFormAlert('Проверьте адрес прокси и номер порта (1–65535)');
    return;
  }

  const currentRaw = appState.pacMods.customProxyStringRaw || '';
  const currentList = parseCustomProxies(currentRaw);

  // Check duplicates
  if (currentList.some((p) => p.address === candidateProxy.address && p.type === candidateProxy.type)) {
    showFormAlert('Такой прокси уже добавлен в список');
    return;
  }

  setAddButtonLoading(true);

  try {
    const health = await sendMessage({ action: 'CHECK_PROXY_HEALTH', proxy: proxyLine });
    setAddButtonLoading(false);

    if (!health.success || !health.data || !health.data.ok) {
      const errorMsg = (health.data && health.data.error) || health.error || 'Сервер не отвечает';
      showFormAlert(`Прокси недоступен: ${errorMsg}`);
      return;
    }

    appState.proxyHealthMap[proxyLine] = {
      ok: true,
      latency: health.data.latency,
      checking: false,
      checkedAt: health.data.checkedAt,
    };

    currentList.push({ raw: proxyLine });
    const newRaw = currentList.map((p) => p.raw).join(';\n');

    const mods = { customProxyStringRaw: newRaw };
    const res = await sendMessage({ action: 'SAVE_MODS', mods });

    if (res.success) {
      appState.pacMods = res.data;
      if (el.proxyHost) el.proxyHost.value = '';
      if (el.proxyPort) el.proxyPort.value = '';
      if (el.proxyUser) el.proxyUser.value = '';
      if (el.proxyPass) el.proxyPass.value = '';
      if (el.proxyFormAlert) el.proxyFormAlert.style.display = 'none';
      render();
      showToast(`✓ Прокси доступен (${health.data.latency} мс) и добавлен!`);
    } else {
      showFormAlert(`Ошибка сохранения: ${res.error || 'Сбой'}`);
      if (isPrivateBrowsingPermissionError(res)) {
        showResponseError(res, { prefix: 'Ошибка сохранения: ' });
      }
    }
  } catch (err) {
    setAddButtonLoading(false);
    showFormAlert(`Ошибка проверки: ${err.message || 'Сбой сети'}`);
  }
}

function showFormAlert(msg) {
  if (!el.proxyFormAlert || !el.proxyFormAlertText) return;
  el.proxyFormAlertText.textContent = msg;
  el.proxyFormAlert.style.display = 'flex';
}

function setAddButtonLoading(isLoading) {
  if (!el.addProxyBtn) return;
  el.addProxyBtn.disabled = isLoading;
  if (isLoading) {
    if (el.addProxyBtnIcon) el.addProxyBtnIcon.textContent = '⏳';
    if (el.addProxyBtnText) el.addProxyBtnText.textContent = 'Проверка...';
  } else {
    if (el.addProxyBtnIcon) el.addProxyBtnIcon.textContent = '+';
    if (el.addProxyBtnText) el.addProxyBtnText.textContent = 'Добавить и проверить';
  }
}

// State for domain file import
let pendingImportDomains = [];

/**
 * Safely parse and validate domains from an uploaded File object.
 */
async function parseAndValidateDomainFile(file) {
  if (!file) {
    throw new Error('Файл не выбран');
  }

  // 1. Check file extension against known incompatible/dangerous binary extensions
  const fileName = (file.name || '').toLowerCase();
  const ext = fileName.includes('.') ? fileName.split('.').pop() : '';
  const dangerousExts = [
    'exe', 'dll', 'bin', 'zip', 'rar', '7z', 'tar', 'gz', 'iso', 'pdf',
    'png', 'jpg', 'jpeg', 'gif', 'webp', 'mp4', 'mp3', 'avi', 'mkv',
    'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'apk', 'dmg', 'class',
    'jar', 'dat', 'db', 'sqlite'
  ];

  if (ext && dangerousExts.includes(ext)) {
    throw new Error(`Файл имеет неподдерживаемый формат (.${ext}). Поддерживаются только текстовые файлы (.txt) со списком доменов.`);
  }

  // 2. File size limit (5MB max ~ 100,000 domains)
  const MAX_SIZE = 5 * 1024 * 1024;
  if (file.size > MAX_SIZE) {
    throw new Error(`Файл слишком большой (${(file.size / (1024 * 1024)).toFixed(1)} МБ). Максимальный размер текстового файла: 5 МБ.`);
  }

  // 3. Read file safely as text (UTF-8) with timeout
  let rawText = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    const timer = setTimeout(() => {
      reader.abort();
      reject(new Error('Превышено время чтения файла'));
    }, 15000);

    reader.onload = () => {
      clearTimeout(timer);
      resolve(reader.result);
    };
    reader.onerror = () => {
      clearTimeout(timer);
      reject(new Error('Не удалось прочитать файл'));
    };
    reader.onabort = () => {
      clearTimeout(timer);
      reject(new Error('Чтение файла прервано'));
    };

    reader.readAsText(file, 'UTF-8');
  });

  if (typeof rawText !== 'string') {
    throw new Error('Не удалось декодировать содержимое файла');
  }

  // 4. Strip UTF-8 Byte Order Mark (BOM) if present
  if (rawText.charCodeAt(0) === 0xFEFF) {
    rawText = rawText.slice(1);
  }

  if (!rawText.trim()) {
    throw new Error('Файл пуст или содержит только пробелы');
  }

  // 5. Binary data protection (check first 8KB for null bytes and non-printable control chars)
  const sample = rawText.slice(0, 8192);
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(sample)) {
    throw new Error('Файл содержит нечитаемые бинарные данные. Поддерживаются только текстовые файлы (.txt) в кодировке UTF-8.');
  }

  // 6. Tokenize line by line (support CRLF, LF, CR)
  const allLines = rawText.split(/\r?\n|\r/);
  // Cap at 100,000 lines to prevent UI freezing
  const lines = allLines.slice(0, 100000);

  const parsedRules = parseDomainRuleLines(lines);
  const validDomains = parsedRules.validDomains;
  const skippedCount = parsedRules.skippedCount;

  if (validDomains.length === 0) {
    throw new Error(`В файле не найдено ни одного корректного доменного имени (пропущено некорректных строк: ${skippedCount}).`);
  }

  return { validDomains, skippedCount };
}

// Handle Options File Import
async function handleOptionsFileImport(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;

  try {
    const { validDomains, skippedCount } = await parseAndValidateDomainFile(file);
    pendingImportDomains = validDomains;

    if (el.importModalCount) el.importModalCount.textContent = validDomains.length;
    if (el.importModalSummary) {
      el.importModalSummary.textContent = '';
      el.importModalSummary.appendChild(document.createTextNode('Найдено корректных доменов: '));
      const strong = document.createElement('strong');
      strong.style.color = 'var(--text-primary)';
      strong.textContent = String(validDomains.length);
      el.importModalSummary.appendChild(strong);
      if (skippedCount > 0) {
        el.importModalSummary.appendChild(document.createTextNode(` (пропущено некорректных строк: ${skippedCount})`));
      }
    }

    if (el.importModal) {
      el.importModal.style.display = 'flex';
    }
  } catch (err) {
    showToast(`❌ Ошибка загрузки: ${err.message}`, 5500);
  } finally {
    if (el.importTxtFileInput) el.importTxtFileInput.value = '';
  }
}

// Handle Confirm Import Modal Action
async function handleConfirmImport() {
  if (!pendingImportDomains || !pendingImportDomains.length) {
    if (el.importModal) el.importModal.style.display = 'none';
    return;
  }

  const selectedTarget = document.querySelector('input[name="importTargetRadio"]:checked')?.value || 'excluded';
  const domains = pendingImportDomains;
  const count = domains.length;
  pendingImportDomains = [];
  if (el.importModal) el.importModal.style.display = 'none';

  showToast(`Сохранение ${count} доменов...`);
  const res = await sendMessage({ action: 'IMPORT_EXCEPTIONS_BATCH', domains, target: selectedTarget });
  if (res.success && res.data) {
    appState.exceptionStats = res.data.exceptionStats || appState.exceptionStats;
    render();
    const categoryName = selectedTarget === 'included'
      ? 'проксируемые'
      : selectedTarget === 'excluded'
        ? 'исключения (напрямую)'
        : 'белый список';
    showToast(`✓ Успешно добавлено ${count} доменов в «${categoryName}»!`, 4000);
  } else {
    showResponseError(res, { prefix: 'Ошибка сохранения: ' });
  }
}

// Handle Options File Export
async function handleOptionsFileExport() {
  showToast('Подготовка файла экспорта...');
  const res = await sendMessage({ action: 'GET_EXCEPTIONS' });
  if (!res.success || !res.data) {
    showToast('Ошибка загрузки списков для экспорта');
    return;
  }

  const exceptions = res.data.exceptions || {};
  const whitelist = res.data.whitelist || [];

  const incList = [];
  const excList = [];
  for (const k in exceptions) {
    if (Object.prototype.hasOwnProperty.call(exceptions, k)) {
      if (exceptions[k] === true) incList.push(k);
      else if (exceptions[k] === false) excList.push(k);
    }
  }
  incList.sort();
  excList.sort();
  const whiteList = [...whitelist].sort();

  const total = incList.length + excList.length + whiteList.length;
  if (total === 0) {
    showToast('Списки сайтов пусты — нечего экспортировать');
    return;
  }

  let content = `# Экспорт правил маршрутизации сайтов\n# Дата: ${new Date().toLocaleString('ru-RU')}\n\n`;
  content += `# 1. ПРОКСИРОВАТЬ ЧЕРЕЗ СВОЙ ПРОКСИ (${incList.length}):\n${incList.join('\n')}\n\n`;
  content += `========================================\n# 2. НЕ ПРОКСИРОВАТЬ / НАПРЯМУЮ (${excList.length}):\n${excList.join('\n')}\n\n`;
  content += `========================================\n# 3. БЕЛЫЙ СПИСОК (${whiteList.length}):\n${whiteList.join('\n')}\n`;

  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'pac-domains-export.txt';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast(`✓ Экспортировано ${total} доменов в pac-domains-export.txt!`);
}

// Quick Add Single Domain from Sites Tab (automatically covers root domain & all subdomains)
async function handleQuickAddDomain() {
  let inputVal = (el.excQuickInput?.value || '').trim().toLowerCase();
  if (!inputVal) {
    showToast('Введите домен (напр. rutracker.org)');
    el.excQuickInput?.focus();
    return;
  }

  const normalized = normalizeDomainRule(inputVal);
  if (!normalized.valid) {
    showToast(normalized.error);
    el.excQuickInput?.focus();
    return;
  }
  let domain = normalized.domain.replace(/^\*\./, '');
  if (domain.startsWith('www.')) {
    domain = domain.slice(4);
  }

  const rootDomain = getRootDomain(domain) || domain;

  const res = await sendMessage({
    action: 'SET_SINGLE_EXCEPTION',
    domain: rootDomain,
    isProxy: true,
    currentTabId: appState.currentSiteTabId,
  });
  if (res.success && res.data) {
    appState.exceptionStats = res.data.exceptionStats || appState.exceptionStats;
    if (rootDomain === appState.currentSiteDomain || domain === appState.currentSiteDomain) {
      appState.currentSiteMatch = res.data.currentSiteMatch || { matched: true, isProxied: true, isExact: true };
    }
    if (el.excQuickInput) el.excQuickInput.value = '';
    render();
    if (!hasAnyConfiguredProxy()) {
      showToast(`⚠️ Домен ${rootDomain} добавлен! Для работы настройте свой прокси во вкладке «Прокси»`, 4500);
    } else {
      showToast(`✓ Добавлено в проксируемые: ${rootDomain} (и все его поддомены)`);
    }
  } else {
    showResponseError(res, { fallback: 'Сбой сохранения' });
  }
}

// Logs Tab: Load and Render
async function loadLogs() {
  const { category, search } = appState.logsState;
  const res = await sendMessage({
    action: 'GET_LOGS',
    category,
    search,
    limit: 150,
  });

  if (res.success && res.data) {
    appState.logsState.items = res.data.logs || [];
    appState.logsState.stats = res.data.stats || {};
    renderLogs();
  }
}

async function copyText(text) {
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand('copy');
  document.body.removeChild(textarea);
  if (!copied) throw new Error('Clipboard API unavailable');
}

function renderLogs() {
  const { items, stats } = appState.logsState;

  // Update Nav Badge
  if (el.logsNavBadge) {
    const errorCount = (stats && stats.errors) || 0;
    if (errorCount > 0) {
      el.logsNavBadge.textContent = errorCount > 99 ? '99+' : errorCount;
      el.logsNavBadge.style.display = 'inline-flex';
    } else {
      el.logsNavBadge.style.display = 'none';
    }
  }

  // Update Total Records Pill
  if (el.logsTotalCountPill) {
    const total = (stats && stats.total) !== undefined ? stats.total : items.length;
    el.logsTotalCountPill.textContent = `${total} ${getPluralRecords(total)}`;
  }

  // Update Filter Category Counters
  if (el.countNetwork) el.countNetwork.textContent = stats.network ? `(${stats.network})` : '';
  if (el.countProxy) el.countProxy.textContent = stats.proxy ? `(${stats.proxy})` : '';
  if (el.countPac) el.countPac.textContent = stats.pac ? `(${stats.pac})` : '';
  if (el.countAuth) el.countAuth.textContent = stats.auth ? `(${stats.auth})` : '';
  if (el.countSystem) el.countSystem.textContent = stats.system ? `(${stats.system})` : '';

  if (!el.logsContainer) return;

  if (!items.length) {
    const isFiltered = appState.logsState.category !== 'all' || Boolean(appState.logsState.search.trim());
    const emptyState = document.createElement('div');
    emptyState.className = 'empty-state';

    const title = document.createElement('p');
    title.style.fontSize = '14.5px';
    title.style.fontWeight = '600';
    title.style.marginBottom = '4px';
    title.textContent = isFiltered
      ? '🔍 Записей по фильтру не найдено'
      : '🛡️ Ошибок не зафиксировано';

    const description = document.createElement('p');
    description.style.fontSize = '11.5px';
    description.style.color = 'var(--text-muted)';
    description.textContent = isFiltered
      ? 'Попробуйте изменить категорию или очистить поисковый запрос'
      : 'Все сетевые запросы, прокси и PAC-скрипты работают в штатном режиме';

    emptyState.appendChild(title);
    emptyState.appendChild(description);
    el.logsContainer.textContent = '';
    el.logsContainer.appendChild(emptyState);
    return;
  }

  el.logsContainer.innerHTML = '';
  const categoryLabels = {
    network: '🌐 Сеть',
    proxy: '⚙️ Прокси',
    pac: '⚡ PAC',
    auth: '🔒 Auth',
    system: '💻 Система',
  };

  items.forEach((log) => {
    const card = document.createElement('div');
    const level = log.level || 'error';
    card.className = `log-card level-${level}`;

    const date = new Date(log.timestamp);
    const timeFormatted = date.toLocaleTimeString('ru-RU', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });

    const levelBadgeText = level === 'error' ? 'Ошибка' : level === 'warn' ? 'Предупреждение' : 'Инфо';
    const catText = categoryLabels[log.category] || log.category;

    const header = document.createElement('div');
    header.className = 'log-card-header';

    const badges = document.createElement('div');
    badges.className = 'log-card-badges';

    const levelBadge = document.createElement('span');
    levelBadge.className = `log-badge ${level}`;
    levelBadge.textContent = levelBadgeText;
    badges.appendChild(levelBadge);

    const catBadge = document.createElement('span');
    catBadge.className = 'category-tag';
    catBadge.textContent = catText;
    badges.appendChild(catBadge);

    if (log.count > 1) {
      const repeatBadge = document.createElement('span');
      repeatBadge.className = 'log-repeat-badge';
      repeatBadge.title = `Повторено ${log.count} раз`;
      repeatBadge.textContent = `×${log.count}`;
      badges.appendChild(repeatBadge);
    }
    header.appendChild(badges);

    const headerActions = document.createElement('div');
    headerActions.className = 'log-card-actions';

    const timeSpan = document.createElement('span');
    timeSpan.className = 'log-time';
    timeSpan.title = date.toLocaleString('ru-RU');
    timeSpan.textContent = `🕒 ${timeFormatted}`;
    headerActions.appendChild(timeSpan);

    const copyButton = document.createElement('button');
    copyButton.type = 'button';
    copyButton.className = 'log-copy-btn';
    copyButton.title = 'Скопировать эту запись';
    copyButton.setAttribute('aria-label', 'Скопировать эту запись журнала');
    copyButton.textContent = '⧉';
    headerActions.appendChild(copyButton);
    header.appendChild(headerActions);

    card.appendChild(header);

    const titleDiv = document.createElement('div');
    titleDiv.className = 'log-card-title';
    titleDiv.textContent = log.title || '';
    card.appendChild(titleDiv);

    if (log.message) {
      const msgDiv = document.createElement('div');
      msgDiv.className = 'log-card-message';
      msgDiv.textContent = log.message;
      card.appendChild(msgDiv);
    }

    let detailsJson = '';
    if (log.details) {
      try {
        detailsJson = typeof log.details === 'object' ? JSON.stringify(log.details, null, 2) : String(log.details);
      } catch {
        detailsJson = String(log.details);
      }
    }

    if (detailsJson) {
      const hint = document.createElement('div');
      hint.className = 'log-expand-hint';
      hint.textContent = '▶ Нажмите, чтобы посмотреть подробности';
      card.appendChild(hint);

      const detailsBlock = document.createElement('div');
      detailsBlock.className = 'log-details-block';
      detailsBlock.textContent = detailsJson;
      card.appendChild(detailsBlock);

      card.addEventListener('click', () => {
        card.classList.toggle('expanded');
        hint.textContent = card.classList.contains('expanded')
          ? '▼ Скрыть подробности'
          : '▶ Нажмите, чтобы посмотреть подробности';
      });
    }

    copyButton.addEventListener('click', async (event) => {
      event.stopPropagation();
      try {
        await copyText(formatLogEntryForClipboard(log, detailsJson));
        copyButton.classList.add('copied');
        copyButton.textContent = '✓';
        showToast('✓ Запись скопирована');
        setTimeout(() => {
          copyButton.classList.remove('copied');
          copyButton.textContent = '⧉';
        }, 900);
      } catch {
        showToast('Не удалось скопировать запись');
      }
    });

    el.logsContainer.appendChild(card);
  });
}


function getPluralRecords(n) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'запись';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 'записи';
  return 'записей';
}

// Logs Tab: Actions
async function handleCopyLogs() {
  const res = await sendMessage({
    action: 'EXPORT_LOGS',
    category: appState.logsState.category,
    search: appState.logsState.search,
  });

  if (res.success && res.data && res.data.text) {
    try {
      await copyText(res.data.text);
      showToast('✓ Логи скопированы в буфер обмена!');
    } catch {
      showToast('Не удалось скопировать в буфер обмена');
    }
  } else {
    showToast('Логи пусты — нечего копировать');
  }
}

async function handleExportLogs() {
  const res = await sendMessage({
    action: 'EXPORT_LOGS',
    category: appState.logsState.category,
    search: appState.logsState.search,
  });

  if (!res.success || !res.data || !res.data.text) {
    showToast('Логи пусты — нечего экспортировать');
    return;
  }

  const blob = new Blob([res.data.text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const dateStr = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `runet-censorship-logs-${dateStr}.txt`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast('✓ Файл логов успешно выгружен!');
}

async function handleClearLogs() {
  if (!confirm('Очистить весь журнал ошибок и сбоев?')) return;
  const res = await sendMessage({ action: 'CLEAR_LOGS' });
  if (res.success) {
    appState.logsState.items = [];
    appState.logsState.stats = res.data?.stats || {};
    renderLogs();
    showToast('Журнал логов очищен');
  }
}

// Init State from background (Ultra-lightweight and fast)
async function loadState(currentDomain = '', currentTabId = null, { preloadLogs = true } = {}) {
  const loadRevision = ++stateLoadRevision;
  const res = await sendMessage({
    action: 'GET_STATE',
    currentDomain,
    currentTabId,
    includeExceptions: false,
  });
  if (loadRevision !== stateLoadRevision) return;
  if (res.success && res.data) {
    appState.syncState = res.data.syncState || appState.syncState;
    appState.pacMods = res.data.pacMods || appState.pacMods;
    appState.defaultConfigs = res.data.defaultConfigs || appState.defaultConfigs;
    appState.notifications = res.data.notifications || appState.notifications;
    appState.lastErrors = res.data.lastErrors || appState.lastErrors;
    appState.version = formatVersion(res.data.version || (typeof chrome !== 'undefined' && chrome.runtime?.getManifest?.()?.version) || DEFAULT_VERSION);
    appState.exceptionStats = res.data.exceptionStats || appState.exceptionStats;
    appState.proxyHealthMap = res.data.proxyHealthMap || {};
    appState.currentSiteMatch = res.data.currentSiteMatch || { matched: false };
    appState.currentSiteRoute = res.data.currentSiteRoute || null;
    render();
  }

  // Preload log stats for navigation badge
  if (preloadLogs) loadLogs().catch(() => { });
}

async function refreshStateFromActiveTab({ preloadLogs = false } = {}) {
  let domain = '';
  let currentTabId = null;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url) {
      const domainInfo = extractValidWebDomain(tab.url);
      if (domainInfo) {
        domain = domainInfo.rootDomain || domainInfo.fullHost;
        currentTabId = Number.isInteger(tab.id) ? tab.id : null;
      }
    }
  } catch { }

  appState.currentSiteDomain = domain;
  appState.currentSiteTabId = currentTabId;
  await loadState(domain, currentTabId, { preloadLogs });
  prefillQuickAddInput();
}

function scheduleExternalStateRefresh() {
  if (externalStateRefreshTimer !== null) {
    clearTimeout(externalStateRefreshTimer);
  }
  externalStateRefreshTimer = setTimeout(() => {
    externalStateRefreshTimer = null;
    refreshStateFromActiveTab().catch(() => { });
  }, 50);
}

function setupExternalStateRefresh() {
  if (chrome.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === 'local' &&
          Object.prototype.hasOwnProperty.call(changes || {}, PAC_MODS_STORAGE_KEY)) {
        scheduleExternalStateRefresh();
      }
    });
  }

  window.addEventListener('focus', scheduleExternalStateRefresh);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') scheduleExternalStateRefresh();
  });
}

// Event Listeners
function setupEvents() {
  const activateActionableError = (event, action) => {
    if (event.type === 'keydown' && event.key !== 'Enter' && event.key !== ' ') {
      return;
    }
    event.preventDefault();
    action();
  };

  if (el.homeProxyWarningBanner) {
    const activateHomeWarning = (event) => {
      if (el.homeProxyWarningBanner.dataset.errorAction !==
          'open-private-browsing-settings') {
        return;
      }
      activateActionableError(event, openPrivateBrowsingSettings);
    };
    el.homeProxyWarningBanner.addEventListener('click', activateHomeWarning);
    el.homeProxyWarningBanner.addEventListener('keydown', activateHomeWarning);
  }

  if (el.toast) {
    const activateToast = (event) => {
      if (!toastAction) return;
      activateActionableError(event, toastAction);
    };
    el.toast.addEventListener('click', activateToast);
    el.toast.addEventListener('keydown', activateToast);
  }

  // Navigation Tabs
  el.navTabs.forEach((btn) => {
    btn.addEventListener('click', () => {
      const tabKey = btn.dataset.tab;
      el.navTabs.forEach((b) => b.classList.toggle('active', b === btn));
      el.tabContents.forEach((content) => {
        content.classList.toggle('active', content.id === `tab-${tabKey}`);
      });
      appState.activeTab = tabKey;
      if (tabKey === 'logs') {
        loadLogs();
      }
    });
  });

  // Current Site Actions
  if (el.setSiteProxyBtn) {
    el.setSiteProxyBtn.addEventListener('click', handleSetCurrentSiteProxy);
  }
  if (el.setSiteDirectBtn) {
    el.setSiteDirectBtn.addEventListener('click', handleSetCurrentSiteDirect);
  }
  if (el.resetSitePacBtn) {
    el.resetSitePacBtn.addEventListener('click', handleResetCurrentSitePac);
  }

  // Sites Tab: Quick Add Domain
  if (el.addExcQuickBtn && el.excQuickInput) {
    el.addExcQuickBtn.addEventListener('click', handleQuickAddDomain);
    el.excQuickInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleQuickAddDomain();
    });
  }

  // Sites Tab: File Import (.txt)
  if (el.importTxtBtn && el.importTxtFileInput) {
    el.importTxtBtn.addEventListener('click', () => {
      // Firefox destroys a toolbar popup when the native file picker opens,
      // so its change event can never be processed by this document. Continue
      // the operation in a persistent extension tab instead.
      if (isFirefoxRuntime()) {
        openStandaloneDomainImport();
        return;
      }
      el.importTxtFileInput.click();
    });
    el.importTxtFileInput.addEventListener('change', handleOptionsFileImport);
  }

  // Sites Tab: File Export (.txt)
  if (el.exportTxtBtn) {
    el.exportTxtBtn.addEventListener('click', handleOptionsFileExport);
  }

  // Sites Tab: Clear Proxied Domains
  if (el.clearProxiedDomainsBtn) {
    el.clearProxiedDomainsBtn.addEventListener('click', async () => {
      const count = appState.exceptionStats?.includedCount || 0;
      if (count === 0) {
        showToast('Список проксируемых доменов пуст');
        return;
      }
      if (!confirm(`Удалить все проксируемые домены (${count} шт.)?`)) {
        return;
      }
      const res = await sendMessage({ action: 'CLEAR_EXCEPTIONS_CATEGORY', target: 'included' });
      if (res && res.success) {
        if (res.data?.exceptionStats) {
          appState.exceptionStats = res.data.exceptionStats;
        }
        // Also refresh current site match status
        if (appState.currentSiteDomain) {
          const matchRes = await sendMessage({
            action: 'GET_STATE',
            currentDomain: appState.currentSiteDomain,
            currentTabId: appState.currentSiteTabId,
            includeExceptions: false,
          });
          if (matchRes?.success && matchRes.data) {
            appState.currentSiteMatch = matchRes.data.currentSiteMatch || { matched: false };
            appState.currentSiteRoute = matchRes.data.currentSiteRoute || null;
          }
        }
        render();
        showToast('✓ Список проксируемых доменов очищен');
      } else {
        showResponseError(res, { prefix: 'Ошибка очистки: ' });
      }
    });
  }

  // Domain Import Modal Actions
  if (el.confirmImportBtn) {
    el.confirmImportBtn.addEventListener('click', handleConfirmImport);
  }

  const hideImportModal = () => {
    pendingImportDomains = [];
    if (el.importModal) el.importModal.style.display = 'none';
  };

  if (el.cancelImportBtn) {
    el.cancelImportBtn.addEventListener('click', hideImportModal);
  }

  if (el.closeImportModalBtn) {
    el.closeImportModalBtn.addEventListener('click', hideImportModal);
  }

  // Sites Tab: Open Full Editor in New Tab
  if (el.openExceptionsPageBtn) {
    el.openExceptionsPageBtn.addEventListener('click', () => {
      chrome.tabs.create({ url: chrome.runtime.getURL('pages/exceptions/index.html') });
    });
  }

  // Custom PAC URL Apply Handler
  async function handleApplyCustomPacUrl() {
    const rawUrl = (el.customPacUrlInput?.value || '').trim();
    if (!rawUrl) {
      showToast('Введите адрес ссылки на PAC-скрипт');
      el.customPacUrlInput?.focus();
      return;
    }

    try {
      const parsed = new URL(rawUrl);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        showToast(`Недопустимый протокол: ${parsed.protocol}. Разрешён только https:`);
        return;
      }
      const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
      const isPrivateOrLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1' ||
        /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) ||
        /^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(host) ||
        /^192\.168\.\d{1,3}\.\d{1,3}$/.test(host) ||
        /^169\.254\.\d{1,3}\.\d{1,3}$/.test(host) ||
        /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
      if (parsed.protocol === 'http:' && !isPrivateOrLocal) {
        showToast('Разрешён только защищённый протокол https:. Небезопасный http: заблокирован.');
        return;
      }
      if (parsed.username || parsed.password) {
        showToast('URL не должен содержать логин и пароль (user:password@)');
        return;
      }
    } catch {
      showToast('Некорректный формат URL');
      return;
    }

    if (el.saveCustomPacUrlBtn) el.saveCustomPacUrlBtn.disabled = true;
    showToast('Загрузка и применение своего PAC-скрипта...');
    const res = await sendMessage({
      action: 'INSTALL_PAC',
      key: 'customPacUrl',
      customPacUrl: rawUrl,
    });
    if (el.saveCustomPacUrlBtn) el.saveCustomPacUrlBtn.disabled = false;

    if (res.success && res.data) {
      appState.syncState = res.data;
      render();
      showToast('✓ Свой PAC-скрипт успешно загружен и применён!');
    } else {
      showResponseError(res, { fallback: 'Не удалось загрузить PAC' });
      render();
    }
  }

  if (el.saveCustomPacUrlBtn) {
    el.saveCustomPacUrlBtn.addEventListener('click', handleApplyCustomPacUrl);
  }
  if (el.customPacUrlInput) {
    el.customPacUrlInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleApplyCustomPacUrl();
    });
  }

  // Provider Selection with Gating for onlyOwnSites and customPacUrl
  el.providerCards.forEach((card) => {
    card.addEventListener('click', async () => {
      const key = card.dataset.provider;
      if (key === appState.syncState.currentPacProviderKey) return;

      if (key === 'onlyOwnSites') {
        const canUseOwnSites = hasAnyWorkingProxy();
        if (!canUseOwnSites) {
          showToast('❌ Нет рабочего прокси! Настройте прокси во вкладке «Прокси»', 3000);
          render();
          return;
        }
      }

      if (key === 'customPacUrl') {
        if (el.customPacUrlBox) el.customPacUrlBox.style.display = 'block';
        const urlToApply = (el.customPacUrlInput?.value || appState.syncState.customPacUrl || '').trim();
        if (urlToApply) {
          showToast('Установка своего PAC-скрипта...');
          const res = await sendMessage({ action: 'INSTALL_PAC', key: 'customPacUrl', customPacUrl: urlToApply });
          if (res.success) {
            appState.syncState = res.data;
            render();
            showToast('Свой PAC-скрипт установлен!');
          } else {
            showResponseError(res, { fallback: 'Не удалось загрузить PAC' });
            render();
          }
        } else {
          el.customPacUrlInput?.focus();
          showToast('Укажите прямую ссылку на PAC-скрипт и нажмите «Применить»');
        }
        return;
      }

      if (key === 'none') {
        showToast('Отключение прокси...');
        const res = await sendMessage({ action: 'CLEAR_PAC' });
        if (res.success) {
          appState.syncState = res.data;
          render();
          showToast('Прокси отключен');
        }
      } else {
        showToast(`Установка PAC-скрипта "${key}"...`);
        const res = await sendMessage({ action: 'INSTALL_PAC', key });
        if (res.success) {
          appState.syncState = res.data;
          render();
          showToast(`PAC-скрипт "${key}" установлен!`);
        } else {
          showResponseError(res, { fallback: 'Не удалось установить PAC' });
        }
      }
    });
  });

  // Manual Sync PAC
  if (el.syncBtn) {
    el.syncBtn.addEventListener('click', async () => {
      const currentKey = appState.syncState.currentPacProviderKey;
      if (!currentKey || currentKey === 'none') {
        showToast('Сначала выберите PAC-провайдера');
        return;
      }
      showToast('Обновление PAC-скрипта...');
      appState.syncState.isSyncing = true;
      render();

      const res = await sendMessage({ action: 'SYNC_PAC', key: currentKey });
      appState.syncState.isSyncing = false;
      if (res.success) {
        appState.syncState = res.data;
        showToast('PAC-скрипт успешно обновлён!');
      } else {
        showResponseError(res, { prefix: 'Ошибка обновления: ', fallback: 'Сбой сети' });
      }
      render();
    });
  }

  // Own Proxies: Protocol change updates UI
  if (el.proxyProtocol) {
    el.proxyProtocol.addEventListener('change', updateProtocolUI);
  }

  // Own Proxies: Auth Checkbox Toggle
  if (el.proxyAuthCheck && el.proxyAuthFields) {
    el.proxyAuthCheck.addEventListener('change', () => {
      el.proxyAuthFields.style.display = el.proxyAuthCheck.checked ? 'grid' : 'none';
    });
  }

  // Own Proxies: Add Structured Proxy Button
  if (el.addProxyBtn) {
    el.addProxyBtn.addEventListener('click', handleAddStructuredProxy);
  }

  // Own Proxies: Recheck All Proxies Button
  if (el.recheckAllProxiesBtn) {
    el.recheckAllProxiesBtn.addEventListener('click', async () => {
      showToast('Проверка всех прокси...');
      await checkAllProxiesHealth();
      showToast('Проверка завершена');
    });
  }

  // Own Proxies: Editor Mode Toggle (Form vs Raw Text)
  if (el.proxyEditorModeToggle) {
    el.proxyEditorModeToggle.addEventListener('click', () => {
      const isRaw = el.proxyRawView.style.display !== 'none';
      if (isRaw) {
        el.proxyRawView.style.display = 'none';
        el.proxyFormView.style.display = 'block';
        el.proxyEditorModeToggle.textContent = '📝 Текст';
      } else {
        el.proxyFormView.style.display = 'none';
        el.proxyRawView.style.display = 'block';
        el.proxyEditorModeToggle.textContent = '📋 Форма';
        if (el.customProxyText) {
          el.customProxyText.value = appState.pacMods.customProxyStringRaw || '';
        }
      }
    });
  }

  // Save Raw Proxies Textarea
  if (el.saveProxiesBtn) {
    el.saveProxiesBtn.addEventListener('click', async () => {
      const mods = {
        customProxyStringRaw: el.customProxyText?.value || '',
      };

      const res = await sendMessage({ action: 'SAVE_MODS', mods });
      if (res.success) {
        appState.pacMods = res.data;
        renderCustomProxiesList();
        checkAllProxiesHealth().catch(() => { });
        showToast('Прокси применены!');
      } else {
        showResponseError(res, { fallback: 'Неверный формат' });
      }
    });
  }

  // Quick Toggles: Tor, WARP, OwnOnly
  const bindProxyToggle = (checkbox, key, localService = null) => {
    if (!checkbox) return;
    checkbox.addEventListener('change', async () => {
      const previousValue = Boolean(appState.pacMods?.[key]);
      const enabled = Boolean(checkbox.checked);
      checkbox.disabled = true;

      try {
        if (localService && enabled) {
          showToast('Проверяем локальный прокси…');
        }

        const res = localService
          ? await sendMessage({
            action: 'SET_LOCAL_PROXY_ENABLED',
            service: localService,
            enabled,
          })
          : await sendMessage({ action: 'SAVE_MODS', mods: { [key]: enabled } });

        if (!res.success) {
          checkbox.checked = previousValue;
          const actionText = enabled ? 'включить' : 'выключить';
          showResponseError(res, {
            prefix: `Не удалось ${actionText}: `,
            fallback: 'локальный прокси недоступен',
            duration: 4500,
          });
          return;
        }

        appState.pacMods = localService ? res.data.pacMods : res.data;
        updateHomeWarning();

        if (localService && enabled) {
          const health = res.data.health;
          const latency = Number.isFinite(health?.latency) ? `, ${health.latency} мс` : '';
          showToast(`✓ Прокси доступен: ${health.workingProxy}${latency}`);
        } else {
          showToast('Настройки обновлены');
        }
      } catch (err) {
        checkbox.checked = previousValue;
        showToast(`Ошибка: ${err.message || 'не удалось сохранить настройку'}`, 4500);
      } finally {
        checkbox.disabled = false;
      }
    });
  };

  bindProxyToggle(el.torToggle, 'ifUseLocalTor', 'tor');
  bindProxyToggle(el.warpToggle, 'ifUseLocalWarp', 'warp');
  bindProxyToggle(el.ownOnlyToggle, 'ifUseOwnProxiesOnlyForOwnSites');

  // Modifiers: Instant Autosave on change
  const bindModToggle = (element, key) => {
    if (!element) return;
    element.addEventListener('change', async () => {
      const mods = {
        [key]: Boolean(element.checked),
      };

      const res = await sendMessage({ action: 'SAVE_MODS', mods });
      if (res.success) {
        appState.pacMods = res.data;
        showToast('✓ Настройки сохранены');
      } else {
        showResponseError(res, { fallback: 'Не удалось сохранить' });
      }
    });
  };

  bindModToggle(el.httpsOnlyToggle, 'ifProxyHttpsUrlsOnly');
  bindModToggle(el.secureProxiesOnlyToggle, 'ifUseSecureProxiesOnly');
  bindModToggle(el.prohibitDnsToggle, 'ifProhibitDns');
  bindModToggle(el.proxyOrDieToggle, 'ifProxyOrDie');
  bindModToggle(el.moreDomainsToggle, 'ifProxyMoreDomains');

  // Notifications Toggles
  const bindNotifToggle = (element, key) => {
    if (!element) return;
    element.addEventListener('change', async () => {
      await sendMessage({
        action: 'SET_NOTIFICATION_OPTION',
        key,
        enabled: element.checked,
      });
      showToast('Оповещения обновлены');
    });
  };

  bindNotifToggle(el.notifPacErrorToggle, 'pac-error');
  bindNotifToggle(el.notifExtErrorToggle, 'ext-error');
  bindNotifToggle(el.notifNoControlToggle, 'no-control');

  // Diagnostics: Test Connection
  if (el.testConnBtn && el.connResult) {
    el.testConnBtn.addEventListener('click', async () => {
      el.testConnBtn.disabled = true;
      el.connResult.textContent = 'Тестирование...';
      const res = await sendMessage({ action: 'TEST_CONNECTION' });
      el.testConnBtn.disabled = false;
      el.connResult.textContent = '';
      const span = document.createElement('span');
      if (res.success) {
        span.style.color = 'var(--success)';
        span.textContent = `✓ Доступно (${res.latency} мс)`;
      } else {
        span.style.color = 'var(--danger)';
        span.textContent = `✕ Ошибка (${res.error || 'Сбой'})`;
      }
      el.connResult.appendChild(span);
    });
  }

  // Diagnostics: Check Blacklist
  if (el.checkBlacklistBtn) {
    el.checkBlacklistBtn.addEventListener('click', async () => {
      let lookupUrl = '';
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        lookupUrl = normalizeRknLookupUrl(tab?.url || tab?.pendingUrl || '');
      } catch {
        // Fall back to the domain captured when the extension UI was opened.
      }

      if (!lookupUrl && appState.currentSiteDomain) {
        lookupUrl = normalizeRknLookupUrl(`https://${appState.currentSiteDomain}/`);
      }

      if (!lookupUrl) {
        showToast('Откройте обычный сайт и повторите проверку');
        return;
      }

      try {
        await chrome.tabs.create({ url: buildRknBlocklistUrl(lookupUrl) });
      } catch {
        showToast('Не удалось открыть официальный сервис Роскомнадзора');
      }
    });
  }

  // Diagnostics: View PAC Script Modal
  if (el.viewPacScriptBtn && el.pacScriptModal && el.pacScriptContent) {
    el.viewPacScriptBtn.addEventListener('click', async () => {
      const res = await sendMessage({ action: 'GET_PAC_SCRIPT' });
      if (res.success && res.data) {
        el.pacScriptContent.textContent = res.data.cookedPacData || res.data.rawPacData || '// PAC-скрипт не установлен';
        el.pacScriptModal.style.display = 'flex';
      }
    });

    if (el.closePacModalBtn) {
      el.closePacModalBtn.addEventListener('click', () => {
        el.pacScriptModal.style.display = 'none';
      });
    }
  }

  // Diagnostics: Reset Settings
  if (el.resetSettingsBtn) {
    el.resetSettingsBtn.addEventListener('click', async () => {
      if (confirm('Сбросить все настройки к исходным?')) {
        showToast('Сброс настроек...');
        const res = await sendMessage({ action: 'RESET_SETTINGS' });
        if (res.success) {
          await loadState();
          showToast('Настройки сброшены!');
        }
      }
    });
  }

  // Logs Tab: Category Filters
  if (el.logsFilterBtns) {
    el.logsFilterBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        el.logsFilterBtns.forEach((b) => b.classList.toggle('active', b === btn));
        appState.logsState.category = btn.dataset.category || 'all';
        loadLogs();
      });
    });
  }

  // Logs Tab: Search Input & Clear
  let logsSearchDebounce = null;
  if (el.logsSearchInput) {
    el.logsSearchInput.addEventListener('input', () => {
      const val = (el.logsSearchInput.value || '').trim();
      appState.logsState.search = val;
      if (el.clearLogsSearchBtn) {
        el.clearLogsSearchBtn.style.display = val ? 'block' : 'none';
      }
      clearTimeout(logsSearchDebounce);
      logsSearchDebounce = setTimeout(() => {
        loadLogs();
      }, 250);
    });
  }

  if (el.clearLogsSearchBtn && el.logsSearchInput) {
    el.clearLogsSearchBtn.addEventListener('click', () => {
      el.logsSearchInput.value = '';
      appState.logsState.search = '';
      el.clearLogsSearchBtn.style.display = 'none';
      loadLogs();
    });
  }

  // Logs Tab: Action Buttons
  if (el.refreshLogsBtn) {
    el.refreshLogsBtn.addEventListener('click', () => {
      loadLogs();
      showToast('Список логов обновлён');
    });
  }

  if (el.copyLogsBtn) {
    el.copyLogsBtn.addEventListener('click', handleCopyLogs);
  }

  if (el.exportLogsBtn) {
    el.exportLogsBtn.addEventListener('click', handleExportLogs);
  }

  if (el.clearLogsBtn) {
    el.clearLogsBtn.addEventListener('click', handleClearLogs);
  }
}

// Bootstrap
async function initApp() {
  initElements();
  setupEvents();
  render(); // Instant 0ms UI render before async network/storage calls
  await refreshStateFromActiveTab({ preloadLogs: true });
  setupExternalStateRefresh();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}
