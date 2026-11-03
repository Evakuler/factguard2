// FactGuard — логіка віконця розширення (popup)
'use strict';

const UI = window.FactGuardUI;
const Lists = window.FactGuardLists;
const CONTENT_FILES = ['src/analyzer.js', 'src/news-analyzer.js', 'src/ui.js', 'content.js'];

const LEVEL_TEXT = { safe: 'Низький ризик', warning: 'Середній ризик', danger: 'Високий ризик', unknown: 'Не перевірено' };

let activeTab = null;
let scanning = false;

// Стилі для результату перевірки новини беремо зі спільного src/ui.js
const style = document.createElement('style');
style.textContent = UI.CSS;
document.head.appendChild(style);

function sendMessage(message) {
  return chrome.runtime.sendMessage(message).catch(() => null);
}

/** Повідомлення у вкладку; якщо там ще немає content script — ін'єктуємо його (як у background.js). */
async function sendToTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (firstError) {
    await chrome.scripting.executeScript({ target: { tabId }, files: CONTENT_FILES });
    return await chrome.tabs.sendMessage(tabId, message);
  }
}

// ---------- ВКЛАДКА «НОВИНА» ----------

const newsResult = document.getElementById('newsResult');

// Поки йде перевірка, сторінка надсилає проміжні результати (джерело → пошук → ШІ)
chrome.runtime.onMessage.addListener((message, sender) => {
  if (!scanning || !message || message.type !== 'FG_PROGRESS') return;
  if (!activeTab || !sender.tab || sender.tab.id !== activeTab.id) return;
  newsResult.replaceChildren(UI.renderResult(message.data));
});

document.getElementById('scanBtn').addEventListener('click', async () => {
  const btn = document.getElementById('scanBtn');
  if (!activeTab) return;
  btn.disabled = true;
  scanning = true;
  newsResult.replaceChildren(UI.renderLoading('Перевіряємо джерело, подачу та шукаємо новину на інших сайтах…'));
  try {
    const result = await sendToTab(activeTab.id, { type: 'FG_SCAN_PAGE' });
    if (!result || !result.ok) throw new Error((result && result.error) || 'немає відповіді');
    const { article, local, source, response, ai, aiError } = result;
    newsResult.replaceChildren(UI.renderResult({
      title: article.title,
      local,
      source,
      server: response.ok ? response.data : null,
      error: response.ok ? null : response.error,
      ai,
      aiError,
    }));
  } catch (e) {
    newsResult.replaceChildren(UI.renderResult({
      error: 'Не вдалося перевірити цю сторінку. Службові сторінки браузера (chrome://, магазин розширень) перевіряти не можна. ' +
             'Якщо це звичайний сайт — оновіть сторінку (F5) і спробуйте ще раз.',
    }));
  } finally {
    scanning = false;
    btn.disabled = false;
  }
});

// Перемикач «ШІ-аналіз» (зберігається в налаштуваннях Chrome)
const aiToggle = document.getElementById('aiToggle');
chrome.storage.sync.get({ aiEnabled: true }).then(({ aiEnabled }) => { aiToggle.checked = aiEnabled; });
aiToggle.addEventListener('change', () => chrome.storage.sync.set({ aiEnabled: aiToggle.checked }));

// ---------- ВКЛАДКА «САЙТ» (перевірка на фішинг) ----------

function renderReasons(reasons) {
  return UI.h('ul', { class: 'reasons' }, (reasons || []).map(r =>
    UI.h('li', {},
      UI.h('span', { class: 'points' + (r.points > 0 ? ' hit' : ''), text: r.points > 0 ? '+' + r.points : '—' }),
      UI.h('span', { text: r.text }))));
}

/** Кнопки «до білого / чорного списку» для перевіреного сайту. */
function siteListButtons(result, onChanged) {
  if (!result.domain || result.score === null || result.score === undefined) return null;
  const host = (result.hostname || result.domain).replace(/^www\./, '');
  const button = (text, cls, list, add, entry) => {
    const btn = UI.h('button', { class: 'btn small ' + cls, text });
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      await changeList(list, entry, add, !add);
      onChanged && onChanged();
    });
    return btn;
  };
  const buttons = [];
  if (result.trusted) {
    buttons.push(button('Прибрати з білого списку', '', 'trusted', false, host));
  } else if (result.userBlocked) {
    buttons.push(button('Прибрати з чорного списку', '', 'blocked', false, host));
  } else {
    if (!result.blocked) buttons.push(button(`✅ Довіряю ${result.domain}`, '', 'trusted', true, result.domain));
    buttons.push(button(`⛔ До чорного списку`, 'danger-outline', 'blocked', true, result.domain));
  }
  return UI.h('div', { class: 'site-actions' }, buttons);
}

function renderSiteResult(container, url, result, { showListButtons, onListChanged } = {}) {
  const level = result.level || PhishAnalyzer.levelFromScore(result.score);
  const badgeText = result.score === null || result.score === undefined
    ? LEVEL_TEXT.unknown : `${LEVEL_TEXT[level]} (${result.score}/100)`;
  const nodes = [
    UI.h('div', { class: 'badge ' + level, text: badgeText }),
    UI.h('div', { class: 'host', text: result.hostname || url }),
    result.hostname ? UI.h('div', { class: 'url', text: url }) : null,
    typeof result.domainAgeDays === 'number' ? UI.h('div', { class: 'meta', text: `Вік домену ${result.domain}: ${result.domainAgeDays} дн.` }) : null,
    renderReasons(result.reasons),
    showListButtons ? siteListButtons(result, onListChanged) : null,
  ];
  container.replaceChildren(...nodes.filter(Boolean));
}

async function checkCurrentTab(refresh) {
  const container = document.getElementById('currentResult');
  const result = await sendMessage({ type: 'FG_TAB_RESULT', tabId: activeTab.id, url: activeTab.url, refresh });
  if (!result || !result.reasons) {
    container.replaceChildren(UI.h('div', { class: 'badge unknown', text: 'Помилка' }),
      UI.h('div', { class: 'meta', text: 'Фоновий скрипт не відповів. Спробуйте перезавантажити розширення.' }));
    return;
  }
  renderSiteResult(container, result.url || activeTab.url || '', result, {
    showListButtons: true,
    onListChanged: () => checkCurrentTab(true),
  });
}

document.getElementById('checkForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const raw = document.getElementById('customUrlInput').value.trim();
  if (!raw) return;
  const url = PhishAnalyzer.normalizeInputUrl(raw);
  const container = UI.h('div', {}, UI.h('div', { class: 'badge unknown', text: 'Перевірка…' }));
  document.getElementById('customResult').replaceChildren(container);
  const result = await sendMessage({ type: 'FG_ANALYZE_URL', url });
  if (result && result.reasons) {
    const rerender = async () => {
      const again = await sendMessage({ type: 'FG_ANALYZE_URL', url });
      if (again && again.reasons) renderSiteResult(container, url, again, { showListButtons: true, onListChanged: rerender });
    };
    renderSiteResult(container, url, result, { showListButtons: true, onListChanged: rerender });
  }
});

// ---------- БІЛИЙ І ЧОРНИЙ СПИСКИ ----------

const LIST_HINTS = {
  trusted: 'Сайти, яким ви довіряєте: попередження про фішинг на них не показуються. Запис діє і на піддомени.',
  blocked: 'Сайти, які ви вважаєте небезпечними: на них завжди з\'являється червоне попередження. Запис діє і на піддомени.',
};
let currentList = 'trusted';

async function changeList(list, domain, add, matching = false) {
  const result = await sendMessage({ type: 'FG_LIST_CHANGE', list, domain, add, matching });
  await renderLists();
  // Оновлюємо банер на відкритій сторінці (з'явиться або зникне)
  if (activeTab) chrome.tabs.sendMessage(activeTab.id, { type: 'FG_RECHECK_SITE' }).catch(() => {});
  return result;
}

async function renderLists() {
  const lists = (await sendMessage({ type: 'FG_LISTS' })) || { trusted: [], blocked: [] };
  document.getElementById('trustedCount').textContent = lists.trusted.length;
  document.getElementById('blockedCount').textContent = lists.blocked.length;
  document.getElementById('listHint').textContent = LIST_HINTS[currentList];
  const items = lists[currentList] || [];
  const ul = document.getElementById('listItems');
  if (!items.length) {
    ul.replaceChildren(UI.h('li', { class: 'empty', text: 'Список порожній' }));
    return;
  }
  ul.replaceChildren(...items.map(entry => {
    const remove = UI.h('button', { class: 'remove', title: 'Прибрати зі списку', 'aria-label': 'Прибрати ' + entry, text: '×' });
    remove.addEventListener('click', async () => {
      remove.disabled = true;
      await changeList(currentList, entry, false);
      if (activeTab) checkCurrentTab(true);
    });
    return UI.h('li', {}, UI.h('span', { text: entry }), remove);
  }));
}

document.querySelectorAll('.seg').forEach(seg => {
  seg.addEventListener('click', () => {
    currentList = seg.dataset.list;
    document.querySelectorAll('.seg').forEach(s => s.classList.toggle('active', s === seg));
    document.getElementById('listError').hidden = true;
    renderLists();
  });
});

document.getElementById('listForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = document.getElementById('listInput');
  const errorBox = document.getElementById('listError');
  const entry = Lists.normalizeEntry(input.value);
  if (!entry) {
    errorBox.textContent = 'Це не схоже на адресу сайту. Приклад: example.com або https://example.com/page';
    errorBox.hidden = false;
    return;
  }
  errorBox.hidden = true;
  await changeList(currentList, entry, true);
  input.value = '';
  if (activeTab) checkCurrentTab(true);
});

// ---------- ВКЛАДКИ, СТАТУС, СТАРТ ----------

document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => {
      t.classList.toggle('active', t === tab);
      t.setAttribute('aria-selected', t === tab);
    });
    document.querySelectorAll('.panel').forEach(p => { p.hidden = p.id !== tab.dataset.panel; });
  });
});

document.getElementById('testsLink').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL('tests/tests.html') });
});

async function showStatus() {
  const status = await sendMessage({ type: 'FG_STATUS' });
  if (!status) return;
  const server = document.getElementById('serverStatus');
  const aiStatus = document.getElementById('aiStatus');
  const aiState = document.getElementById('aiState');
  if (status.server && status.server.ok) {
    server.textContent = '● Сервер працює';
    server.className = 'server ok';
    server.title = 'Перевірка на інших сайтах доступна';
    const ai = (status.server.data && status.server.data.ai) || { enabled: false, reason: 'Оновіть server/main.py до версії 2.1.' };
    if (ai.enabled) {
      aiStatus.textContent = '● ШІ: ' + ai.name;
      aiStatus.className = 'server ok';
      aiStatus.title = 'Модель: ' + ai.model;
      aiState.textContent = ai.name;
    } else {
      aiStatus.textContent = '● ШІ не підключено';
      aiStatus.className = 'server down';
      aiStatus.title = ai.reason;
      aiState.textContent = 'не підключено';
      aiState.title = ai.reason;
    }
  } else {
    server.textContent = '● Сервер не запущено';
    server.className = 'server down';
    server.title = 'Запустіть server/start-server, щоб працювали перевірка на інших сайтах та ШІ';
    aiStatus.textContent = '';
    aiState.textContent = 'потрібен сервер';
  }
  document.getElementById('status').textContent = status.blocklistSize
    ? `База фішингу PhishDestroy: ${status.blocklistSize.toLocaleString('uk-UA')} сайтів`
    : 'База фішингу недоступна (немає інтернету?)';
}

chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  activeTab = tabs && tabs[0];
  if (activeTab) checkCurrentTab(false);
  showStatus();
  renderLists();
});
