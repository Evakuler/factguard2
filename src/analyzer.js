// Модуль аналізу посилань на ознаки фішингу.
// Він не використовує chrome.* API, тому працює і у фоновому скрипті розширення,
// і в content-скрипті, і на тестовій сторінці tests.html.
(function (root) {
    'use strict';

    // Доменні зони, які шахраї часто купують через дешевизну або безкоштовність
    const SUSPICIOUS_TLDS = ['.xyz', '.tk', '.ml', '.ga', '.cf', '.gq', '.top', '.club', '.online', '.site',
        '.click', '.cc', '.icu', '.buzz', '.rest', '.workers.dev', '.pages.dev'];

    // Бренд → його справжні (офіційні) домени та слова, якими бренд називають на сторінці
    const BRANDS = {
        google: {
            domains: ['google.com', 'google.com.ua', 'google.ru', 'youtube.com', 'gmail.com', 'googleapis.com',
                'googleusercontent.com', 'gstatic.com', 'blogger.com'],
            pageNames: ['google', 'gmail'],
        },
        facebook: { domains: ['facebook.com', 'fb.com', 'messenger.com'], pageNames: ['facebook'] },
        instagram: { domains: ['instagram.com'], pageNames: ['instagram'] },
        apple: { domains: ['apple.com', 'icloud.com'], pageNames: ['apple id', 'icloud'] },
        microsoft: {
            domains: ['microsoft.com', 'live.com', 'office.com', 'outlook.com', 'microsoftonline.com', 'bing.com'],
            pageNames: ['microsoft', 'outlook', 'office 365'],
        },
        amazon: { domains: ['amazon.com', 'amazon.de', 'amazon.co.uk', 'amazon.pl', 'amazonaws.com'], pageNames: ['amazon'] },
        paypal: { domains: ['paypal.com', 'paypal.me'], pageNames: ['paypal'] },
        netflix: { domains: ['netflix.com'], pageNames: ['netflix'] },
        steam: { domains: ['steampowered.com', 'steamcommunity.com'], pageNames: ['steam'] },
        privat24: { domains: ['privat24.ua', 'privatbank.ua'], pageNames: ['privat24', 'приват24', 'приватбанк', 'privatbank'] },
        monobank: { domains: ['monobank.ua', 'monobank.com.ua'], pageNames: ['monobank', 'монобанк'] },
        diia: { domains: ['diia.gov.ua'], pageNames: ['дія', 'diia'] },
        novaposhta: { domains: ['novaposhta.ua', 'nova.post'], pageNames: ['нова пошта', 'nova poshta'] },
        olx: { domains: ['olx.ua', 'olx.pl', 'olx.com'], pageNames: ['olx'] },
        // Відомі ЗМІ — щоб ловити підробки на кшталт suspilne-news.top
        suspilne: { domains: ['suspilne.media'], pageNames: [] },
        ukrinform: { domains: ['ukrinform.ua', 'ukrinform.net'], pageNames: [] },
        hromadske: { domains: ['hromadske.ua'], pageNames: [] },
        reuters: { domains: ['reuters.com'], pageNames: [] },
        bbc: { domains: ['bbc.com', 'bbc.co.uk'], pageNames: [] },
    };

    // Складені доменні зони: для них «реєстрований» домен складається з трьох частин (bank.com.ua),
    // а для хостингів — кожен піддомен належить окремій людині (evil.github.io)
    const MULTI_PART_SUFFIXES = ['co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.ua', 'org.ua', 'net.ua', 'in.ua',
        'kiev.ua', 'kyiv.ua', 'gov.ua', 'edu.ua', 'com.au', 'co.jp', 'com.br', 'com.pl', 'com.tr',
        'github.io', 'workers.dev', 'pages.dev', 'vercel.app', 'netlify.app', 'web.app', 'firebaseapp.com',
        'blogspot.com', 'herokuapp.com', 'glitch.me', 'weebly.com', 'wixsite.com'];

    // Слова у шляху посилання, які часто бувають на фішингових сторінках.
    // Межі слова (\b) потрібні, щоб "author" не спрацьовувало на "auth", а "information" — на "form"
    const KEYWORDS_RE = /\b(login|log-in|signin|sign-in|secure|update|verify|verification|account|banking|auth|password|wallet|confirm)\b/i;

    // Символи, якими шахраї підміняють схожі букви: paypa1 → paypal, g00gle → google
    const HOMOGLYPHS = { '0': 'o', '1': 'l', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '9': 'g', '@': 'a', '$': 's' };

    function isIpAddress(hostname) {
        return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.startsWith('[');
    }

    // Повертає «реєстрований» домен: login.secure.paypal.com → paypal.com, a.bank.com.ua → bank.com.ua
    function getRegistrableDomain(hostname) {
        if (isIpAddress(hostname)) return hostname;
        const parts = hostname.split('.');
        for (const suffix of MULTI_PART_SUFFIXES) {
            if (hostname.endsWith('.' + suffix)) {
                const n = suffix.split('.').length + 1;
                return parts.slice(-n).join('.');
            }
        }
        return parts.slice(-2).join('.');
    }

    // Чи належить hostname до домену: сам домен або його піддомен (mail.google.com → google.com)
    function isSameOrSubdomain(hostname, domain) {
        return hostname === domain || hostname.endsWith('.' + domain);
    }

    // Чи є hostname офіційним доменом якогось бренду
    function getOfficialBrand(hostname) {
        for (const [brand, info] of Object.entries(BRANDS)) {
            if (info.domains.some(d => isSameOrSubdomain(hostname, d))) return brand;
        }
        return null;
    }

    // Відстань Левенштейна: скільки букв треба змінити/додати/видалити, щоб з одного слова отримати інше
    function levenshtein(a, b) {
        const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
        for (let j = 1; j <= b.length; j++) dp[0][j] = j;
        for (let i = 1; i <= a.length; i++) {
            for (let j = 1; j <= b.length; j++) {
                dp[i][j] = Math.min(
                    dp[i - 1][j] + 1,
                    dp[i][j - 1] + 1,
                    dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
                );
            }
        }
        return dp[a.length][b.length];
    }

    function normalizeHomoglyphs(s) {
        return s.split('').map(c => HOMOGLYPHS[c] || c).join('').replace(/rn/g, 'm').replace(/vv/g, 'w');
    }

    // Шукаємо в назві домену бренд, написаний з помилкою або підміненими символами
    function findTyposquat(label) {
        const words = label.split('-').filter(Boolean);
        for (const brand of Object.keys(BRANDS)) {
            if (brand.length < 5) continue; // короткі назви (olx, diia) дають забагато випадкових збігів
            for (const word of words) {
                if (word === brand) continue; // точний збіг перевіряється окремо
                if (normalizeHomoglyphs(word) === brand) return { brand, kind: 'homoglyph', word };
                // «Одна літера різниці» перевіряємо лише для довгих назв: інакше stream ≈ steam, apply ≈ apple
                if (brand.length >= 6 && Math.abs(word.length - brand.length) <= 1 && levenshtein(word, brand) === 1) {
                    return { brand, kind: 'typo', word };
                }
            }
        }
        return null;
    }

    function escapeRegExp(s) {
        return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    // Які бренди згадані в тексті (заголовок сторінки, h1). Використовує content.js
    function findBrandMentions(text) {
        const lower = (text || '').toLowerCase();
        const found = [];
        for (const [brand, info] of Object.entries(BRANDS)) {
            const hit = info.pageNames.some(name =>
                new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(name)}(?![\\p{L}\\p{N}])`, 'u').test(lower));
            if (hit) found.push(brand);
        }
        return found;
    }

    function levelFromScore(score) {
        if (score === null || score === undefined) return 'unknown';
        if (score < 30) return 'safe';
        if (score < 70) return 'warning';
        return 'danger';
    }

    // Приводимо введений текст до повної адреси: "example.com" → "https://example.com"
    function normalizeInputUrl(url) {
        url = (url || '').trim();
        if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = 'https://' + url;
        return url;
    }

    /**
     * Головна функція аналізу.
     * @param {string} url — адреса для перевірки
     * @param {object} ctx — додаткові дані:
     *   isBlocked(hostname) → true, якщо домен є в базі фішингу PhishDestroy
     *   isUserBlocked(hostname) → true, якщо користувач додав сайт до свого чорного списку
     *   isTrusted(registrableDomain, hostname) → true, якщо сайт є в білому списку користувача
     *   page — сигнали зі сторінки (від content.js): { hasPasswordField, isHttpPassword, brandMentions, passwordFormHost }
     *   domainAgeDays — вік домену в днях (якщо відомий)
     * @returns {{score:number|null, level:string, reasons:{text:string, points:number}[], hostname?:string, domain?:string}}
     */
    function analyzeUrl(url, ctx) {
        ctx = ctx || {};
        let urlObj;
        try {
            urlObj = new URL(normalizeInputUrl(url));
        } catch (e) {
            return { score: null, level: 'unknown', reasons: [{ text: 'Некоректний формат посилання.', points: 0 }] };
        }

        if (urlObj.protocol !== 'http:' && urlObj.protocol !== 'https:') {
            return { score: null, level: 'unknown', reasons: [{ text: 'Це службова сторінка браузера — перевірка не потрібна.', points: 0 }] };
        }

        const hostname = urlObj.hostname.toLowerCase().replace(/\.$/, '');
        // Справжня назва сайту складається лише з латинських літер, цифр, крапок і дефісів і має хоча б одну крапку
        if (!isIpAddress(hostname) && hostname !== 'localhost'
            && (!/^[a-z0-9.-]+$/.test(hostname) || !hostname.includes('.'))) {
            return { score: null, level: 'unknown', reasons: [{ text: 'Некоректна адреса сайту.', points: 0 }] };
        }
        const cleanHostname = hostname.replace(/^www\./, '');
        const domain = getRegistrableDomain(hostname);
        const base = { hostname, domain, url: urlObj.href };

        // 0. ЧОРНИЙ СПИСОК КОРИСТУВАЧА — рішення людини найважливіше
        if (ctx.isUserBlocked && ctx.isUserBlocked(hostname)) {
            return Object.assign(base, {
                score: 100, level: 'danger', userBlocked: true,
                reasons: [{ text: 'Ви додали цей сайт до свого чорного списку.', points: 100 }],
            });
        }

        // 1. БАЗА ФІШИНГУ — перевіряємо домен і всі батьківські домени (a.b.evil.com → b.evil.com → evil.com)
        if (ctx.isBlocked) {
            const parts = hostname.split('.');
            for (let i = 0; i < parts.length - 1; i++) {
                if (ctx.isBlocked(parts.slice(i).join('.'))) {
                    return Object.assign(base, {
                        score: 100, level: 'danger', blocked: true,
                        reasons: [{ text: 'Сайт є в чорному списку PhishDestroy (підтверджений фішинг).', points: 100 }],
                    });
                }
            }
        }

        // 2. БІЛИЙ СПИСОК КОРИСТУВАЧА — користувач сам позначив, що сайту довіряє
        if (ctx.isTrusted && ctx.isTrusted(domain, hostname)) {
            return Object.assign(base, {
                score: 0, level: 'safe', trusted: true,
                reasons: [{ text: 'Сайт є у вашому білому списку (ви йому довіряєте).', points: 0 }],
            });
        }

        const reasons = [];
        const add = (points, text) => reasons.push({ points, text });
        const officialBrand = getOfficialBrand(hostname);
        const ip = isIpAddress(hostname);

        // 3. ОЗНАКИ В САМІЙ АДРЕСІ
        if (ip) add(50, 'Замість назви сайту використано IP-адресу.');

        if (hostname.includes('xn--')) add(60, 'Назва сайту містить символи інших алфавітів (Punycode / homograph-атака).');

        if (SUSPICIOUS_TLDS.some(tld => hostname.endsWith(tld))) add(30, 'Підозріла або безкоштовна доменна зона.');

        if (!ip && cleanHostname.split('.').length > 4) add(20, 'Занадто багато піддоменів (спроба сховати справжню адресу).');

        // https://paypal.com@evil.top — усе до «@» браузер вважає логіном, а відкриває evil.top
        if (urlObj.username || urlObj.password) {
            add(40, 'Посилання містить символ «@» — браузер відкриє зовсім інший сайт, ніж здається.');
        }

        if (!officialBrand) {
            const domainLabel = domain.split('.')[0];
            const mentioned = new Set();
            for (const brand of Object.keys(BRANDS)) {
                // Бренд окремим словом у будь-якій частині адреси: paypal-secure.xyz, paypal.com.evil.top
                const tokenRe = new RegExp(`(^|[.-])${brand}([.\\d-]|$)`);
                if (tokenRe.test(hostname)) {
                    add(35, `Назва бренду «${brand}» на чужому домені.`);
                    mentioned.add(brand);
                } else if (brand.length >= 6 && domainLabel.includes(brand)) {
                    // Бренд «злитий» з іншими словами: mypaypalaccount.com
                    add(25, `Назва бренду «${brand}» всередині назви чужого домену.`);
                    mentioned.add(brand);
                }
            }

            const typo = findTyposquat(domainLabel);
            if (typo && !mentioned.has(typo.brand)) {
                add(40, typo.kind === 'homoglyph'
                    ? `«${typo.word}» схоже на «${typo.brand}» з підміненими символами (тайпсквотинг).`
                    : `«${typo.word}» відрізняється від «${typo.brand}» лише однією літерою (тайпсквотинг).`);
            }
        }

        // На офіційних сайтах сторінка входу — це нормально, тому ключові слова там не рахуємо
        if (!officialBrand && (KEYWORDS_RE.test(urlObj.pathname) || KEYWORDS_RE.test(urlObj.search))) {
            add(15, 'Посилання містить слова на кшталт login, verify, account.');
        }

        // 4. ОЗНАКИ НА САМІЙ СТОРІНЦІ (надсилає content.js)
        const page = ctx.page;
        if (page && page.hasPasswordField) {
            if (urlObj.protocol === 'http:') {
                add(25, 'Сторінка просить пароль через незахищене з\'єднання (http).');
            }
            const fakeBrands = (page.brandMentions || []).filter(b => b !== officialBrand);
            if (fakeBrands.length > 0) {
                add(40, `Сторінка просить пароль і видає себе за «${fakeBrands[0]}», але це не офіційний сайт.`);
            }
            if (page.passwordFormHost && getRegistrableDomain(page.passwordFormHost) !== domain) {
                add(20, `Пароль буде відправлено на інший сайт: ${page.passwordFormHost}.`);
            }
        }

        // 5. ВІК ДОМЕНУ — фішингові домени зазвичай зовсім нові
        if (typeof ctx.domainAgeDays === 'number' && ctx.domainAgeDays >= 0) {
            if (ctx.domainAgeDays < 30) add(30, `Домен зареєстровано лише ${ctx.domainAgeDays} дн. тому.`);
            else if (ctx.domainAgeDays < 180) add(10, `Домен молодий: зареєстрований ${ctx.domainAgeDays} дн. тому.`);
        }

        const score = Math.min(reasons.reduce((s, r) => s + r.points, 0), 100);
        if (reasons.length === 0) reasons.push({ text: 'Підозрілих ознак не виявлено.', points: 0 });
        reasons.sort((a, b) => b.points - a.points); // найвагоміші причини — першими

        return Object.assign(base, { score, level: levelFromScore(score), reasons, officialBrand });
    }

    root.PhishAnalyzer = {
        analyzeUrl,
        getRegistrableDomain,
        getOfficialBrand,
        findBrandMentions,
        findTyposquat,
        levenshtein,
        levelFromScore,
        normalizeInputUrl,
        isIpAddress,
        BRANDS,
    };
})(typeof self !== 'undefined' ? self : this);
