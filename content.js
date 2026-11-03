/**
 * FactGuard — content script.
 *
 * Виконується всередині відкритої вкладки (у "ізольованому світі": бачить DOM сторінки,
 * але не бачить змінних самого сайту). Відповідає за:
 *   1) перевірку сайту на фішинг одразу при відкритті сторінки (червоний банер, як у PhishGuard);
 *   2) витягування заголовка (h1), тексту статті, автора, дати, посилань;
 *   3) запуск локального аналізу (FactGuardAnalyzer), перевірку джерела та запит до сервера через background.js;
 *   4) ШІ-аналіз (якщо його підключено на сервері та не вимкнено в налаштуваннях);
 *   5) показ плаваючого оверлею з результатом (і передачу того самого результату у віконце розширення).
 *
 * Оверлей і банер створюються в Shadow DOM, щоб стилі сайту не ламали наш вигляд і навпаки.
 */
(function () {
  'use strict';

  // Захист від подвійного завантаження (скрипт можуть ін'єктувати повторно).
  if (window.__factguardLoaded) return;
  window.__factguardLoaded = true;

  const UI = window.FactGuardUI;             // з src/ui.js
  const Analyzer = window.FactGuardAnalyzer; // з src/news-analyzer.js
  const Phish = window.PhishAnalyzer;        // з src/analyzer.js
  const HOST_ID = 'factguard-overlay-host';
  const MAX_TEXT = 6000; // обмежуємо обсяг тексту, що відправляється на сервер
  const BANNER_THRESHOLD = 40; // з якого рівня ризику фішингу показувати банер

  // Додаткові стилі лише для рамки оверлея (стилі вмісту беруться з UI.CSS).
  const OVERLAY_CSS = `
:host{all:initial}
.fg-panel{width:390px;max-width:calc(100vw - 32px);max-height:calc(100vh - 32px);display:flex;flex-direction:column;background:#fff;border-radius:18px;box-shadow:0 18px 50px rgba(15,23,42,.35);overflow:hidden;animation:fg-in .25s ease-out;font-family:-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
@keyframes fg-in{from{opacity:0;transform:translateY(-10px) scale(.98)}to{opacity:1;transform:none}}
.fg-head{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;background:linear-gradient(135deg,#1e293b,#4338ca);color:#fff}
.fg-brand{font-weight:700;font-size:15px;letter-spacing:.2px}
.fg-brand small{font-weight:400;opacity:.75;margin-left:6px;font-size:11px}
.fg-close{all:unset;cursor:pointer;width:26px;height:26px;border-radius:8px;text-align:center;line-height:26px;font-size:18px;color:#fff;background:rgba(255,255,255,.15)}
.fg-close:hover{background:rgba(255,255,255,.3)}
.fg-body{padding:14px;overflow-y:auto}
`;

  let host = null;   // елемент-контейнер оверлея на сторінці
  let bodyEl = null; // всередині Shadow DOM: сюди підставляється вміст

  function closeOverlay() {
    if (host && host.parentNode) host.parentNode.removeChild(host);
    host = null;
    bodyEl = null;
  }

  /** Створює оверлей, якщо його ще немає (або сайт його видалив зі сторінки). */
  function ensureOverlay() {
    if (host && document.documentElement.contains(host) && bodyEl) return;
    closeOverlay();

    host = document.createElement('div');
    host.id = HOST_ID;
    // fixed + максимальний z-index = завжди поверх сторінки, у правому верхньому куті.
    host.style.cssText = 'all:initial;position:fixed;top:16px;right:16px;z-index:2147483647;';
    const shadow = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = UI.CSS + OVERLAY_CSS;

    const closeBtn = UI.h('button', { class: 'fg-close', title: 'Закрити', 'aria-label': 'Закрити', onClick: closeOverlay }, '×');
    bodyEl = UI.h('div', { class: 'fg-body' });
    const panel = UI.h(
      'div',
      { class: 'fg-panel', role: 'dialog', 'aria-label': 'FactGuard' },
      UI.h('div', { class: 'fg-head' }, UI.h('div', { class: 'fg-brand' }, '🛡️ FactGuard', UI.h('small', { text: 'Перевірка новин' })), closeBtn),
      bodyEl
    );

    shadow.appendChild(style);
    shadow.appendChild(panel);
    document.documentElement.appendChild(host);
  }

  /** Замінює вміст оверлея на переданий DOM-вузол. */
  function showNode(node) {
    ensureOverlay();
    bodyEl.replaceChildren(node);
  }

  /**
   * Показує результат в оверлеї і паралельно надсилає ті самі дані у віконце розширення (popup),
   * щоб там було видно, як просувається перевірка (джерело → пошук → ШІ).
   */
  function showResult(data) {
    showNode(UI.renderResult(data));
    try {
      chrome.runtime.sendMessage({ type: 'FG_PROGRESS', data }).catch(() => {});
    } catch (e) { /* розширення перезавантажено — не страшно */ }
  }

  // Закриття оверлея клавішею Esc.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && host) closeOverlay();
  });

  // ---------- Перевірка сайту на фішинг (з PhishGuard) ----------

  function collectPageSignals() {
    const passwordInput = document.querySelector('input[type="password"]');
    let passwordFormHost = null;
    if (passwordInput && passwordInput.form && passwordInput.form.getAttribute('action')) {
      try {
        const formHost = new URL(passwordInput.form.action).hostname;
        if (formHost && formHost !== location.hostname) passwordFormHost = formHost;
      } catch (e) { /* дивна адреса у формі — ігноруємо */ }
    }
    // Бренд шукаємо лише в заголовку вкладки та h1: там фішингова сторінка «представляється».
    const h1 = document.querySelector('h1');
    return {
      hasPasswordField: !!passwordInput,
      passwordFormHost,
      brandMentions: Phish.findBrandMentions(document.title + ' ' + (h1 ? h1.textContent : '')),
    };
  }

  let bannerHost = null;

  function removePhishBanner() {
    if (bannerHost) bannerHost.remove();
    bannerHost = null;
  }

  function checkSiteForPhishing() {
    chrome.runtime.sendMessage({ type: 'FG_ANALYZE_PAGE', url: location.href, page: collectPageSignals() }, (result) => {
      if (chrome.runtime.lastError || !result) return;
      if (result.score !== null && result.score >= BANNER_THRESHOLD) showPhishBanner(result);
      else removePhishBanner(); // наприклад, сайт щойно додали до білого списку
    });
  }

  function changeList(list, domain, add) {
    // matching: при видаленні прибрати всі записи, під які підпадає цей сайт (наприклад, і example.com для mail.example.com)
    chrome.runtime.sendMessage({ type: 'FG_LIST_CHANGE', list, domain, add, matching: true }, () => {
      void chrome.runtime.lastError;
      checkSiteForPhishing();
    });
  }

  function showPhishBanner(result) {
    removePhishBanner();
    bannerHost = document.createElement('div');
    bannerHost.id = 'factguard-phish-banner';
    const shadow = bannerHost.attachShadow({ mode: 'closed' });
    const danger = result.score >= 70;
    const listEntry = result.hostname ? result.hostname.replace(/^www\./, '') : result.domain;
    const style = document.createElement('style');
    style.textContent = `
      .bar{position:fixed;top:0;left:0;right:0;z-index:2147483646;background:${danger ? '#c5221f' : '#e37400'};color:#fff;
           font:15px/1.4 -apple-system,"Segoe UI",Roboto,Arial,sans-serif;padding:12px 16px;box-shadow:0 4px 12px rgba(0,0,0,.35)}
      .title{font-weight:700;font-size:17px} ul{margin:6px 0 8px;padding-left:20px}
      .buttons{display:flex;gap:8px;flex-wrap:wrap}
      button{font:inherit;font-size:13px;border-radius:4px;padding:5px 12px;cursor:pointer}
      .primary{background:#fff;color:#202124;border:1px solid #fff;font-weight:600}
      .secondary{background:transparent;color:#fff;border:1px solid rgba(255,255,255,.7)}`;
    const bar = UI.h('div', { class: 'bar', role: 'alert' },
      UI.h('div', { class: 'title', text: result.userBlocked
        ? `⛔ FactGuard: цей сайт є у вашому чорному списку`
        : danger
          ? `⚠️ FactGuard: ймовірно, це фішинговий сайт (ризик ${result.score}/100)`
          : `⚠️ FactGuard: сайт має підозрілі ознаки (ризик ${result.score}/100)` }),
      UI.h('ul', {}, result.reasons.slice(0, 3).map(r => UI.h('li', { text: r.text }))),
      UI.h('div', { class: 'buttons' },
        UI.h('button', { class: 'primary', text: 'Покинути сайт',
          onClick: () => { if (history.length > 1) history.back(); else location.href = 'about:blank'; } }),
        UI.h('button', { class: 'secondary', text: 'Закрити попередження', onClick: removePhishBanner }),
        result.userBlocked
          ? UI.h('button', { class: 'secondary', text: 'Прибрати з чорного списку',
            onClick: () => changeList('blocked', listEntry, false) })
          : !result.blocked && result.domain
            ? UI.h('button', { class: 'secondary', text: `Додати ${result.domain} до білого списку`,
              onClick: () => changeList('trusted', result.domain, true) })
            : null));
    shadow.append(style, bar);
    document.documentElement.appendChild(bannerHost);
  }

  checkSiteForPhishing();

  // Багато сторінок входу домальовують форму пароля пізніше. Стежимо 15 секунд.
  if (!document.querySelector('input[type="password"]')) {
    const observer = new MutationObserver(() => {
      if (document.querySelector('input[type="password"]')) {
        observer.disconnect();
        checkSiteForPhishing();
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => observer.disconnect(), 15000);
  }

  // ---------- Витягування новини зі сторінки ----------

  /** Заголовок: спершу h1 (краще всередині <article>), інакше og:title, інакше <title>. */
  function getHeadline() {
    const h1 = document.querySelector('article h1') || document.querySelector('h1');
    const fromH1 = h1 && (h1.innerText || h1.textContent || '').trim();
    if (fromH1) return fromH1;
    const og = document.querySelector('meta[property="og:title"]');
    return ((og && og.content) || document.title || '').trim();
  }

  /** Тексти всіх <p> усередині root, довших за minLen символів (відсікає меню, підписи, "Читайте також"). */
  function paragraphsOf(root, minLen) {
    return Array.from(root.querySelectorAll('p'))
      .map((p) => (p.innerText || p.textContent || '').trim())
      .filter((t) => t.length >= minLen);
  }

  const ARTICLE_SELECTORS = ['article', '[itemprop="articleBody"]', '.article-body', '.article__text', '.post-content', '.entry-content', 'main', '#content'];

  /**
   * Основний текст: пробуємо типові контейнери статті. Беремо перший, де набралось >200 символів.
   * Якщо не вийшло — збираємо довгі абзаци з усієї сторінки.
   */
  function getArticleContainer() {
    for (const sel of ARTICLE_SELECTORS) {
      const node = document.querySelector(sel);
      if (node && paragraphsOf(node, 40).join('\n').length > 200) return node;
    }
    return null;
  }

  function getArticleText(container) {
    if (container) return paragraphsOf(container, 40).join('\n').slice(0, MAX_TEXT);
    return paragraphsOf(document.body, 60).join('\n').slice(0, MAX_TEXT);
  }

  /** Автор, дата та кількість посилань на інші сайти — для аналізу подачі. */
  function getArticleMeta(container) {
    // Багато сайтів описують статтю в машиночитному блоці JSON-LD (для Google) — перевіряємо і його
    const jsonLd = Array.from(document.querySelectorAll('script[type="application/ld+json"]'))
      .map((s) => s.textContent).join('\n');
    const hasAuthor = /"author"\s*:/.test(jsonLd) || !!document.querySelector(
      'meta[name="author"][content]:not([content=""]), meta[property="article:author"], ' +
      '[rel="author"], [itemprop="author"], .author, .byline, [class*="author"]');
    const hasDate = /"datePublished"\s*:/.test(jsonLd) || !!document.querySelector(
      'meta[property="article:published_time"], meta[name="date"], meta[itemprop="datePublished"], ' +
      '[itemprop="datePublished"], time[datetime], [class*="post__time"], [class*="publish"], [class*="article-date"]');
    const ownDomain = Phish.getRegistrableDomain(location.hostname);
    let externalLinks = 0;
    (container || document.body).querySelectorAll('a[href]').forEach((a) => {
      try {
        const u = new URL(a.href);
        if (/^https?:$/.test(u.protocol) && Phish.getRegistrableDomain(u.hostname) !== ownDomain) externalLinks++;
      } catch (e) { /* ігноруємо */ }
    });
    return { hasAuthor, hasDate, externalLinks };
  }

  function extractArticle() {
    const container = getArticleContainer();
    return Object.assign(
      { title: getHeadline(), text: getArticleText(container), url: location.href },
      getArticleMeta(container)
    );
  }

  /**
   * Для перевірки виділеного фрагмента:
   *  • короткий (≤250 символів) вважаємо заголовком/твердженням;
   *  • довгий — текстом, а заголовок беремо зі сторінки.
   */
  function articleFromSelection(selection) {
    const sel = (selection || window.getSelection().toString() || '').trim();
    const meta = getArticleMeta(null);
    if (sel.length <= 250) return Object.assign({ title: sel, text: '', url: location.href }, meta);
    return Object.assign({ title: getHeadline(), text: sel.slice(0, MAX_TEXT), url: location.href }, meta);
  }

  // ---------- Перевірка ----------

  function sendMessage(message) {
    return chrome.runtime.sendMessage(message).catch(() => null);
  }

  /**
   * Повний цикл: локальний аналіз + перевірка джерела -> спінер -> запит до сервера -> результат.
   * Повертає {local, source, response}, щоб popup теж міг показати дані.
   */
  async function getSettings() {
    try {
      return await chrome.storage.sync.get({ aiEnabled: true });
    } catch (e) {
      return { aiEnabled: true };
    }
  }

  async function runCheck(article) {
    if (!article.title && !article.text) {
      const error = 'Не вдалося знайти текст новини на цій сторінці. Виділіть заголовок або абзац і виберіть «Перевірити новину на фактчекінг» у контекстному меню.';
      showResult({ error });
      return { local: null, source: null, response: { ok: false, error } };
    }

    // 1) Миттєвий локальний аналіз стилю (не потребує сервера).
    const local = Analyzer.analyze(article);
    showNode(UI.renderLoading('Перевіряємо джерело та подачу…'));

    // 2) Перевірка джерела (білий список ІМІ, підробки, фішинг, вік домену, ваші списки).
    const source = await sendMessage({ type: 'FG_SOURCE', url: article.url });
    const base = { title: article.title, local, source };
    showResult(Object.assign({ pending: true }, base));

    // 3) Запит до сервера — через background.js. style_score допомагає серверу з поясненням.
    let response = await sendMessage({
      type: 'FG_VERIFY',
      payload: { title: article.title, text: article.text, url: article.url, style_score: local.score }
    });
    if (!response) {
      // Типово: розширення оновили/перезавантажили, а сторінка ще зі "старим" скриптом.
      response = { ok: false, error: 'Розширення не отримало відповіді від фонового скрипта. Перезавантажте сторінку та спробуйте ще раз.' };
    }

    // 4) Показ результату. Якщо сервер недоступний — все одно показуємо джерело і маніпуляції + помилку.
    const withServer = Object.assign({}, base, response.ok ? { server: response.data } : { error: response.error });
    const settings = await getSettings();
    const serverDown = !response.ok && /підключитися|не відповів|фонового скрипта/.test(response.error || '');
    if (!settings.aiEnabled || serverDown) {
      showResult(withServer);
      return { local, source, response };
    }

    // 5) ШІ-аналіз: сервер читає статті інших сайтів, знайдені на кроці 3, і питає модель.
    showResult(Object.assign({ aiPending: true }, withServer));
    const aiResponse = await sendMessage({
      type: 'FG_AI',
      payload: { title: article.title, text: article.text, url: article.url, evidence: response.ok ? response.data : null }
    });
    let ai = null;
    let aiError = null;
    if (!aiResponse) aiError = 'Розширення не отримало відповіді від фонового скрипта. Перезавантажте сторінку.';
    else if (!aiResponse.ok) aiError = aiResponse.error;
    else if (aiResponse.data && aiResponse.data.enabled === false) ai = { disabled: true, reason: aiResponse.data.reason };
    else ai = aiResponse.data;
    showResult(Object.assign({ ai, aiError }, withServer));
    return { local, source, response, ai, aiError };
  }

  // Повідомлення від popup (FG_SCAN_PAGE) та background (FG_CHECK_SELECTION).
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message) return false;
    if (message.type === 'FG_SCAN_PAGE' || message.type === 'FG_CHECK_SELECTION') {
      const article = message.type === 'FG_SCAN_PAGE' ? extractArticle() : articleFromSelection(message.selection);
      runCheck(article)
        .then((result) => sendResponse(Object.assign({ ok: true, article }, result)))
        .catch((err) => sendResponse({ ok: false, error: String(err && err.message ? err.message : err) }));
      return true; // відповідь асинхронна
    }
    if (message.type === 'FG_RECHECK_SITE') { // popup змінив білий/чорний список
      checkSiteForPhishing();
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });
})();
