// Перевірка ДЖЕРЕЛА новини: чи входить сайт до білого списку ІМІ, чи це фактчекер,
// державний сайт, або підробка під відоме видання (suspilne-news.top, bbc-ukraine.xyz).
// Чиста логіка без chrome.* API: довідник передається параметром (data/trusted-media.json).
(function (root) {
    'use strict';

    const CATEGORY_TEXT = {
        imi: 'Входить до білого списку ІМІ (найякісніші онлайн-медіа України)',
        international: 'Відома міжнародна інформаційна агенція / мовник',
        factchecker: 'Організація з перевірки фактів',
        official: 'Офіційний державний сайт (.gov.ua)',
    };

    function isSameOrSubdomain(hostname, domain) {
        return hostname === domain || hostname.endsWith('.' + domain);
    }

    // Розкладаємо довідник у плаский список: [{name, domains, brand, category}]
    function flatten(directory) {
        const list = [];
        for (const [key, category] of [['imi', 'imi'], ['international', 'international'], ['factcheckers', 'factchecker']]) {
            for (const entry of (directory && directory[key]) || []) list.push(Object.assign({ category }, entry));
        }
        return list;
    }

    function findEntry(hostname, directory) {
        return flatten(directory).find(e => e.domains.some(d => isSameOrSubdomain(hostname, d))) || null;
    }

    // Чи схожа адреса на підробку під відоме видання
    function findLookalike(hostname, directory) {
        const levenshtein = root.PhishAnalyzer ? root.PhishAnalyzer.levenshtein : null;
        const words = hostname.split(/[.-]/).filter(Boolean);
        for (const entry of flatten(directory)) {
            if (!entry.brand) continue;
            if (entry.domains.some(d => isSameOrSubdomain(hostname, d))) continue;
            for (const word of words) {
                if (word === entry.brand) return { name: entry.name, brand: entry.brand, kind: 'brand' };
                if (levenshtein && entry.brand.length >= 6 && Math.abs(word.length - entry.brand.length) <= 1
                    && levenshtein(word, entry.brand) === 1) {
                    return { name: entry.name, brand: entry.brand, kind: 'typo', word };
                }
            }
        }
        return null;
    }

    /**
     * @param {string} url
     * @param {object} directory — вміст data/trusted-media.json
     * @param {object} extra — { site: результат PhishAnalyzer.analyzeUrl, domainAgeDays }
     * @returns {{tone:'good'|'bad'|'neutral', title:string, hostname:string, notes:{tone:string,text:string}[]}}
     */
    function checkSource(url, directory, extra) {
        extra = extra || {};
        let hostname;
        try {
            hostname = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
        } catch (e) {
            return { tone: 'neutral', title: 'Невідоме джерело', hostname: '', notes: [] };
        }

        const notes = [];
        const site = extra.site;
        const entry = findEntry(hostname, directory);
        const lookalike = entry ? null : findLookalike(hostname, directory);

        if (site && site.userBlocked) {
            notes.push({ tone: 'bad', text: 'Сайт є у вашому чорному списку.' });
        }
        if (site && site.blocked) {
            notes.push({ tone: 'bad', text: 'Сайт є в базі фішингових сайтів PhishDestroy.' });
        }
        if (site && site.trusted) {
            notes.push({ tone: 'good', text: 'Сайт є у вашому білому списку.' });
        }
        if (entry) {
            notes.push({ tone: 'good', text: CATEGORY_TEXT[entry.category] + '.' });
        } else if (/\.gov\.ua$/.test(hostname)) {
            notes.push({ tone: 'good', text: CATEGORY_TEXT.official + '.' });
        }
        if (lookalike) {
            notes.push({
                tone: 'bad',
                text: lookalike.kind === 'brand'
                    ? `Адреса містить назву «${lookalike.brand}», але це не сайт видання «${lookalike.name}». Можлива підробка.`
                    : `«${lookalike.word}» схоже на «${lookalike.brand}» з помилкою. Можлива підробка під «${lookalike.name}».`,
            });
        }
        if (typeof extra.domainAgeDays === 'number') {
            if (extra.domainAgeDays < 30) notes.push({ tone: 'bad', text: `Домен зареєстровано лише ${extra.domainAgeDays} дн. тому.` });
            else if (extra.domainAgeDays < 365) notes.push({ tone: 'neutral', text: `Домен молодий: ${extra.domainAgeDays} дн.` });
            else notes.push({ tone: 'good', text: `Домен існує ${Math.floor(extra.domainAgeDays / 365)} р.` });
        }
        // Інші ознаки фішингу (підозріла зона, IP-адреса тощо) — з аналізатора PhishGuard
        if (site && !site.blocked && !site.userBlocked && site.score > 0) {
            site.reasons.filter(r => r.points >= 20 && !/вік|зареєстровано|молодий/i.test(r.text))
                .slice(0, 2).forEach(r => notes.push({ tone: 'bad', text: r.text }));
        }

        let tone = 'neutral';
        let title = entry ? entry.name : hostname;
        if (notes.some(n => n.tone === 'bad') || (site && site.level === 'danger')) tone = 'bad';
        else if (entry || /\.gov\.ua$/.test(hostname) || (site && site.trusted)) tone = 'good';

        if (tone === 'neutral' && notes.length === 0) {
            notes.push({ tone: 'neutral', text: 'Сайту немає в довіднику перевірених джерел. Це не означає, що він поганий, — просто будьте уважні.' });
        }

        return { tone, title, hostname, category: entry ? entry.category : null, notes };
    }

    root.SourceCheck = { checkSource, findEntry, findLookalike, flatten };
})(typeof self !== 'undefined' ? self : this);
