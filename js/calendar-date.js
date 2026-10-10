/* Shared by the admin editor and the Timeline API write boundary. */
(function (root) {
    'use strict';

    function formatCompactDate(value, allowISO = false) {
        if (typeof value !== 'string') return null;
        const raw = value.trim();
        const separated = raw.match(allowISO ? /^(\d{4})([/-])(\d{2})\2(\d{2})$/ : /^(\d{4})\/(\d{2})\/(\d{2})$/);
        const compact = /^\d{8}$/.test(raw) ? raw : separated && (allowISO ? separated[1] + separated[3] + separated[4] : separated.slice(1).join(''));
        if (!compact) return null;
        const year = Number(compact.slice(0, 4));
        const month = Number(compact.slice(4, 6));
        const day = Number(compact.slice(6, 8));
        const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
        const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
        if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1]) return null;
        return compact.slice(0, 4) + '/' + compact.slice(4, 6) + '/' + compact.slice(6, 8);
    }

    if (typeof module === 'object' && module.exports) module.exports = { formatCompactDate };
    else root.CalendarDate = { formatCompactDate };
})(globalThis);
