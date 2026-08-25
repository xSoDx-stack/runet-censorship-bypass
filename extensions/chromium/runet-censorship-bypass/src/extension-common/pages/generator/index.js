'use strict';

import { parseDomainsInput, generatePacScript, testPacRule, POPULAR_PRESETS } from '../../core/pac-generator.js';

/**
 * Local PAC Generator UI Controller
 */

// State
let generatedPacCode = '';
let currentCustomProxiesString = '';

// DOM Elements
const el = {
  domainsTextarea: document.getElementById('domainsTextarea'),
  domainCounterBadge: document.getElementById('domainCounterBadge'),
  proxyStringInput: document.getElementById('proxyStringInput'),
  optBypassLocal: document.getElementById('optBypassLocal'),
  optProxyOrDie: document.getElementById('optProxyOrDie'),
  optHttpsOnly: document.getElementById('optHttpsOnly'),
  optProhibitDns: document.getElementById('optProhibitDns'),
  generatedCodePreview: document.getElementById('generatedCodePreview'),
  pacSizeBadge: document.getElementById('pacSizeBadge'),
  testUrlInput: document.getElementById('testUrlInput'),
  runTestBtn: document.getElementById('runTestBtn'),
  testResultBox: document.getElementById('testResultBox'),
  testStatusBadge: document.getElementById('testStatusBadge'),
  testExecTime: document.getElementById('testExecTime'),
  testResultRouteText: document.getElementById('testResultRouteText'),
  testResultDetailsText: document.getElementById('testResultDetailsText'),
  downloadPacBtn: document.getElementById('downloadPacBtn'),
  copyPacBtn: document.getElementById('copyPacBtn'),
  copyCodeFooterBtn: document.getElementById('copyCodeFooterBtn'),
  copyDataUriBtn: document.getElementById('copyDataUriBtn'),
  applyToExtensionBtn: document.getElementById('applyToExtensionBtn'),
  importFromExtensionBtn: document.getElementById('importFromExtensionBtn'),
  uploadFileChipBtn: document.getElementById('uploadFileChipBtn'),
  filePickerInput: document.getElementById('filePickerInput'),
  clearDomainsBtn: document.getElementById('clearDomainsBtn'),
  toast: document.getElementById('toast'),
};

function showToast(text, duration = 2500) {
  if (!el.toast) return;
  el.toast.textContent = text;
  el.toast.style.display = 'flex';
  clearTimeout(el.toast._timeout);
  el.toast._timeout = setTimeout(() => {
    el.toast.style.display = 'none';
  }, duration);
}

function sendMessage(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (res) => {
      if (chrome.runtime.lastError) {
        console.warn('sendMessage error:', chrome.runtime.lastError);
        resolve({ success: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(res || { success: true });
      }
    });
  });
}

/**
 * Re-generate PAC script from current UI inputs and update preview
 */
function updateGeneratedPac() {
  const rawDomains = el.domainsTextarea.value || '';
  const parsedDomains = parseDomainsInput(rawDomains);
  
  el.domainCounterBadge.textContent = `${parsedDomains.length} ${getPluralRu(parsedDomains.length, 'домен', 'домена', 'доменов')}`;

  const config = {
    domains: parsedDomains,
    proxies: el.proxyStringInput.value || 'DIRECT',
    fallback: 'DIRECT',
    bypassLocal: el.optBypassLocal.checked,
    ifProxyOrDie: el.optProxyOrDie.checked,
    ifProxyHttpsOnly: el.optHttpsOnly.checked,
    ifProhibitDns: el.optProhibitDns.checked,
  };

  generatedPacCode = generatePacScript(config);
  el.generatedCodePreview.textContent = generatedPacCode;

  const sizeKb = (new Blob([generatedPacCode]).size / 1024).toFixed(1);
  el.pacSizeBadge.textContent = `${sizeKb} КБ`;

  // Auto-run sandbox test if input has a value
  if (el.testUrlInput.value && el.testUrlInput.value.trim()) {
    runSandboxTest();
  }
}

function getPluralRu(n, one, two, five) {
  n = Math.abs(n) % 100;
  const n1 = n % 10;
  if (n > 10 && n < 20) return five;
  if (n1 > 1 && n1 < 5) return two;
  if (n1 === 1) return one;
  return five;
}

/**
 * Test a URL against the current PAC code in the sandbox
 */
function runSandboxTest() {
  const testUrl = (el.testUrlInput.value || '').trim();
  if (!testUrl) {
    el.testResultBox.style.display = 'none';
    return;
  }

  const res = testPacRule(generatedPacCode, testUrl);
  el.testResultBox.style.display = 'flex';

  if (!res.success) {
    el.testStatusBadge.className = 'status-badge error';
    el.testStatusBadge.textContent = 'ОШИБКА';
    el.testExecTime.textContent = '';
    el.testResultRouteText.textContent = res.error || 'Ошибка исполнения';
    el.testResultDetailsText.textContent = 'Проверьте синтаксис правил';
    return;
  }

  if (res.isProxied) {
    el.testStatusBadge.className = 'status-badge proxied';
    el.testStatusBadge.textContent = '⚡ ПРОКСИ';
    el.testResultDetailsText.textContent = `Домен ${res.host} совпал со списком правил`;
  } else {
    el.testStatusBadge.className = 'status-badge direct';
    el.testStatusBadge.textContent = '⚪ НАПРЯМУЮ';
    el.testResultDetailsText.textContent = `Домен ${res.host} открывается напрямую (DIRECT)`;
  }

  el.testExecTime.textContent = `${res.executionTimeMs} мс`;
  el.testResultRouteText.textContent = res.route;
}

/**
 * Load existing sites and proxies from extension storage
 */
async function loadExtensionState() {
  try {
    const res = await sendMessage({ action: 'GET_STATE', includeExceptions: true });
    if (res && res.success && res.data) {
      const mods = res.data.pacMods || {};
      currentCustomProxiesString = mods.customProxyStringRaw || '';

      // If user has exceptions, offer to pre-populate or load
      const exc = mods.exceptions || {};
      const includedDomains = Object.keys(exc).filter((k) => exc[k] === true);

      // If textarea is currently empty, load presets or included domains
      if (!el.domainsTextarea.value.trim()) {
        if (includedDomains.length > 0) {
          el.domainsTextarea.value = includedDomains.join('\n');
        } else {
          // Preload default popular presets
          const defaultList = [...POPULAR_PRESETS.social.domains, ...POPULAR_PRESETS.media_ai.domains, ...POPULAR_PRESETS.trackers.domains];
          el.domainsTextarea.value = Array.from(new Set(defaultList)).join('\n');
        }
        updateGeneratedPac();
      }
    }
  } catch (err) {
    console.warn('Failed to load extension state:', err);
  }
}

/**
 * Add domains to the textarea
 */
function appendDomains(newDomains = []) {
  const current = parseDomainsInput(el.domainsTextarea.value);
  const combined = new Set([...current, ...newDomains]);
  el.domainsTextarea.value = Array.from(combined).sort().join('\n');
  updateGeneratedPac();
}

/**
 * Download generated PAC as a .pac file
 */
function downloadPacFile() {
  if (!generatedPacCode) return;
  const blob = new Blob([generatedPacCode], { type: 'application/x-ns-proxy-autoconfig' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `proxy-${Date.now()}.pac`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast('💾 PAC-скрипт успешно сохранен в файл');
}

/**
 * Copy PAC code to clipboard
 */
async function copyPacCode() {
  if (!generatedPacCode) return;
  try {
    await navigator.clipboard.writeText(generatedPacCode);
    showToast('📋 Код PAC-скрипта скопирован в буфер обмена');
  } catch {
    const ta = document.createElement('textarea');
    ta.value = generatedPacCode;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    showToast('📋 Код скопирован');
  }
}

/**
 * Copy Data URI for PAC
 */
async function copyDataUri() {
  if (!generatedPacCode) return;
  const dataUri = 'data:application/x-ns-proxy-autoconfig,' + encodeURIComponent(generatedPacCode);
  try {
    await navigator.clipboard.writeText(dataUri);
    showToast('🔗 Data URI скопирован в буфер обмена');
  } catch {
    showToast('❌ Ошибка копирования Data URI');
  }
}

/**
 * Apply generated PAC directly to extension's active proxy settings
 */
async function applyToExtension() {
  if (!generatedPacCode) return;
  el.applyToExtensionBtn.disabled = true;
  el.applyToExtensionBtn.textContent = '⏳ Применение...';

  try {
    const res = await sendMessage({
      action: 'SET_RAW_PAC',
      pacData: generatedPacCode,
    });

    if (res && res.success) {
      showToast('🚀 PAC-скрипт успешно активирован в расширении!', 3500);
    } else {
      showToast(`❌ Ошибка применения: ${res.error || 'Неизвестная ошибка'}`, 4000);
    }
  } catch (err) {
    showToast(`❌ Ошибка: ${err.message}`, 4000);
  } finally {
    el.applyToExtensionBtn.disabled = false;
    el.applyToExtensionBtn.innerHTML = '<span>🚀 Применить в расширении</span>';
  }
}

/**
 * Bind UI event listeners
 */
function initEvents() {
  // Input changes triggers re-generation
  el.domainsTextarea.addEventListener('input', updateGeneratedPac);
  el.proxyStringInput.addEventListener('input', updateGeneratedPac);
  el.optBypassLocal.addEventListener('change', updateGeneratedPac);
  el.optProxyOrDie.addEventListener('change', updateGeneratedPac);
  el.optHttpsOnly.addEventListener('change', updateGeneratedPac);
  el.optProhibitDns.addEventListener('change', updateGeneratedPac);

  // Sandbox testing
  el.runTestBtn.addEventListener('click', runSandboxTest);
  el.testUrlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runSandboxTest();
  });

  // Action buttons
  el.downloadPacBtn.addEventListener('click', downloadPacFile);
  el.copyPacBtn.addEventListener('click', copyPacCode);
  el.copyCodeFooterBtn.addEventListener('click', copyPacCode);
  el.copyDataUriBtn.addEventListener('click', copyDataUri);
  el.applyToExtensionBtn.addEventListener('click', applyToExtension);

  // Clear domains
  el.clearDomainsBtn.addEventListener('click', () => {
    if (confirm('Очистить весь список доменов?')) {
      el.domainsTextarea.value = '';
      updateGeneratedPac();
    }
  });

  // Domain Presets
  document.querySelectorAll('[data-preset]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const presetKey = btn.dataset.preset;
      const preset = POPULAR_PRESETS[presetKey];
      if (preset && preset.domains) {
        appendDomains(preset.domains);
        showToast(`Добавлены домены: ${preset.title}`);
      }
    });
  });

  // Proxy Presets
  document.querySelectorAll('[data-proxy-preset]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const type = btn.dataset.proxyPreset;
      if (type === 'antizapret') {
        el.proxyStringInput.value = 'HTTPS proxy.antizapret.prostovpn.org:8443; PROXY proxy.antizapret.prostovpn.org:8443; DIRECT';
      } else if (type === 'tor') {
        el.proxyStringInput.value = 'SOCKS5 127.0.0.1:9150; SOCKS5 127.0.0.1:9050; DIRECT';
      } else if (type === 'warp') {
        el.proxyStringInput.value = 'SOCKS5 127.0.0.1:40000; HTTPS 127.0.0.1:40000; DIRECT';
      } else if (type === 'custom_from_ext') {
        if (currentCustomProxiesString) {
          el.proxyStringInput.value = currentCustomProxiesString + '; DIRECT';
        } else {
          showToast('⚠️ В расширении нет настроенных своих прокси');
          return;
        }
      }
      updateGeneratedPac();
      showToast('Маршрут прокси обновлен');
    });
  });

  // Import from Extension
  el.importFromExtensionBtn.addEventListener('click', async () => {
    const res = await sendMessage({ action: 'GET_FULL_EXCEPTIONS' });
    if (res && res.success && res.data) {
      const exc = res.data.exceptions || {};
      const domains = Object.keys(exc).filter((d) => exc[d] === true);
      if (domains.length > 0) {
        appendDomains(domains);
        showToast(`Импортировано ${domains.length} доменов из расширения`);
      } else {
        showToast('В расширении нет добавленных сайтов');
      }
    }
  });

  // File Upload
  el.uploadFileChipBtn.addEventListener('click', () => {
    el.filePickerInput.click();
  });

  el.filePickerInput.addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const content = event.target.result;
      const parsed = parseDomainsInput(content);
      if (parsed.length > 0) {
        appendDomains(parsed);
        showToast(`Импортировано ${parsed.length} доменов из файла`);
      } else {
        showToast('В файле не найдено корректных доменов');
      }
      el.filePickerInput.value = '';
    };
    reader.readAsText(file);
  });
}

// Initialization
document.addEventListener('DOMContentLoaded', () => {
  initEvents();
  loadExtensionState();
  updateGeneratedPac();
});
