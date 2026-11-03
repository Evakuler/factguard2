// Білий і чорний списки сайтів користувача (розділ «Сайт» → «Мої списки»).
// Чиста логіка без chrome.* API — її використовують background.js, popup.js і тести.
//   • Білий список — сайти, яким ви довіряєте: попередження про фішинг на них не показуються.
//   • Чорний список — сайти, які ви вважаєте небезпечними: на них завжди з'являється червоний банер.
// Запис "example.com" діє і на всі піддомени (mail.example.com), але не на інші сайти (myexample.com).
(function (root) {
    'use strict';

    /**
     * Приводить введене користувачем до назви сайту: "https://www.Example.com/login" → "example.com".
     * Повертає null, якщо це не схоже на адресу сайту.
     */
    function normalizeEntry(input) {
        let text = String(input || '').trim().toLowerCase();
        if (!text) return null;
        if (text.startsWith('*.')) text = text.slice(2);
        if (!/^[a-z][a-z0-9+.-]*:\/\//.test(text)) text = 'https://' + text;
        let hostname;
        try {
            hostname = new URL(text).hostname;
        } catch (e) {
            return null;
        }
        hostname = hostname.replace(/\.$/, '').replace(/^www\./, '');
        const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname);
        if (!isIp && (!/^[a-z0-9.-]+$/.test(hostname) || !hostname.includes('.') || /(^|\.)-|-(\.|$)|\.\./.test(hostname))) {
            return null;
        }
        return hostname;
    }

    /** Чи підпадає hostname під якийсь запис списку (сам сайт або його піддомен). Повертає запис або null. */
    function findMatch(hostname, list) {
        const host = String(hostname || '').toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
        if (!host) return null;
        for (const entry of list || []) {
            if (host === entry || host.endsWith('.' + entry)) return entry;
        }
        return null;
    }

    /** Додає запис у список (без дублів, за абеткою). Повертає новий масив. */
    function addEntry(list, entry) {
        const set = new Set(list || []);
        set.add(entry);
        return [...set].sort();
    }

    function removeEntry(list, entry) {
        return (list || []).filter(e => e !== entry);
    }

    root.FactGuardLists = { normalizeEntry, findMatch, addEntry, removeEntry };
})(typeof self !== 'undefined' ? self : this);
