// Автоматичні тести FactGuard. Відкриваються з popup → «Самоперевірка».
// Кожен тест: вхідні дані + очікуваний результат. Інтернет і сервер не потрібні.
'use strict';

// Тестовий «чорний список» замість справжнього, щоб результат не залежав від інтернету
const TEST_BLOCKLIST = new Set(['0-105.com', 'evil-phish.top']);

const URL_CASES = [
    // Справжні сайти — мають бути безпечними
    { url: 'https://www.google.com/', expect: 'safe' },
    { url: 'https://mail.google.com/mail/u/0/', expect: 'safe' },
    { url: 'https://accounts.google.com/signin', expect: 'safe', note: 'сторінка входу на офіційному домені' },
    { url: 'https://www.privat24.ua/', expect: 'safe', note: 'у v1.1 було 35 балів' },
    { url: 'https://monobank.ua/', expect: 'safe', note: 'у v1.1 було 35 балів' },
    { url: 'https://www.bbc.co.uk/news', expect: 'safe' },
    { url: 'https://en.wikipedia.org/wiki/Information', expect: 'safe', note: '«form» всередині слова' },
    { url: 'https://github.com/login', expect: 'safe' },
    { url: 'https://github.com/author', expect: 'safe', note: '«auth» всередині слова' },
    { url: 'https://www.mastercard.us/', expect: 'safe', note: 'у v1.1 було 35 балів через «card»' },
    { url: 'https://www.pineapple.com/', expect: 'safe', note: '«apple» всередині слова' },
    { url: 'https://stream.com/', expect: 'safe', note: 'не плутати зі «steam»' },
    { url: 'https://apply.com/', expect: 'safe', note: 'не плутати з «apple»' },
    { url: 'example.com', expect: 'safe', note: 'адреса без https://' },
    { url: 'https://news.ukr.net/', expect: 'safe' },
    { url: 'https://www.olx.ua/uk/', expect: 'safe' },

    // Підозрілі
    { url: 'https://evil-google.com/login', expect: 'warning', note: 'у v1.1 пропускалось' },
    { url: 'https://notpaypal.com/verify', expect: 'warning', note: 'бренд злитий з іншим словом' },
    { url: 'https://paypa1.com/', expect: 'warning', note: 'цифра 1 замість l' },
    { url: 'https://g00gle.com/', expect: 'warning', note: 'нулі замість o' },
    { url: 'https://monobamk.com/', expect: 'warning', note: 'одна літера різниці' },
    { url: 'https://paypal1.com/', expect: 'warning' },
    { url: 'http://192.168.1.1/admin', expect: 'warning' },
    

    // Небезпечні
    { url: 'https://paypal-secure.xyz/login', expect: 'danger' },
    { url: 'https://xn--pypal-4ve.com/', expect: 'danger', note: 'Punycode + схоже на paypal' },
    { url: 'https://xn--80ak6aa92e.com/', expect: 'warning', note: 'Punycode (кирилиця, що імітує латиницю)' },
    { url: 'https://login.paypal.com.secure-check.top/verify', expect: 'danger' },
    { url: 'https://paypal.com@evil.top/', expect: 'danger', note: 'трюк із «@»' },
    { url: 'https://0-105.com/', expect: 'danger', note: 'є в чорному списку' },
    { url: 'https://www.0-105.com/', expect: 'danger', note: 'чорний список + www' },
    { url: 'https://sub.0-105.com/', expect: 'danger', note: 'піддомен із чорного списку — у v1.1 пропускався' },

    // Підробки під ЗМІ (нове у FactGuard)
    { url: 'https://suspilne.media/news/123', expect: 'safe', note: 'справжнє Суспільне' },
    { url: 'https://suspilne-news.top/war', expect: 'warning', note: 'підробка під Суспільне' },
    { url: 'https://www.bbc.com/ukrainian', expect: 'safe' },

    // Не перевіряються
    { url: 'chrome://extensions/', expect: 'unknown' },
    { url: 'https://not a url', expect: 'unknown' },
    { url: 'hello', expect: 'unknown', note: 'просто слово, не адреса' },

    // Ознаки зі сторінки (поле пароля, бренд у заголовку)
    {
        url: 'https://www.paypal.com/signin', expect: 'safe', note: 'справжній PayPal просить пароль',
        page: { hasPasswordField: true, brandMentions: ['paypal'] },
    },
    {
        url: 'https://example-shop.com/login', expect: 'safe', note: 'звичайний магазин з входом',
        page: { hasPasswordField: true, brandMentions: [] },
    },
    {
        url: 'https://secure-help-center.com/', expect: 'warning', note: 'видає себе за PayPal',
        page: { hasPasswordField: true, brandMentions: ['paypal'] },
    },
    {
        url: 'http://secure-help-center.com/', expect: 'danger', note: 'видає себе за PayPal + http + пароль на чужий сервер',
        page: { hasPasswordField: true, brandMentions: ['paypal'], passwordFormHost: 'collect.example.ru' },
    },

    // Вік домену
    { url: 'https://super-deals-shop.com/', expect: 'warning', note: 'домену 5 днів', domainAgeDays: 5 },
    { url: 'https://super-deals-shop.com/', expect: 'safe', note: 'домену 1000 днів', domainAgeDays: 1000 },

    // Довірені сайти
    { url: 'https://evil-google.com/login', expect: 'safe', note: 'користувач позначив довіреним', trusted: ['evil-google.com'] },
    { url: 'https://0-105.com/', expect: 'danger', note: 'чорний список сильніший за «довіряю»', trusted: ['0-105.com'] },
    // Чорний список користувача
    { url: 'https://www.google.com/', expect: 'danger', note: 'ваш чорний список сильніший за офіційний бренд', userBlocked: ['google.com'] },
    { url: 'https://news.spam-site.com/a', expect: 'danger', note: 'запис у чорному списку діє на піддомени', userBlocked: ['spam-site.com'] },
    { url: 'https://myspam-site.com/', expect: 'safe', note: 'але не на схожі сайти', userBlocked: ['spam-site.com'] },
    { url: 'https://sub.evil-google.com/login', expect: 'safe', note: 'білий список діє на піддомени', trusted: ['evil-google.com'] },
];

const NEUTRAL_PARAGRAPH =
    'Кабінет міністрів на засіданні в середу ухвалив зміни до державного бюджету. ' +
    'Згідно з документом, видатки на освіту зростуть на чотири відсотки порівняно з минулим роком. ' +
    'Міністерство фінансів пояснило, що додаткові кошти спрямують на ремонт шкіл і підвищення зарплат вчителям. ' +
    'Повний текст постанови опубліковано на урядовому порталі. ';

const FAKE_PARAGRAPH =
    'Джерела повідомляють, що влада приховує жахливу правду. Це справжня катастрофа і ганьба! ' +
    'Інсайдер розповів, що скоро почнеться паніка, а лікарі мовчать про цей кошмар. ' +
    'Скандал, який усі замовчують, — це жах для кожної родини. Поширте, поки не видалили! ';

const NEWS_CASES = [
    {
        name: 'Нейтральна новина з автором, датою і джерелами', expect: 'safe',
        article: { headline: 'Уряд ухвалив зміни до бюджету на 2027 рік', text: NEUTRAL_PARAGRAPH.repeat(6),
            hasAuthor: true, hasDate: true, externalLinks: 3 },
    },
    {
        name: '«Шоколадний» заголовок не є клікбейтом', expect: 'safe',
        article: { headline: 'Як приготувати шоколадний торт удома', text: NEUTRAL_PARAGRAPH.repeat(6),
            hasAuthor: true, hasDate: true, externalLinks: 1 },
    },
    {
        name: 'Типовий фейк: капслок, «шок», анонімні джерела, заклик поширити', expect: 'danger',
        article: { headline: 'ШОК!!! ЛІКАРІ МОВЧАТЬ ПРО ЦЕ', text: FAKE_PARAGRAPH.repeat(6),
            hasAuthor: false, hasDate: false, externalLinks: 0 },
    },
    {
        name: 'Нейтральний текст, але без автора, дати й посилань', expect: 'safe',
        article: { headline: 'Уряд ухвалив зміни до бюджету', text: NEUTRAL_PARAGRAPH.repeat(6),
            hasAuthor: false, hasDate: false, externalLinks: 0 },
    },
    {
        name: 'Клікбейт-заголовок на нормальному тексті', expect: 'warning',
        article: { headline: 'Ви не повірите, що вирішив уряд?!', text: NEUTRAL_PARAGRAPH.repeat(6),
            hasAuthor: false, hasDate: true, externalLinks: 1 },
    },
    {
        name: 'Лише клікбейт-заголовок (виділена фраза)', expect: 'warning',
        article: { headline: 'ШОК!!! Ви не повірите, що приховують лікарі', text: '' },
    },
    {
        name: 'Лише нейтральний заголовок (виділена фраза)', expect: 'safe',
        article: { headline: 'Верховна Рада ухвалила бюджет на 2027 рік', text: '' },
    },
    {
        name: 'Замало тексту', expect: 'unknown',
        article: { headline: '', text: 'Меню Новини Спорт Погода Контакти', hasAuthor: false, hasDate: false },
    },
];

// Перевірка джерела (білий список ІМІ, підробки під ЗМІ, вік домену)
const SOURCE_CASES = [
    { url: 'https://suspilne.media/news/123', expect: 'good', note: 'білий список ІМІ' },
    { url: 'https://www.pravda.com.ua/news/2026/10/26/1/', expect: 'good', note: 'білий список ІМІ' },
    { url: 'https://www.stopfake.org/uk/fake/', expect: 'good', note: 'фактчекер' },
    { url: 'https://mof.gov.ua/uk/news', expect: 'good', note: 'державний сайт' },
    { url: 'https://www.reuters.com/world/', expect: 'good', note: 'міжнародна агенція' },
    { url: 'https://random-blog.com/post', expect: 'neutral', note: 'невідомий сайт' },
    { url: 'https://suspilne-news.top/war', expect: 'bad', note: 'назва Суспільного на чужому домені' },
    { url: 'https://ukrinforn.ua/news', expect: 'bad', note: 'ukrinforn ≈ ukrinform' },
    { url: 'https://fresh-news-site.com/a', expect: 'bad', note: 'домену 5 днів', domainAgeDays: 5 },
    { url: 'https://old-news-site.com/a', expect: 'neutral', note: 'домену 4 роки', domainAgeDays: 1500 },
];

// ---------- ЗАПУСК ----------

// Що користувач може ввести у поле «Мої списки» → що збережеться
const LIST_CASES = [
    { input: 'example.com', expect: 'example.com' },
    { input: 'https://www.Example.com/login?x=1', expect: 'example.com', note: 'повне посилання → лише назва сайту' },
    { input: '  mail.google.com  ', expect: 'mail.google.com', note: 'пробіли прибираються' },
    { input: '*.spam-site.com', expect: 'spam-site.com', note: 'зірочка не потрібна' },
    { input: 'http://192.168.1.1/admin', expect: '192.168.1.1', note: 'IP-адреса' },
    { input: 'просто текст', expect: null, note: 'не адреса' },
    { input: 'localhost', expect: null, note: 'без крапки' },
    { input: '', expect: null },
];

function el(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
}

// Назви рівнів українською — лише для показу в таблиці
const LEVEL_UK = { safe: 'безпечно', warning: 'підозріло', danger: 'небезпечно', unknown: 'невідомо',
    good: 'надійне', bad: 'підозріле', neutral: 'невідоме', null: 'не адреса' };
const uk = (text) => String(text).replace(/^(safe|warning|danger|unknown|good|bad|neutral|null)\b/, (m) => LEVEL_UK[m]);

function addRow(tbody, ok, input, note, expect, resultText, reasons) {
    expect = uk(expect);
    resultText = uk(resultText);
    const tr = el('tr', undefined, ok ? 'pass' : 'fail');
    tr.appendChild(el('td', ok ? '✔' : '✘', 'status'));
    const tdInput = el('td');
    tdInput.appendChild(el('code', input));
    if (note) tdInput.appendChild(el('div', note, 'note'));
    tr.appendChild(tdInput);
    tr.appendChild(el('td', expect));
    tr.appendChild(el('td', resultText));
    tr.appendChild(el('td', reasons, 'reasons'));
    tbody.appendChild(tr);
}

const reasonsText = (list) => (list || []).map(r => (r.points ? `+${r.points} ` : '') + r.text).join('\n');

async function runTests() {
    let passed = 0, total = 0;
    const count = (ok) => { passed += ok; total++; };

    const urlBody = document.querySelector('#urlTests tbody');
    for (const c of URL_CASES) {
        const result = PhishAnalyzer.analyzeUrl(c.url, {
            isBlocked: d => TEST_BLOCKLIST.has(d),
            isUserBlocked: host => !!FactGuardLists.findMatch(host, c.userBlocked || []),
            isTrusted: (domain, host) => !!FactGuardLists.findMatch(host || domain, c.trusted || []),
            page: c.page,
            domainAgeDays: c.domainAgeDays,
        });
        const ok = result.level === c.expect;
        count(ok);
        addRow(urlBody, ok, c.url, c.note, c.expect, `${result.level} (${result.score === null ? '—' : result.score})`, reasonsText(result.reasons));
    }

    const directory = await (await fetch('../data/trusted-media.json')).json();
    const sourceBody = document.querySelector('#sourceTests tbody');
    for (const c of SOURCE_CASES) {
        const site = PhishAnalyzer.analyzeUrl(c.url, { isBlocked: () => false, domainAgeDays: c.domainAgeDays });
        const result = SourceCheck.checkSource(c.url, directory, { site, domainAgeDays: c.domainAgeDays });
        const ok = result.tone === c.expect;
        count(ok);
        addRow(sourceBody, ok, c.url, c.note, c.expect, `${result.tone} · ${result.title}`, result.notes.map(n => n.text).join('\n'));
    }

    const newsBody = document.querySelector('#newsTests tbody');
    for (const c of NEWS_CASES) {
        const result = NewsAnalyzer.analyzeNews(c.article);
        const ok = result.level === c.expect;
        count(ok);
        addRow(newsBody, ok, c.article.headline || '(без заголовка)', c.name, c.expect,
            `${result.level} (${result.score === null ? '—' : result.score})`, reasonsText(result.reasons));
    }

    const listBody = document.querySelector('#listTests tbody');
    for (const c of LIST_CASES) {
        const result = FactGuardLists.normalizeEntry(c.input);
        const ok = result === c.expect;
        count(ok);
        addRow(listBody, ok, String(c.input), c.note, String(c.expect), String(result), '');
    }

    const summary = document.getElementById('summary');
    summary.textContent = `Пройдено ${passed} з ${total} тестів`;
    summary.className = passed === total ? 'summary pass' : 'summary fail';
    window.testResults = { passed, total };
}

runTests().catch(e => {
    document.getElementById('summary').textContent = 'Помилка запуску тестів: ' + e.message;
    window.testResults = { error: e.message };
});
