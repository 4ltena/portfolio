'use strict';

const crypto = require('node:crypto');
const { createContentReader, htmlToMarkdown, documentMarkdown, escapeMarkdown, SITE } = require('./agent-content');
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const KINDS = ['works', 'notes', 'skills', 'timeline'];
const DEFAULT_LIMITS = Object.freeze({ maxItems: 1000, maxFileBytes: 2 * 1024 * 1024,
    maxBodyBytes: 512 * 1024, maxDatasetBytes: 16 * 1024 * 1024, maxOutputBytes: 2 * 1024 * 1024 });
const ERRORS = Object.freeze({
    invalid_request: [400, 'Invalid request'], invalid_cursor: [400, 'Invalid cursor'],
    not_found: [404, 'Not found'], method_not_allowed: [405, 'Method not allowed'],
    cursor_expired: [409, 'Cursor expired'], rate_limited: [429, 'Rate limited'],
    source_unavailable: [503, 'Source unavailable']
});
class PublicError extends Error {
    constructor(code) { super(ERRORS[code][1]); this.code = code; this.status = ERRORS[code][0]; }
}
const publicError = code => new PublicError(Object.hasOwn(ERRORS, code) ? code : 'source_unavailable');
const controlled = error => error instanceof PublicError ? error : publicError('source_unavailable');
const errorEnvelope = error => ({ schema_version: 1, error: { code: controlled(error).code, message: controlled(error).message } });
const hash = value => 'sha256:' + crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const normalize = value => value.normalize('NFKC').toLowerCase();
function string(value) { if (typeof value !== 'string') throw publicError('source_unavailable'); return value; }
function strings(value) { if (!Array.isArray(value)) throw publicError('source_unavailable'); return value.map(string); }
function date(value) {
    if (value == null || value === '') return null;
    const result = string(value).replaceAll('/', '-').replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(result) || !Number.isFinite(Date.parse(result)) || new Date(result).toISOString().slice(0, 10) !== result) throw publicError('source_unavailable');
    return result;
}
function timestamp(value) { return value == null ? null : new Date(value).toISOString(); }
function link(value) {
    if (!value) return null;
    try { const url = new URL(string(value), SITE); return ['https:', 'http:'].includes(url.protocol) ? url.href : null; }
    catch { return null; }
}
function toDto(item) {
    if (typeof item.id !== 'string' || !ID.test(item.id)) throw publicError('source_unavailable');
    const type = item.type;
    const profile = type === 'profile';
    const trackedFile = profile || type === 'work';
    const dto = { id: item.id, type, title: string(profile ? item.name : type === 'skill' ? item.name : item.title),
        summary: string(profile || type === 'skill' ? item.description : type === 'timeline' ? '' : item.excerpt),
        canonical_url: type === 'note' ? `${SITE}notes/${item.id}/` : trackedFile ? item.source_url : `${SITE}index.html#${type === 'skill' ? 'skills' : 'timeline'}`,
        source_url: trackedFile || type === 'note' ? item.source_url : `${SITE}index.html#${type === 'skill' ? 'skills' : 'timeline'}`,
        date: date(item.date), published_at: type === 'note' ? timestamp(item.published_at) : null,
        updated_at: trackedFile ? item.source_modified_at : type === 'note' ? timestamp(item.updated_at) : null,
        updated_at_basis: trackedFile ? 'source-file-mtime' : type === 'note' ? 'article-record' : 'not-tracked',
        tags: type === 'note' || type === 'work' ? strings(item.tags) : [] };
    if (trackedFile) dto.source_modified_at = string(item.source_modified_at);
    if (profile) Object.assign(dto, { name: string(item.name), roles: strings(item.roles), bio: string(item.bio),
        focus: strings(item.focus), links: strings(item.links), content_markdown: [
            ...item.roles.map(escapeMarkdown), '', escapeMarkdown(item.description), '', escapeMarkdown(item.bio), '',
            '## 活動分野', ...item.focus.map(value => `- ${escapeMarkdown(value)}`), '', '## Links', ...item.links.map(url => `- <${url}>`), ''
        ].join('\n') });
    else if (type === 'work' || type === 'note') dto.content_markdown = string(item.content_markdown);
    else if (type === 'skill') dto.name = string(item.name);
    else if (type === 'timeline') Object.assign(dto, { category: string(item.category || ''), href: link(item.href) });
    const revisionInput = { ...dto };
    delete revisionInput.source_modified_at;
    if (trackedFile) delete revisionInput.updated_at;
    dto.revision = hash(revisionInput);
    return dto;
}
// Used by publication staging as well as request-time reads; never accepts a private row.
function noteDto(row) {
    try {
        if (row.visibility !== 'public' || typeof row.id !== 'string' || !ID.test(row.id)) throw publicError('not_found');
        return toDto({ id: row.id, type: 'note', title: row.title, date: row.date,
            tags: Array.isArray(row.tags) ? row.tags : JSON.parse(row.tags), excerpt: row.excerpt || '',
            content_markdown: htmlToMarkdown(string(row.content), `${SITE}notes/${row.id}/index.html`),
            source_url: `${SITE}notes/${row.id}/index.html`, updated_at: timestamp(row.updated_at ?? row.created_at),
            published_at: timestamp(row.published_at) });
    } catch (error) { throw controlled(error); }
}
function parameters({ kind, q, limit, cursor }) {
    if (!KINDS.includes(kind)) throw publicError('not_found');
    if (q !== undefined && (!['works', 'notes'].includes(kind) || typeof q !== 'string' || [...q].length > 120 || /\p{Cc}/u.test(q))) throw publicError('invalid_request');
    q = normalize((q || '').trim());
    if (limit === undefined) limit = 20;
    else if (typeof limit === 'string' && /^[1-9][0-9]*$/.test(limit)) limit = Number(limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw publicError('invalid_request');
    let position = null;
    if (cursor !== undefined) {
        if (typeof cursor !== 'string' || Buffer.byteLength(cursor) > 2048 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw publicError('invalid_cursor');
        try {
            const bytes = Buffer.from(cursor, 'base64url');
            if (bytes.toString('base64url') !== cursor) throw new Error();
            position = JSON.parse(bytes.toString('utf8'));
            if (!position || typeof position !== 'object' || Array.isArray(position) || Object.keys(position).sort().join(',') !== 'k,l,last,q,r,v' ||
                position.v !== 1 || position.k !== kind || position.q !== hash(q) || position.l !== limit ||
                !/^sha256:[0-9a-f]{64}$/.test(position.r) || !Array.isArray(position.last) || position.last.length !== 2 ||
                typeof position.last[1] !== 'string' || !ID.test(position.last[1]) ||
                (kind === 'skills' ? !Number.isFinite(position.last[0]) : position.last[0] !== null && typeof position.last[0] !== 'string')) throw new Error();
        } catch { throw publicError('invalid_cursor'); }
    }
    return { kind, q, limit, position };
}
const compareId = (a, b) => a < b ? -1 : a > b ? 1 : 0;
function orderKey(kind, raw, dto) {
    if (kind === 'skills' && !Number.isFinite(raw.sort_order)) throw publicError('source_unavailable');
    return [kind === 'skills' ? raw.sort_order : kind === 'notes' ? dto.published_at : dto.date, dto.id];
}
function compareKeys(kind, a, b) {
    if (a[0] !== b[0]) {
        if (a[0] === null) return 1;
        if (b[0] === null) return -1;
        const result = compareId(a[0], b[0]);
        return kind === 'skills' ? result : -result;
    }
    return (kind === 'skills' ? 1 : -1) * compareId(a[1], b[1]);
}
function createPublicService({ root, db, limits: overrides = {}, now = () => new Date() }) {
    const limits = { ...DEFAULT_LIMITS, ...overrides };
    if (Object.keys(overrides).some(key => !Object.hasOwn(DEFAULT_LIMITS, key)) || Object.values(limits).some(value => !Number.isSafeInteger(value) || value < 1)) throw publicError('invalid_request');
    const reader = createContentReader({ root, db, limits });
    const snapshot = db.transaction((kind, id) => reader.publicSnapshot(kind, id));
    const generated = () => {
        const value = timestamp(typeof now === 'function' ? now() : now);
        if (value === null) throw publicError('source_unavailable');
        return value;
    };
    function bounded(value) {
        const bytes = Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value));
        if (bytes > limits.maxOutputBytes) throw publicError('source_unavailable');
        return value;
    }
    function execute(action) { try { return bounded(action()); } catch (error) { throw controlled(error); } }
    function rows(kind) {
        const result = snapshot(kind).map(raw => { const dto = toDto({ ...raw, type: kind === 'skills' ? 'skill' : kind === 'timeline' ? 'timeline' : raw.type });
            return { dto, key: orderKey(kind, raw, dto) }; }).sort((a, b) => compareKeys(kind, a.key, b.key));
        if (result.some((row, i) => i && row.dto.id === result[i - 1].dto.id) || new Set(result.map(row => row.dto.id)).size !== result.length) throw publicError('source_unavailable');
        if (Buffer.byteLength(JSON.stringify(result)) > limits.maxDatasetBytes || result.some(row => Buffer.byteLength(row.dto.content_markdown || '') > limits.maxBodyBytes)) throw publicError('source_unavailable');
        return result;
    }
    function list(input = {}) { return execute(() => {
        const { kind, q, limit, position } = parameters(input);
        const source = rows(kind);
        const revision = hash(source.map(row => [row.key, row.dto.revision]));
        if (position && position.r !== revision) throw publicError('cursor_expired');
        const filtered = q ? source.filter(({ dto }) => normalize([dto.title, dto.summary, ...dto.tags, dto.content_markdown].join('\n')).includes(q)) : source;
        let start = 0;
        if (position) {
            const index = filtered.findIndex(row => JSON.stringify(row.key) === JSON.stringify(position.last));
            if (index < 0) throw publicError('invalid_cursor');
            start = index + 1;
        }
        const page = filtered.slice(start, start + limit);
        const next_cursor = start + limit < filtered.length ? Buffer.from(JSON.stringify({ v: 1, k: kind, q: hash(q), l: limit, last: page.at(-1).key, r: revision })).toString('base64url') : null;
        if (next_cursor && Buffer.byteLength(next_cursor) > 2048) throw publicError('source_unavailable');
        return { schema_version: 1, generated_at: generated(), kind, query: q, count: page.length, total_count: filtered.length,
            limit, next_cursor, items: page.map(({ dto }) => { const summary = { ...dto }; delete summary.content_markdown; return summary; }) };
    }); }
    function get({ kind, id } = {}) { return execute(() => {
        if (kind === 'profile') {
            if (id !== undefined && id !== 'altena') throw publicError('not_found');
            const item = toDto(snapshot('profile'));
            if (Buffer.byteLength(item.content_markdown) > limits.maxBodyBytes) throw publicError('source_unavailable');
            return { schema_version: 1, generated_at: generated(), item };
        }
        if (!['works', 'notes'].includes(kind) || typeof id !== 'string' || !ID.test(id)) throw publicError('not_found');
        const item = kind === 'notes' ? snapshot(kind, id).map(toDto)[0] : rows(kind).find(row => row.dto.id === id)?.dto;
        if (!item) throw publicError('not_found');
        if (Buffer.byteLength(item.content_markdown) > limits.maxBodyBytes) throw publicError('source_unavailable');
        return { schema_version: 1, generated_at: generated(), item };
    }); }
    const line = value => escapeMarkdown(String(value ?? '').replace(/\s+/g, ' ').trim());
    const entry = (title, url, summary = '') => `- [${line(title)}](<${url}>)${summary ? ': ' + line(summary) : ''}`;
    function markdown({ kind, id } = {}) { return execute(() => {
        if (kind === 'index') {
            if (id !== undefined) throw publicError('not_found');
            const profile = get({ kind: 'profile' }).item;
            const works = list({ kind: 'works', limit: 5 }).items;
            const notes = list({ kind: 'notes', limit: 5 }).items;
            return ['# Altena Portfolio', '', `取得元: ${SITE}index.html`, '', '## Profile', `### ${line(profile.name)}`,
                ...profile.roles.map(line), '', line(profile.summary), '', line(profile.bio), '', '## 活動分野',
                ...profile.focus.map(value => `- ${line(value)}`), '', '## コンテンツ',
                ...['profile', ...KINDS].map(value => entry(value[0].toUpperCase() + value.slice(1), `${SITE}${value}.md`)), '',
                '## Works', ...works.map(item => entry(item.title, `${SITE}works/${item.id}.md`, item.summary)), '',
                '## Latest Notes', ...notes.map(item => entry(item.title, `${SITE}notes/${item.id}.md`, item.summary)), '',
                '## 公開連絡先', ...profile.links.map(url => `- <${url}>`), ''].join('\n');
        }
        if (kind === 'profile' || id !== undefined) {
            const item = get({ kind, id }).item;
            return documentMarkdown({ ...item, description: item.summary, excerpt: item.summary });
        }
        if (kind === 'skills' || kind === 'timeline') {
            const items = rows(kind).map(row => row.dto);
            const body = items.map(item => kind === 'skills' ? `- **${line(item.name)}**: ${line(item.summary)}` :
                `- ${line(item.date)} — ${line(item.title)} (${line(item.category)})`);
            return `# ${kind === 'skills' ? 'Skills' : 'Timeline'}\n\n取得元: ${SITE}index.html#${kind}\n更新日時: 未記録\n\n${body.join('\n')}\n`;
        }
        const result = list({ kind });
        const body = result.items.map(item => entry(`${item.date} ${item.title}`, `${SITE}${kind}/${item.id}.md`, item.summary));
        const guidance = `続きを取得するには list_public_content に kind: "${kind}" と同じ limit を指定し、応答の next_cursor を cursor に渡してください。検索は search_public_content に同じ kind と q を指定します。cursor_expired の場合は cursor を省いて先頭から取得してください。`;
        return `# ${kind[0].toUpperCase() + kind.slice(1)}\n\n${body.join('\n')}\n\n件数: ${result.count} / ${result.total_count}\n\n${guidance}\n`;
    }); }
    return { list, get, markdown };
}
module.exports = { createPublicService, noteDto, PublicError, publicError, errorEnvelope, DEFAULT_LIMITS };
