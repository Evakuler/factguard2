/**
 * FactGuard — спільний рендер результатів (оверлей на сторінці + popup).
 *
 * Результат перевірки складається з чотирьох блоків:
 *   1) Джерело  — хто публікує (білий список ІМІ, підробки, фішинг, вік домену, ваші списки);
 *   2) Подача   — ознаки маніпуляції в тексті (працює без сервера);
 *   3) Факти    — перехресна перевірка на інших сайтах та у фактчекерів (Python-сервер);
 *   4) ШІ-аналіз — висновок моделі штучного інтелекту, яка прочитала статті інших сайтів (Python-сервер + ключ ШІ).
 *
 * Увесь текст вставляється через textContent, тому дані з інтернету ніколи не стануть HTML-кодом.
 */
(function (root) {
  'use strict';

  const CSS = `
.fg-root{font:13px/1.45 -apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#1f2937}
.fg-section{padding:10px 0;border-top:1px solid #e5e7eb}
.fg-section:first-child{border-top:0;padding-top:0}
.fg-title{display:flex;align-items:center;gap:8px;font-weight:700;font-size:12px;text-transform:uppercase;letter-spacing:.4px;color:#6b7280;margin-bottom:6px}
.fg-badge{display:inline-block;padding:3px 10px;border-radius:999px;color:#fff;font-weight:600;font-size:12px;text-transform:none;letter-spacing:0}
.fg-good{background:#16a34a}.fg-warn{background:#d97706}.fg-bad{background:#dc2626}.fg-neutral{background:#6b7280}
.fg-name{font-weight:600;font-size:14px;margin-bottom:2px;word-break:break-word}
.fg-list{list-style:none;margin:4px 0 0;padding:0}
.fg-list li{display:flex;gap:8px;align-items:flex-start;padding:3px 0}
.fg-dot{flex:none;width:8px;height:8px;border-radius:50%;margin-top:6px}
.fg-pts{flex:none;min-width:30px;text-align:center;font-size:11px;font-weight:700;border-radius:4px;padding:0 4px;background:#fee2e2;color:#b91c1c}
.fg-muted{color:#6b7280;font-size:12px}
.fg-summary{margin:6px 0}
.fg-links{list-style:none;margin:6px 0 0;padding:0}
.fg-links li{padding:4px 0;border-top:1px dashed #e5e7eb}
.fg-links li:first-child{border-top:0}
.fg-links a{color:#4338ca;text-decoration:none;font-weight:500}
.fg-links a:hover{text-decoration:underline}
.fg-src{font-size:11px;color:#6b7280}
.fg-tag{display:inline-block;font-size:10px;font-weight:700;border-radius:4px;padding:0 5px;margin-left:4px;vertical-align:1px}
.fg-tag-ok{background:#dcfce7;color:#166534}.fg-tag-bad{background:#fee2e2;color:#991b1b}.fg-tag-fc{background:#e0e7ff;color:#3730a3}
.fg-error{background:#fef3c7;color:#78350f;border-radius:8px;padding:8px 10px;margin-top:4px}
.fg-loading{display:flex;align-items:center;gap:10px;color:#4b5563;padding:6px 0}
.fg-spinner{width:18px;height:18px;border:3px solid #e0e7ff;border-top-color:#4338ca;border-radius:50%;animation:fg-spin .8s linear infinite;flex:none}
@keyframes fg-spin{to{transform:rotate(360deg)}}
.fg-foot{margin-top:8px;font-size:11px;color:#6b7280}
.fg-foot a{color:#4338ca}
.fg-ai{background:linear-gradient(135deg,#eef2ff,#f5f3ff);border:1px solid #e0e7ff;border-radius:10px;padding:10px;margin-top:2px}
.fg-conf{height:6px;background:#e5e7eb;border-radius:3px;overflow:hidden;margin:6px 0 2px}
.fg-conf>div{height:100%;border-radius:3px}
.fg-claims{list-style:none;margin:6px 0 0;padding:0}
.fg-claims li{padding:5px 0;border-top:1px dashed #c7d2fe}
.fg-claims li:first-child{border-top:0}
.fg-claim{font-weight:600}
.fg-ev{font-size:12px;color:#4b5563;margin-top:1px}
.fg-advice{margin-top:6px;font-size:12px;background:#fff;border-radius:6px;padding:6px 8px}
.fg-sub{font-size:11px;font-weight:700;color:#4338ca;margin-top:8px;text-transform:uppercase;letter-spacing:.3px}
`;

  /** Створення елемента: h('div', {class:'x', text:'...', onClick: fn}, ...діти) */
  function h(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'text') node.textContent = value;
      else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
      else node.setAttribute(key, value);
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child instanceof Node ? child : String(child));
    }
    return node;
  }

  // Посилання з інтернету відкриваємо лише якщо це справжні http(s)-адреси (не javascript: тощо)
  function link(url, text) {
    let safe = null;
    try {
      const u = new URL(url);
      if (u.protocol === 'http:' || u.protocol === 'https:') safe = u.href;
    } catch (e) { /* некоректне посилання */ }
    if (!safe) return h('span', { text });
    return h('a', { href: safe, target: '_blank', rel: 'noopener noreferrer', text });
  }

  const TONE_CLASS = { good: 'fg-good', bad: 'fg-bad', neutral: 'fg-neutral', warn: 'fg-warn' };
  const DOT_COLOR = { good: '#16a34a', bad: '#dc2626', neutral: '#9ca3af', warn: '#d97706' };

  function renderLoading(text) {
    return h('div', { class: 'fg-root' },
      h('div', { class: 'fg-loading' }, h('div', { class: 'fg-spinner' }), h('span', { text: text || 'Перевіряємо…' })));
  }

  // ---------- 1. Джерело ----------
  function renderSource(source) {
    if (!source) return null;
    const label = { good: 'Надійне', bad: 'Підозріле', neutral: 'Невідоме' }[source.tone] || 'Невідоме';
    return h('div', { class: 'fg-section' },
      h('div', { class: 'fg-title' }, 'Джерело', h('span', { class: 'fg-badge ' + TONE_CLASS[source.tone], text: label })),
      h('div', { class: 'fg-name', text: source.title }),
      source.hostname && source.hostname !== source.title ? h('div', { class: 'fg-muted', text: source.hostname }) : null,
      h('ul', { class: 'fg-list' }, (source.notes || []).map(n =>
        h('li', {}, h('span', { class: 'fg-dot', style: 'background:' + DOT_COLOR[n.tone] }), h('span', { text: n.text })))));
  }

  // ---------- 2. Подача ----------
  function renderStyle(local) {
    if (!local) return null;
    const levelText = { safe: 'Мало ознак маніпуляції', warning: 'Є ознаки маніпуляції', danger: 'Багато ознак маніпуляції', unknown: 'Не оцінено' };
    const tone = { safe: 'good', warning: 'warn', danger: 'bad', unknown: 'neutral' }[local.level] || 'neutral';
    const badge = local.score === null ? levelText.unknown : `${levelText[local.level]} · ${local.score}/100`;
    return h('div', { class: 'fg-section' },
      h('div', { class: 'fg-title' }, 'Подача', h('span', { class: 'fg-badge ' + TONE_CLASS[tone], text: badge })),
      h('ul', { class: 'fg-list' }, (local.reasons || []).slice(0, 6).map(r =>
        h('li', {}, r.points > 0 ? h('span', { class: 'fg-pts', text: '+' + r.points }) : h('span', { class: 'fg-dot', style: 'background:#9ca3af' }),
          h('span', { text: r.text })))));
  }

  // ---------- 3. Перехресна перевірка ----------
  function renderServer(server, error, pending) {
    const title = h('div', { class: 'fg-title' }, 'Перевірка фактів');
    if (pending) {
      return h('div', { class: 'fg-section' }, title, renderLoading('Шукаємо цю новину в інших ЗМІ та у фактчекерів…'));
    }
    if (error) {
      return h('div', { class: 'fg-section' }, title, h('div', { class: 'fg-error', text: error }));
    }
    if (!server) return null;

    const tone = { confirmed: 'good', insufficient: 'warn', disputed: 'warn', refuted: 'bad' }[server.status] || 'neutral';
    title.append(h('span', { class: 'fg-badge ' + TONE_CLASS[tone], text: server.label || server.status }));

    const factchecks = (server.factchecks || []).slice(0, 4);
    const sources = (server.sources || []).slice(0, 6);

    return h('div', { class: 'fg-section' },
      title,
      server.summary ? h('div', { class: 'fg-summary', text: server.summary }) : null,
      factchecks.length ? h('div', { class: 'fg-muted', text: 'Фактчекери:' }) : null,
      factchecks.length ? h('ul', { class: 'fg-links' }, factchecks.map(f =>
        h('li', {}, link(f.url, f.title),
          f.refutes ? h('span', { class: 'fg-tag fg-tag-bad', text: f.rating || 'ФЕЙК' }) : h('span', { class: 'fg-tag fg-tag-fc', text: f.rating || 'розбір' }),
          h('div', { class: 'fg-src', text: f.publisher || '' })))) : null,
      sources.length ? h('div', { class: 'fg-muted', style: 'margin-top:6px', text: 'Що пишуть інші сайти:' }) : null,
      sources.length ? h('ul', { class: 'fg-links' }, sources.map(s =>
        h('li', {}, link(s.url, s.title),
          s.trusted ? h('span', { class: 'fg-tag fg-tag-ok', text: '✓ перевірене' }) : null,
          h('div', { class: 'fg-src', text: s.name || s.domain })))) : null,
      server.partial_search ? h('div', { class: 'fg-muted', style: 'margin-top:6px',
        text: 'Частина пошукових систем не відповіла — результат може бути неповним.' }) : null,
      server.search_url ? h('div', { class: 'fg-foot' }, link(server.search_url, 'Подивитися пошук самостійно →')) : null);
  }

  // ---------- 4. ШІ-аналіз ----------
  const CLAIM_TONE = { confirmed: 'fg-tag-ok', refuted: 'fg-tag-bad', unconfirmed: 'fg-tag-fc', no_data: 'fg-tag-fc' };
  const CONF_COLOR = { good: '#16a34a', bad: '#dc2626', warn: '#d97706', neutral: '#6b7280' };

  function renderAI(ai, error, pending) {
    const title = h('div', { class: 'fg-title' }, '🤖 ШІ-аналіз');
    if (pending) {
      return h('div', { class: 'fg-section' }, title,
        renderLoading('ШІ читає статті інших сайтів і аналізує новину… (зазвичай 5–30 с)'));
    }
    if (error) return h('div', { class: 'fg-section' }, title, h('div', { class: 'fg-error', text: error }));
    if (!ai) return null;
    if (ai.disabled) {
      return h('div', { class: 'fg-section' }, title,
        h('div', { class: 'fg-muted', text: (ai.reason || 'ШІ не підключено.') +
          ' Як підключити — див. README.md, розділ «Підключення ШІ».' }));
    }
    const tone = ai.tone || 'neutral';
    title.append(h('span', { class: 'fg-badge ' + TONE_CLASS[tone], text: ai.verdict_label || ai.verdict }));
    const claims = (ai.claims || []).slice(0, 4);
    const pages = ai.pages_read || [];
    return h('div', { class: 'fg-section' }, title,
      h('div', { class: 'fg-ai' },
        ai.summary ? h('div', { text: ai.summary }) : null,
        h('div', { class: 'fg-conf' }, h('div', { style: `width:${ai.confidence || 0}%;background:${CONF_COLOR[tone]}` })),
        h('div', { class: 'fg-src', text: `Впевненість ШІ: ${ai.confidence ?? '—'}%` }),
        claims.length ? h('div', { class: 'fg-sub', text: 'Ключові твердження' }) : null,
        claims.length ? h('ul', { class: 'fg-claims' }, claims.map(c =>
          h('li', {},
            h('span', { class: 'fg-claim', text: c.claim }),
            h('span', { class: 'fg-tag ' + (CLAIM_TONE[c.assessment] || 'fg-tag-fc'), text: c.assessment_label || c.assessment }),
            c.evidence ? h('div', { class: 'fg-ev', text: c.evidence }) : null))) : null,
        (ai.manipulation || []).length ? h('div', { class: 'fg-sub', text: 'Прийоми маніпуляції' }) : null,
        (ai.manipulation || []).length ? h('ul', { class: 'fg-list' }, ai.manipulation.map(m =>
          h('li', {}, h('span', { class: 'fg-dot', style: 'background:#d97706' }), h('span', { text: m })))) : null,
        ai.advice ? h('div', { class: 'fg-advice', text: '💡 ' + ai.advice }) : null,
        pages.length ? h('div', { class: 'fg-src', style: 'margin-top:6px' },
          'ШІ прочитав статті: ', ...pages.flatMap((pg, i) => [i ? ', ' : '', link(pg.url, pg.name || pg.url)])) : null,
        ai.provider ? h('div', { class: 'fg-src', text: `Модель: ${ai.provider} · ${ai.model}. ШІ може помилятися.` }) : null));
  }

  /**
   * Головна функція: {local, source, server, error, pending, ai, aiError, aiPending, title}
   * Підтримує й старий виклик учениці renderResult({error}) без інших полів.
   */
  function renderResult(data) {
    data = data || {};
    if (data.error && !data.local && !data.source) {
      return h('div', { class: 'fg-root' }, h('div', { class: 'fg-error', text: data.error }));
    }
    const factCheckLink = data.title && root.NewsAnalyzer ? root.NewsAnalyzer.factCheckUrl(data.title) : null;
    return h('div', { class: 'fg-root' },
      data.title ? h('div', { class: 'fg-name', style: 'margin-bottom:8px', text: '«' + data.title + '»' }) : null,
      renderSource(data.source),
      renderStyle(data.local),
      renderServer(data.server, data.error, data.pending),
      renderAI(data.ai, data.aiError, data.aiPending),
      h('div', { class: 'fg-foot' },
        factCheckLink ? link(factCheckLink, 'Google Fact Check Explorer') : null,
        factCheckLink ? ' · ' : null,
        'Програма підказує, але не замінює власну перевірку.'));
  }

  root.FactGuardUI = { CSS, h, link, renderLoading, renderResult };
})(typeof self !== 'undefined' ? self : this);
