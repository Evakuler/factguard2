// Модуль аналізу новини на ознаки маніпулятивної подачі (типові прийоми фейкових новин).
// ВАЖЛИВО: програма не може перевірити, чи правдиві факти. Вона лише шукає прийоми,
// якими часто користуються автори фейків: кричущий заголовок, емоції замість фактів,
// анонімні «джерела», заклики «поширити, поки не видалили», відсутність автора і дати.
(function (root) {
    'use strict';

    // Клікбейт-фрази (українська, російська, англійська). Шукаємо початок слова,
    // тому «шокуюч» знайде і «шокуючі», і «шокуюча»
    // «=» на початку означає «тільки ціле слово»: «=шок» не знайде «шоколад»
    const CLICKBAIT = [
        '=шок', 'шокуюч', 'сенсаці', 'ви не повірите', 'терміново', 'увага всім', 'вся правда',
        'приховують', 'замовчують', 'лікарі мовчать', 'про це мовчать', 'таємниц', 'викрито', 'жахлива правда',
        'шокирующ', 'сенсаци', 'вы не поверите', 'срочно', 'вся правда', 'скрывают', 'врачи молчат', 'об этом молчат',
        'shocking', 'you won\'t believe', 'they don\'t want you to know', '=breaking', '=exposed', '=secret',
    ];

    // Заклики поширювати — класична ознака вірусних фейків
    const SHARE_CALLS = [
        'поширте', 'поширюйте', 'розішліть', 'перешліть', 'поки не видалили',
        'поделитесь', 'распространите', 'перешлите', 'пока не удалили',
        'share before', 'share this before', 'before it gets deleted', 'before they delete',
    ];

    // Посилання на анонімні «джерела» замість конкретних людей та документів
    const ANONYMOUS_SOURCES = [
        'джерела повідомляють', 'за даними джерел', 'наші джерела', 'джерело в', 'інсайдер', 'за чутками',
        'кажуть, що', 'анонімн', 'не названий', 'источники сообщают', 'по данным источников', 'наши источники',
        'инсайдер', 'по слухам', 'говорят, что', 'анонимн', 'sources say', 'insiders', 'rumors',
    ];

    // Емоційно забарвлені слова. Багато таких слів на тисячу — ознака тиску на емоції
    const EMOTIONAL = [
        'жах', 'жахлив', 'катастроф', 'паніка', 'панік', 'зрада', 'ганьба', 'скандал', 'кошмар', 'трагеді',
        'обурлив', 'нечуван', 'страшн', 'ужас', 'катастроф', 'паника', 'предательств', 'позор', 'возмутительн',
        'неслыхан', 'страшн', 'horror', 'outrage', 'disaster', 'scandal', 'terrifying', 'shameful',
    ];

    function countMatches(text, phrases) {
        const found = [];
        for (const phrase of phrases) {
            const wholeWord = phrase.startsWith('=');
            const body = (wholeWord ? phrase.slice(1) : phrase).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const re = new RegExp(`(?<![\\p{L}])${body}${wholeWord ? '(?![\\p{L}])' : ''}`, 'iu');
            if (re.test(text) && !found.includes(phrase)) found.push(phrase.replace(/^=/, ''));
        }
        return found;
    }

    function countAllOccurrences(text, stems) {
        let n = 0;
        for (const stem of new Set(stems)) {
            const re = new RegExp(`(?<![\\p{L}])${stem}`, 'giu');
            n += (text.match(re) || []).length;
        }
        return n;
    }

    function levelFromScore(score) {
        if (score === null) return 'unknown';
        if (score < 30) return 'safe';
        if (score < 60) return 'warning';
        return 'danger';
    }

    /**
     * @param {object} article — дані зі сторінки (збирає content.js):
     *   { headline, text, hasAuthor, hasDate, externalLinks, url }
     */
    function analyzeNews(article) {
        const headline = (article.headline || '').trim();
        const text = (article.text || '').trim();
        const reasons = [];
        const add = (points, txt) => reasons.push({ points, text: txt });

        const words = text.split(/\s+/).filter(Boolean).length;
        // Повний аналіз — лише для справжньої статті. Для короткого фрагмента (наприклад, виділеної фрази)
        // перевіряємо тільки заголовок/твердження.
        const full = words >= 80;
        if (!full && !headline) {
            return {
                score: null, level: 'unknown', words, partial: true,
                reasons: [{ points: 0, text: 'На сторінці замало тексту — схоже, це не стаття.' }],
            };
        }

        // 1. Заголовок ВЕЛИКИМИ ЛІТЕРАМИ
        const letters = headline.match(/\p{L}/gu) || [];
        const upper = headline.match(/\p{Lu}/gu) || [];
        if (letters.length >= 10 && upper.length / letters.length > 0.5) {
            add(20, 'Заголовок написано ВЕЛИКИМИ ЛІТЕРАМИ.');
        }

        // 2. Багато знаків оклику / «?!»
        if (/!{2,}|\?!|!\?/.test(headline) || (headline.match(/!/g) || []).length >= 2) {
            add(15, 'У заголовку кілька знаків оклику або «?!».');
        }

        // 3. Клікбейт у заголовку та на початку тексту
        const clickbait = countMatches(headline + ' ' + (full ? text.slice(0, 600) : ''), CLICKBAIT);
        if (clickbait.length > 0) {
            add(Math.min(15 * clickbait.length, 30), `Клікбейт-фрази: «${clickbait.slice(0, 3).join('», «')}».`);
        }

        if (!full) {
            const score = Math.min(reasons.reduce((s, r) => s + r.points, 0), 100);
            reasons.sort((a, b) => b.points - a.points);
            reasons.push({ points: 0, text: score === 0
                ? 'У заголовку типових ознак маніпуляції не виявлено (текст статті не аналізувався — його замало).'
                : 'Аналізувався лише заголовок: тексту статті замало.' });
            return { score, level: levelFromScore(score), reasons, words, partial: true };
        }

        // 4. Заклики поширювати
        const share = countMatches(text, SHARE_CALLS);
        if (share.length > 0) {
            add(25, `Заклик поширити матеріал («${share[0]}») — типова ознака вірусного фейку.`);
        }

        // 5. Анонімні джерела
        const anon = countMatches(text, ANONYMOUS_SOURCES);
        if (anon.length > 0) {
            add(Math.min(10 * anon.length, 20), `Посилання на анонімні джерела: «${anon.slice(0, 2).join('», «')}».`);
        }

        // 6. Щільність емоційних слів
        const emotional = countAllOccurrences(text, EMOTIONAL);
        const perThousand = (emotional / words) * 1000;
        if (emotional >= 3 && perThousand > 4) {
            add(15, `Багато емоційних слів (${emotional} на ${words} слів) — тиск на емоції замість фактів.`);
        }

        // 7. Немає автора / дати
        if (!article.hasAuthor) add(10, 'Не вказано автора матеріалу.');
        if (!article.hasDate) add(5, 'Не вказано дату публікації.');

        // 8. Довгий текст без жодного посилання на джерела
        if (words > 250 && (article.externalLinks || 0) === 0) {
            add(10, 'У тексті немає жодного посилання на зовнішні джерела.');
        }

        const score = Math.min(reasons.reduce((s, r) => s + r.points, 0), 100);
        if (reasons.length === 0) reasons.push({ points: 0, text: 'Типових ознак маніпуляції не виявлено.' });
        reasons.sort((a, b) => b.points - a.points);

        return { score, level: levelFromScore(score), reasons, words };
    }

    // Посилання на пошук перевірок фактів за заголовком (Google Fact Check Explorer)
    function factCheckUrl(headline) {
        const q = (headline || '').replace(/\s+/g, ' ').trim().slice(0, 120);
        return 'https://toolbox.google.com/factcheck/explorer/search/' + encodeURIComponent(q) + ';hl=uk';
    }

    root.NewsAnalyzer = { analyzeNews, factCheckUrl, levelFromScore };

    // Інтерфейс, який використовує content.js учениці: analyze({title, text, ...})
    root.FactGuardAnalyzer = {
        analyze(article) {
            return analyzeNews({
                headline: article.title,
                text: article.text,
                hasAuthor: article.hasAuthor,
                hasDate: article.hasDate,
                externalLinks: article.externalLinks,
            });
        },
    };
})(typeof self !== 'undefined' ? self : this);
