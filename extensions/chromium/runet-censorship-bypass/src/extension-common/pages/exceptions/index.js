'use strict';

import { normalizeDomainRule, parseDomainRuleLines } from '../../core/domain-rules.js';

/**
 * Standalone Full-Page Exceptions & Sites Manager
 */

let state = {
  exceptions: {},
  whitelist: [],
  activeSubTab: 'included', // 'included' | 'excluded' | 'whitelist'
  rawMode: false,
};
let saveQueue = Promise.resolve();

const el = {
  listViewSection: document.getElementById('listViewSection'),
  editorViewSection: document.getElementById('editorViewSection'),
  importFileBtn: document.getElementById('importFileBtn'),
  exportFileBtn: document.getElementById('exportFileBtn'),
  fileImportInput: document.getElementById('fileImportInput'),
  modeToggleBtn: document.getElementById('modeToggleBtn'),
  saveAllBtn: document.getElementById('saveAllBtn'),
  tabBtns: document.querySelectorAll('.tab-btn'),
  includedCount: document.getElementById('includedCount'),
  excludedCount: document.getElementById('excludedCount'),
  whitelistCount: document.getElementById('whitelistCount'),
  newDomainInput: document.getElementById('newDomainInput'),
  addDomainBtn: document.getElementById('addDomainBtn'),
  searchDomainInput: document.getElementById('searchDomainInput'),
  clearListBtn: document.getElementById('clearListBtn'),
  domainListContainer: document.getElementById('domainListContainer'),
  rawTextEditor: document.getElementById('rawTextEditor'),
  saveRawBtn: document.getElementById('saveRawBtn'),
  editorStatusText: document.getElementById('editorStatusText'),
  toast: document.getElementById('toast'),
};

function showToast(text, duration = 3000) {
  if (!el.toast) return;
  el.toast.textContent = text;
  el.toast.classList.add('show');
  setTimeout(() => {
    el.toast.classList.remove('show');
  }, duration);
}

function sendMessage(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (res) => {
      if (chrome.runtime.lastError) {
        resolve({ success: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(res || { success: false, error: 'Фоновый процесс не ответил' });
    });
  });
}

async function loadData() {
  const res = await sendMessage({ action: 'GET_STATE', includeExceptions: true });
  if (res && res.success && res.data) {
    const mods = res.data.pacMods || {};
    state.exceptions = Object.assign({}, mods.exceptions || {});
    state.whitelist = [...(mods.whitelist || [])];
    render();
  } else {
    showToast('Ошибка загрузки данных');
  }
}

function saveAllData() {
  // Capture a snapshot now and serialize writes so rapid clicks cannot let an
  // older full-state SAVE_MODS response overwrite a newer one.
  const mods = {
    exceptions: Object.assign({}, state.exceptions),
    whitelist: [...state.whitelist],
  };

  const save = async () => {
    const res = await sendMessage({ action: 'SAVE_MODS', mods });
    if (res && res.success) {
      showToast('✓ Все изменения успешно сохранены!');
      render();
      return true;
    }
    showToast(`Ошибка сохранения: ${(res && res.error) || 'Сбой'}`);
    return false;
  };

  const result = saveQueue.then(save, save);
  saveQueue = result.then(() => undefined, () => undefined);
  return result;
}

let renderedCount = 0;
let currentFilteredItems = [];
const CHUNK_SIZE = 100;

function render() {
  let incCount = 0;
  let excCount = 0;
  for (const k in state.exceptions) {
    if (Object.prototype.hasOwnProperty.call(state.exceptions, k)) {
      if (state.exceptions[k] === true) incCount++;
      else if (state.exceptions[k] === false) excCount++;
    }
  }
  const whiteCount = (state.whitelist && state.whitelist.length) || 0;

  if (el.includedCount) el.includedCount.textContent = incCount;
  if (el.excludedCount) el.excludedCount.textContent = excCount;
  if (el.whitelistCount) el.whitelistCount.textContent = whiteCount;

  el.tabBtns.forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.subtab === state.activeSubTab);
  });

  renderDomainCards();
}

function renderDomainCards() {
  if (!el.domainListContainer) return;
  const filter = (el.searchDomainInput?.value || '').toLowerCase().trim();

  let items = [];
  if (state.activeSubTab === 'included') {
    for (const k in state.exceptions) {
      if (state.exceptions[k] === true) items.push(k);
    }
  } else if (state.activeSubTab === 'excluded') {
    for (const k in state.exceptions) {
      if (state.exceptions[k] === false) items.push(k);
    }
  } else if (state.activeSubTab === 'whitelist') {
    items = [...state.whitelist];
  }

  if (filter) {
    items = items.filter((d) => d.toLowerCase().includes(filter));
  }

  items.sort();
  currentFilteredItems = items;
  renderedCount = 0;
  el.domainListContainer.innerHTML = '';

  if (items.length === 0) {
    el.domainListContainer.innerHTML = `
      <div class="empty-state">
        <p style="font-size: 16px; margin-bottom: 6px;">Список пуст</p>
        <p style="font-size: 13px;">Введите домен выше или загрузите файл (.txt)</p>
      </div>
    `;
    return;
  }

  appendNextDomainChunk();
}

function appendNextDomainChunk() {
  if (!el.domainListContainer || renderedCount >= currentFilteredItems.length) return;

  const nextBatch = currentFilteredItems.slice(renderedCount, renderedCount + CHUNK_SIZE);
  const fragment = document.createDocumentFragment();

  nextBatch.forEach((domain) => {
    const card = document.createElement('div');
    card.className = 'domain-card';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'domain-name';
    nameSpan.title = domain;
    nameSpan.textContent = domain;

    const delBtn = document.createElement('button');
    delBtn.className = 'delete-domain-btn';
    delBtn.title = 'Удалить';
    delBtn.dataset.domain = domain;
    delBtn.textContent = '✕';

    card.appendChild(nameSpan);
    card.appendChild(delBtn);
    fragment.appendChild(card);
  });

  el.domainListContainer.appendChild(fragment);
  renderedCount += nextBatch.length;
}

function addDomain(rawDomain) {
  const normalized = normalizeDomainRule(rawDomain);
  if (!normalized.valid) {
    showToast(normalized.error);
    return;
  }
  const domain = normalized.domain;

  if (state.activeSubTab === 'included') {
    state.exceptions[domain] = true;
  } else if (state.activeSubTab === 'excluded') {
    state.exceptions[domain] = false;
  } else if (state.activeSubTab === 'whitelist') {
    if (!state.whitelist.includes(domain)) {
      state.whitelist.push(domain);
    }
  }

  if (el.newDomainInput) el.newDomainInput.value = '';
  saveAllData();
}

function removeDomain(domain) {
  if (state.activeSubTab === 'included' || state.activeSubTab === 'excluded') {
    delete state.exceptions[domain];
  } else if (state.activeSubTab === 'whitelist') {
    state.whitelist = state.whitelist.filter((d) => d !== domain);
  }
  saveAllData();
}

async function handleClearList() {
  if (state.activeSubTab === 'included') {
    let count = 0;
    for (const k in state.exceptions) {
      if (state.exceptions[k] === true) count++;
    }
    if (count === 0) {
      showToast('Список проксируемых доменов пуст');
      return;
    }
    if (!confirm(`Удалить все проксируемые домены (${count} шт.)?`)) {
      return;
    }
    for (const k in state.exceptions) {
      if (state.exceptions[k] === true) {
        delete state.exceptions[k];
      }
    }
    await saveAllData();
    showToast('✓ Список проксируемых доменов очищен');
  } else if (state.activeSubTab === 'excluded') {
    let count = 0;
    for (const k in state.exceptions) {
      if (state.exceptions[k] === false) count++;
    }
    if (count === 0) {
      showToast('Список исключений пуст');
      return;
    }
    if (!confirm(`Удалить все исключения (${count} шт.)?`)) {
      return;
    }
    for (const k in state.exceptions) {
      if (state.exceptions[k] === false) {
        delete state.exceptions[k];
      }
    }
    await saveAllData();
    showToast('✓ Список исключений очищен');
  } else if (state.activeSubTab === 'whitelist') {
    if (!state.whitelist || state.whitelist.length === 0) {
      showToast('Белый список пуст');
      return;
    }
    if (!confirm(`Очистить весь белый список (${state.whitelist.length} шт.)?`)) {
      return;
    }
    state.whitelist = [];
    await saveAllData();
    showToast('✓ Белый список очищен');
  }
}

function parseAndValidateDomainLines(lines) {
  return parseDomainRuleLines(lines);
}

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

  // 6. Tokenize line by line (support CRLF, LF, CR) and validate
  const allLines = rawText.split(/\r?\n|\r/);
  const lines = allLines.slice(0, 100000);
  const { validDomains, skippedCount } = parseAndValidateDomainLines(lines);

  if (validDomains.length === 0) {
    throw new Error(`В файле не найдено ни одного корректного доменного имени (пропущено некорректных строк: ${skippedCount}).`);
  }

  return { validDomains, skippedCount };
}

// Handle File Import
async function handleFileImport(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;

  try {
    const { validDomains, skippedCount } = await parseAndValidateDomainFile(file);

    if (state.activeSubTab === 'included') {
      validDomains.forEach((d) => (state.exceptions[d] = true));
    } else if (state.activeSubTab === 'excluded') {
      validDomains.forEach((d) => (state.exceptions[d] = false));
    } else if (state.activeSubTab === 'whitelist') {
      validDomains.forEach((d) => {
        if (!state.whitelist.includes(d)) state.whitelist.push(d);
      });
    }

    await saveAllData();
    const skipMsg = skippedCount > 0 ? ` (пропущено некорректных строк: ${skippedCount})` : '';
    showToast(`✓ Успешно загружено ${validDomains.length} доменов из файла!${skipMsg}`, 4500);
  } catch (err) {
    showToast(`❌ Ошибка загрузки: ${err.message}`, 5500);
  } finally {
    // Reset file input so user can re-upload the same file if needed
    if (el.fileImportInput) el.fileImportInput.value = '';
  }
}

// Handle File Export
function handleFileExport() {
  let domains = [];
  let fileName = 'domains.txt';

  if (state.activeSubTab === 'included') {
    domains = Object.keys(state.exceptions).filter((k) => state.exceptions[k] === true).sort();
    fileName = 'proxied-domains.txt';
  } else if (state.activeSubTab === 'excluded') {
    domains = Object.keys(state.exceptions).filter((k) => state.exceptions[k] === false).sort();
    fileName = 'direct-exceptions.txt';
  } else if (state.activeSubTab === 'whitelist') {
    domains = [...state.whitelist].sort();
    fileName = 'whitelist-domains.txt';
  }

  if (domains.length === 0) {
    showToast('Текущий список пуст — нечего экспортировать');
    return;
  }

  const header = `# Список доменов (${state.activeSubTab})\n# Экспортировано: ${new Date().toLocaleString('ru-RU')}\n# Количество: ${domains.length}\n\n`;
  const blob = new Blob([header + domains.join('\n') + '\n'], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast(`✓ Экспортировано ${domains.length} доменов в файл ${fileName}!`);
}

function toggleMode() {
  state.rawMode = !state.rawMode;
  if (state.rawMode) {
    // Fill text editor
    const incList = Object.keys(state.exceptions).filter((k) => state.exceptions[k] === true);
    const excList = Object.keys(state.exceptions).filter((k) => state.exceptions[k] === false);
    const whiteList = state.whitelist;

    el.rawTextEditor.value = `# ПРОКСИРОВАТЬ:\n${incList.join('\n')}\n\n===============================\n# НЕ ПРОКСИРОВАТЬ:\n${excList.join('\n')}\n\n===============================\n# БЕЛЫЙ СПИСОК:\n${whiteList.join('\n')}\n`;
    el.listViewSection.style.display = 'none';
    el.editorViewSection.style.display = 'block';
    el.modeToggleBtn.textContent = '📋 Список';
  } else {
    el.editorViewSection.style.display = 'none';
    el.listViewSection.style.display = 'block';
    el.modeToggleBtn.textContent = '📝 Текстовый режим';
    render();
  }
}

async function saveRawText() {
  const text = el.rawTextEditor.value;
  const sections = text
    .trim()
    .split(/=+/g)
    .map((s) => s.trim().split(/(?:\s*\r?\n\s*)+/g).filter(Boolean));

  const [incRaw = [], excRaw = [], whiteRaw = []] = sections;
  const incRes = parseAndValidateDomainLines(incRaw);
  const excRes = parseAndValidateDomainLines(excRaw);
  const whiteRes = parseAndValidateDomainLines(whiteRaw);

  const totalSkipped = incRes.skippedCount + excRes.skippedCount + whiteRes.skippedCount;

  const newExceptions = {};
  incRes.validDomains.forEach((host) => (newExceptions[host] = true));
  excRes.validDomains.forEach((host) => (newExceptions[host] = false));

  state.exceptions = newExceptions;
  state.whitelist = whiteRes.validDomains;

  const wasSaved = await saveAllData();
  if (!wasSaved) return;
  toggleMode();

  const skipMsg = totalSkipped > 0 ? ` (пропущено некорректных строк: ${totalSkipped})` : '';
  showToast(`✓ Настройки сохранены!${skipMsg}`, 3500);
}

function setupEvents() {
  el.tabBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      state.activeSubTab = btn.dataset.subtab;
      render();
    });
  });

  if (el.addDomainBtn && el.newDomainInput) {
    el.addDomainBtn.addEventListener('click', () => addDomain(el.newDomainInput.value));
    el.newDomainInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') addDomain(el.newDomainInput.value);
    });
  }

  if (el.searchDomainInput) {
    el.searchDomainInput.addEventListener('input', renderDomainCards);
  }

  if (el.clearListBtn) {
    el.clearListBtn.addEventListener('click', handleClearList);
  }

  // Scroll listener for virtual / infinite chunk loading
  if (el.domainListContainer) {
    el.domainListContainer.addEventListener('scroll', () => {
      const { scrollTop, scrollHeight, clientHeight } = el.domainListContainer;
      if (scrollTop + clientHeight >= scrollHeight - 120) {
        appendNextDomainChunk();
      }
    });

    // Event delegation for domain card deletion (O(1) listener for 30k+ domains)
    el.domainListContainer.addEventListener('click', (e) => {
      const btn = e.target.closest('.delete-domain-btn');
      if (btn && btn.dataset.domain) {
        removeDomain(btn.dataset.domain);
      }
    });
  }

  if (el.importFileBtn && el.fileImportInput) {
    el.importFileBtn.addEventListener('click', () => el.fileImportInput.click());
    el.fileImportInput.addEventListener('change', handleFileImport);
  }

  if (el.exportFileBtn) {
    el.exportFileBtn.addEventListener('click', handleFileExport);
  }

  if (el.modeToggleBtn) {
    el.modeToggleBtn.addEventListener('click', toggleMode);
  }

  if (el.saveAllBtn) {
    el.saveAllBtn.addEventListener('click', saveAllData);
  }

  if (el.saveRawBtn) {
    el.saveRawBtn.addEventListener('click', saveRawText);
  }
}

function initApp() {
  setupEvents();
  loadData();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}
