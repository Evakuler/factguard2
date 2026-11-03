/**
 * FactGuard — фоновий service worker (Manifest V3).
 *
 * Це "диспетчер" розширення:
 *   • створює пункт контекстного меню "Перевірити новину на фактчекінг";
 *   • приймає від content.js / popup.js повідомлення і робить запити до Python API
 *     (fetch до localhost дозволений саме тут завдяки host_permissions у manifest.json);
 *   • перевіряє кожен сайт на фішинг (база PhishDestroy + евристика з PhishGuard
 *     + білий і чорний списки користувача);
 *   • просить сервер про ШІ-аналіз новини (FG_AI);
 *   • перевіряє джерело новини (білий список ІМІ, підробки під ЗМІ, вік домену);
 *   • ставить значок-індикатор (✓ / ? / !) на іконку розширення.
 *
 * Service worker у MV3 "засинає" після бездіяльності, тому все, що треба пам'ятати,
 * зберігаємо в chrome.storage, а не у змінних.
 */
'use strict';

importScripts('src/analyzer.js', 'src/source-check.js', 'src/lists.js');

const API_BASE = 'http://127.0.0.1:8000';
const VERIFY_ENDPOINT = API_BASE + '/api/verify-news';
const HEALTH_ENDPOINT = API_BASE + '/api/health';
const AI_ENDPOINT = API_BASE + '/api/ai-check';
const REQUEST_TIMEOUT_MS = 45000;    // пошук на інших сайтах може тривати кілька секунд
const AI_TIMEOUT_MS = 300000;        // ШІ читає статті інших сайтів і «думає»; сервер сам обмежує час і повторює запит
const MENU_ID = 'factguard-check-selection';
// Файли, які треба ін'єктувати, якщо вкладка відкрита ДО встановлення розширення.
const CONTENT_FILES = ['src/analyzer.js', 'src/news-analyzer.js', 'src/ui.js', 'content.js'];
const Lists = self.FactGuardLists;

const PHISHDESTROY_LIST_URL = 'https://cdn.jsdelivr.net/gh/phishdestroy/destroylist@main/rootlist/formats/primary_active/hosts.txt';
const LIST_TTL = 60 * 60 * 1000;            // чорний список оновлюємо раз на годину
const AGE_TTL = 7 * 24 * 60 * 60 * 1000;    // вік домену кешуємо на тиждень
const AGE_FAIL_TTL = 24 * 60 * 60 * 1000;   // невдалий запит повторюємо не частіше ніж раз на добу

// ---------- КОНТЕКСТНЕ МЕНЮ ----------

// Меню створюємо при встановленні/оновленні. removeAll — щоб не було дублів і помилки "duplicate id".
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: 'Перевірити новину на фактчекінг',
      contexts: ['selection'] // пункт з'являється лише коли виділено текст
    });
  });
  ensureBlocklist();
});

/**
 * Надсилає повідомлення у вкладку. Якщо там ще немає content script
 * (вкладка відкрита до встановлення), програмно ін'єктуємо його і пробуємо ще раз.
 * Для executeScript достатньо дозволу activeTab, який дає клік по меню/іконці.
 */
async function sendToTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (firstError) {
    await chrome.scripting.executeScript({ target: { tabId }, files: CONTENT_FILES });
    return await chrome.tabs.sendMessage(tabId, message);
  }
}

// Клік по пункту меню -> просимо content.js перевірити виділений текст.
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab || tab.id == null) return;
  try {
    await sendToTab(tab.id, { type: 'FG_CHECK_SELECTION', selection: info.selectionText || '' });
  } catch (err) {
    // Наприклад, службові сторінки chrome:// — туди ін'єкція заборонена.
    console.warn('FactGuard: не вдалося запустити перевірку на цій сторінці', err);
    setBadge(tab.id, '×', '#6b7280');
  }
});

/** Малює маленький бейдж на іконці розширення для конкретної вкладки. */
function setBadge(tabId, text, color) {
  if (tabId == null) return;
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  if (color) chrome.action.setBadgeBackgroundColor({ tabId, color }).catch(() => {});
}

// ---------- ЗАПИТ ДО PYTHON-СЕРВЕРА ----------

/** Робить із відповіді FastAPI (наприклад, {"detail": "..."}) зрозумілий текст помилки. */
function describeServerError(body, status) {
  let detail = '';
  if (body && body.detail) {
    // При помилці валідації (422) detail — це масив об'єктів, тому серіалізуємо.
    detail = typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail);
  }
  // 503 — тимчасова перевантаженість (ШІ чи пошуку): сервер уже пояснив, що робити, — показуємо без «сирого» коду
  if (status === 503 && detail) return '⏳ ' + detail;
  return 'Сервер FactGuard повернув помилку ' + status + (detail ? ': ' + detail : '.');
}

/**
 * Service worker у MV3 Chrome «присипляє» через ~30 с без подій, навіть якщо fetch ще чекає відповіді.
 * Поки йде довгий запит (ШІ може думати хвилину), раз на 20 с викликаємо будь-який chrome.* API —
 * це скидає таймер сну.
 */
async function withKeepAlive(promise) {
  const timer = setInterval(() => chrome.runtime.getPlatformInfo().catch(() => {}), 20000);
  try {
    return await promise;
  } finally {
    clearInterval(timer);
  }
}

/**
 * POST-запит до Python-сервера.
 * Завжди повертає об'єкт {ok:true,data} або {ok:false,error} — ніколи не кидає виняток,
 * тому викликачам (content/popup) не потрібен власний try/catch для мережі.
 */
function postToServer(endpoint, payload, timeoutMs) {
  return withKeepAlive(postToServerRaw(endpoint, payload, timeoutMs));
}

async function postToServerRaw(endpoint, payload, timeoutMs) {
  // AbortController дозволяє перервати запит за таймаутом.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    if (!response.ok) {
      let body = null;
      try {
        body = await response.json();
      } catch (e) {
        /* тіло відповіді не JSON — не страшно */
      }
      return { ok: false, error: describeServerError(body, response.status) };
    }
    return { ok: true, data: await response.json() };
  } catch (err) {
    if (err && err.name === 'AbortError') {
      return { ok: false, error: 'Сервер не відповів вчасно. Спробуйте ще раз або перевірте, чи працює Python-сервер (вікно start-server).' };
    }
    // Найчастіший випадок: сервер просто не запущено (fetch кидає TypeError "Failed to fetch").
    return {
      ok: false,
      error:
        'Не вдалося підключитися до сервера FactGuard (' + API_BASE + '). ' +
        'Блоки «Джерело» і «Подача» працюють і без нього, а для перевірки фактів запустіть сервер: ' +
        'у папці server двічі клацніть start-server (або виконайте «python main.py»).'
    };
  } finally {
    clearTimeout(timer);
  }
}

const verifyNews = (payload) => postToServer(VERIFY_ENDPOINT, payload, REQUEST_TIMEOUT_MS);
const aiCheck = (payload) => postToServer(AI_ENDPOINT, payload, AI_TIMEOUT_MS);

async function checkServerHealth() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetch(HEALTH_ENDPOINT, { signal: controller.signal });
    return response.ok ? { ok: true, data: await response.json() } : { ok: false };
  } catch (e) {
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}

// ---------- ЧОРНИЙ СПИСОК ФІШИНГУ (з PhishGuard) ----------

let phishDomains = new Set();
let lastFetchTime = 0;
let loadingPromise = null;

function parseHostsFile(text) {
  const domains = new Set();
  for (let line of text.split('\n')) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    domains.add((parts.length >= 2 ? parts[1] : parts[0]).toLowerCase());
  }
  return domains;
}

async function loadBlocklist() {
  if (phishDomains.size === 0) {
    const saved = await chrome.storage.local.get(['phishText', 'phishTime']);
    if (saved.phishText) {
      phishDomains = parseHostsFile(saved.phishText);
      lastFetchTime = saved.phishTime || 0;
    }
  }
  if (phishDomains.size > 0 && Date.now() - lastFetchTime < LIST_TTL) return;
  try {
    const response = await fetch(PHISHDESTROY_LIST_URL, { cache: 'no-cache' });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const text = await response.text();
    const domains = parseHostsFile(text);
    if (domains.size < 1000) throw new Error('Підозріло короткий список: ' + domains.size);
    phishDomains = domains;
    lastFetchTime = Date.now();
    await chrome.storage.local.set({ phishText: text, phishTime: lastFetchTime });
  } catch (e) {
    console.warn('FactGuard: не вдалося оновити чорний список PhishDestroy:', e);
  }
}

// Якщо кілька вкладок попросять список одночасно, завантажуємо його лише один раз
function ensureBlocklist() {
  if (!loadingPromise) loadingPromise = loadBlocklist().finally(() => { loadingPromise = null; });
  return loadingPromise;
}

// ---------- БІЛИЙ І ЧОРНИЙ СПИСКИ, ДОВІДНИК ЗМІ, ВІК ДОМЕНУ ----------

// Списки зберігаються в chrome.storage.sync — синхронізуються між комп'ютерами з тим самим акаунтом Chrome.
//   trusted — білий список (довіряю), blocked — чорний список (блокувати)
async function getLists() {
  const { trusted, blocked } = await chrome.storage.sync.get({ trusted: [], blocked: [] });
  return { trusted, blocked };
}

/**
 * Додає або прибирає сайт зі списку. Сайт не може бути одночасно в обох списках:
 * додавання в один автоматично прибирає з іншого.
 */
async function changeList(listName, input, add, matching = false) {
  if (listName !== 'trusted' && listName !== 'blocked') return { ok: false, error: 'Невідомий список.' };
  const entry = Lists.normalizeEntry(input);
  if (!entry) return { ok: false, error: 'Це не схоже на адресу сайту. Приклад: example.com' };
  const lists = await getLists();
  const other = listName === 'trusted' ? 'blocked' : 'trusted';
  if (add) {
    lists[listName] = Lists.addEntry(lists[listName], entry);
    lists[other] = Lists.removeEntry(lists[other], entry);
  } else if (matching) {
    // «Прибрати цей сайт зі списку»: видаляємо всі записи, що на нього діють (і батьківський домен)
    lists[listName] = lists[listName].filter(e => !Lists.findMatch(entry, [e]));
  } else {
    lists[listName] = Lists.removeEntry(lists[listName], entry);
  }
  await chrome.storage.sync.set(lists);
  // Збережені результати перевірки вкладок застаріли — позначаємо час зміни
  await chrome.storage.session.set({ listsChangedAt: Date.now() });
  return { ok: true, entry, lists };
}

let mediaDirectory = null;
async function getDirectory() {
  if (!mediaDirectory) {
    const response = await fetch(chrome.runtime.getURL('data/trusted-media.json'));
    mediaDirectory = await response.json();
  }
  return mediaDirectory;
}

// RDAP — сучасна заміна WHOIS. Щоб не відправляти кожен відвіданий сайт у мережу,
// вік перевіряємо лише для підозрілих сайтів або коли користувач сам натиснув «Перевірити».
async function getDomainAgeDays(domain) {
  const key = 'age:' + domain;
  const cached = (await chrome.storage.local.get(key))[key];
  if (cached && Date.now() - cached.checkedAt < (cached.registered ? AGE_TTL : AGE_FAIL_TTL)) {
    return cached.registered ? daysSince(cached.registered) : null;
  }
  let registered = null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const response = await fetch('https://rdap.org/domain/' + encodeURIComponent(domain), { signal: controller.signal });
    clearTimeout(timer);
    if (response.ok) {
      const data = await response.json();
      const event = (data.events || []).find(e => e.eventAction === 'registration');
      if (event && !isNaN(Date.parse(event.eventDate))) registered = event.eventDate;
    }
  } catch (e) {
    // Немає інтернету або зона не підтримує RDAP — просто пропускаємо цю перевірку
  }
  await chrome.storage.local.set({ [key]: { registered, checkedAt: Date.now() } });
  return registered ? daysSince(registered) : null;
}

function daysSince(dateString) {
  return Math.floor((Date.now() - Date.parse(dateString)) / 86400000);
}

// ---------- ПЕРЕВІРКА САЙТУ НА ФІШИНГ ----------

async function analyzeSite(url, page, { forceAge = false } = {}) {
  await ensureBlocklist();
  const lists = await getLists();
  const ctx = {
    isBlocked: d => phishDomains.has(d),
    isUserBlocked: host => !!Lists.findMatch(host, lists.blocked),
    isTrusted: (domain, host) => !!Lists.findMatch(host || domain, lists.trusted),
    page,
  };
  let result = PhishAnalyzer.analyzeUrl(url, ctx);

  const canCheckAge = result.domain && result.score !== null && !result.blocked && !result.userBlocked && !result.trusted
    && !PhishAnalyzer.isIpAddress(result.hostname);
  if (canCheckAge && (forceAge || (result.score > 0 && !result.officialBrand))) {
    const age = await getDomainAgeDays(result.domain);
    if (age !== null) {
      result = PhishAnalyzer.analyzeUrl(url, Object.assign(ctx, { domainAgeDays: age }));
      result.domainAgeDays = age;
    }
  }
  return result;
}

function siteBadge(tabId, result) {
  const styles = { danger: ['!', '#dc2626'], warning: ['?', '#d97706'] };
  const style = styles[result && result.level];
  setBadge(tabId, style ? style[0] : '', style ? style[1] : null);
}

async function saveTabState(tabId, state) {
  await chrome.storage.session.set({ ['tab:' + tabId]: Object.assign({ checkedAt: Date.now() }, state) });
}

async function getTabState(tabId) {
  return (await chrome.storage.session.get('tab:' + tabId))['tab:' + tabId];
}

// ---------- ОБРОБКА ПОВІДОМЛЕНЬ ----------

const VERDICT_BADGES = {
  confirmed: ['✓', '#16a34a'],
  insufficient: ['?', '#d97706'],
  disputed: ['!', '#d97706'],
  refuted: ['!', '#dc2626'],
};

const handlers = {
  // content.js при завантаженні сторінки: перевірка на фішинг + банер
  async FG_ANALYZE_PAGE(message, sender) {
    const tabId = sender.tab && sender.tab.id;
    const result = await analyzeSite(message.url, message.page);
    if (tabId != null) {
      await saveTabState(tabId, { url: message.url, page: message.page, result });
      siteBadge(tabId, result);
    }
    return result;
  },

  // Перевірка джерела новини (блок «Джерело»)
  async FG_SOURCE(message) {
    const [site, directory] = await Promise.all([analyzeSite(message.url, null, { forceAge: true }), getDirectory()]);
    return SourceCheck.checkSource(message.url, directory, { site, domainAgeDays: site.domainAgeDays });
  },

  // Перевірка фактів через Python-сервер (від content.js та popup.js)
  async FG_VERIFY(message, sender) {
    const result = await verifyNews(message.payload || {});
    // sender.tab є лише коли повідомлення прийшло зі сторінки (не з popup).
    const tabId = sender && sender.tab ? sender.tab.id : null;
    if (tabId != null) {
      const state = await getTabState(tabId);
      const siteIsDangerous = state && state.result && state.result.level === 'danger';
      if (!siteIsDangerous) { // попередження про фішинг важливіше за вердикт новини
        const badge = result.ok ? (VERDICT_BADGES[result.data.status] || VERDICT_BADGES.insufficient) : ['×', '#6b7280'];
        setBadge(tabId, badge[0], badge[1]);
      }
    }
    return result;
  },

  // ШІ-аналіз новини через сервер (від content.js). evidence — результат FG_VERIFY, щоб не шукати вдруге.
  async FG_AI(message) {
    return aiCheck(message.payload || {});
  },

  // popup: перевірка довільного посилання
  async FG_ANALYZE_URL(message) {
    return analyzeSite(message.url, null);
  },

  // popup: результат перевірки сайту для поточної вкладки
  async FG_TAB_RESULT(message) {
    const state = await getTabState(message.tabId);
    // Якщо Chrome не дав popup адресу вкладки, беремо ту, яку раніше надіслав content.js
    const url = message.url || (state && state.url);
    if (!url) {
      return { score: null, level: 'unknown', reasons: [{ points: 0, text: 'Немає доступу до адреси цієї вкладки. Оновіть сторінку (F5).' }] };
    }
    const sameUrl = state && state.url === url;
    const { listsChangedAt = 0 } = await chrome.storage.session.get('listsChangedAt');
    const fresh = sameUrl && (state.checkedAt || 0) > listsChangedAt;
    if (fresh && !message.refresh) return state.result;
    const page = sameUrl ? state.page : null;
    const result = await analyzeSite(url, page);
    await saveTabState(message.tabId, { url, page, result });
    siteBadge(message.tabId, result);
    return result;
  },

  // Білий / чорний список: {list: 'trusted'|'blocked', domain, add: true|false}
  async FG_LIST_CHANGE(message) {
    return changeList(message.list, message.domain, message.add !== false, !!message.matching);
  },

  async FG_LISTS() {
    return getLists();
  },

  // Стара назва з першої версії (кнопка «Я довіряю» на банері)
  async FG_SET_TRUSTED(message) {
    return changeList('trusted', message.domain, message.trusted, !message.trusted);
  },

  async FG_STATUS() {
    const [, lists, server] = await Promise.all([ensureBlocklist(), getLists(), checkServerHealth()]);
    return {
      blocklistSize: phishDomains.size, lastFetchTime,
      trustedCount: lists.trusted.length, blockedCount: lists.blocked.length, server,
    };
  },
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = message && handlers[message.type];
  if (!handler) return false;
  handler(message, sender)
    .then(sendResponse)
    .catch((e) => {
      console.error('FactGuard:', e);
      sendResponse({ ok: false, error: 'Внутрішня помилка розширення: ' + e.message });
    });
  return true; // ОБОВ'ЯЗКОВО: повідомляє Chrome, що sendResponse буде викликано асинхронно
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove('tab:' + tabId);
});
