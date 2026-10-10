'use strict';

const fs = require('node:fs');
const path = require('node:path');
// Shared by the public Markdown routes and the isolated agent preview.
const { parseDocument } = require('htmlparser2');
const { sanitizeHtml } = require('./notes-publication');
const SITE = 'https://altena.me/portfolio/';
const ID = /^[A-Za-z0-9_-]{1,128}$/;
// SQLite text functions stop at NUL; the byte/character length equality rejects those legacy IDs too.
const PUBLIC_ID_SQL = "typeof(id)='text' AND length(id) BETWEEN 1 AND 128 AND length(CAST(id AS BLOB))=length(id) AND id NOT GLOB '*[^A-Za-z0-9_-]*'";
const children = node => node?.children || [];
const hasClass = (node, name) => (node?.attribs?.class || '').split(/\s+/).includes(name);
function findAll(node, predicate) {
    return children(node).flatMap(child => [...(predicate(child) ? [child] : []), ...findAll(child, predicate)]);
}
const find = (node, predicate) => findAll(node, predicate)[0];
function rawText(node) { return node?.type === 'text' ? node.data : node?.name === 'br' ? '\n' : children(node).map(rawText).join(''); }
const text = node => rawText(node).replace(/\s+/g, ' ').trim();
const escapeMarkdown = value => String(value || '').replace(/([\\`*_{}\[\]<>#|])/g, '\\$1');
const fence = value => '`'.repeat(Math.max(3, ...((value.match(/`+/g) || []).map(run => run.length + 1))));
function safeURL(value, source, image = false) {
    if (!value) return null;
    try {
        const url = new URL(value, source);
        return (image ? ['http:', 'https:'] : ['http:', 'https:', 'mailto:']).includes(url.protocol) ? url.href : null;
    } catch { return null; }
}

function htmlToMarkdown(html, source = SITE) {
    const document = parseDocument(sanitizeHtml(html), { decodeEntities: true });
    function render(node) {
        if (node.type === 'text') {
            if (!node.data.trim() && [node.prev?.name, node.next?.name].some(tag => /^(p|h[2-4]|pre|ul|ol|table|blockquote|hr)$/.test(tag || ''))) return '';
            return escapeMarkdown(node.data.replace(/\s+/g, ' '));
        }
        const inside = () => children(node).map(render).join('');
        const content = () => inside().trim();
        const tag = node.name;
        if (/^h[2-4]$/.test(tag || '')) return `\n\n${'#'.repeat(Number(tag[1]))} ${content()}\n\n`;
        if (tag === 'p') return `\n\n${content()}\n\n`;
        if (tag === 'br') return '\n';
        if (tag === 'hr') return '\n\n---\n\n';
        if (tag === 'pre') { const value = rawText(node); const ticks = fence(value); return `\n\n${ticks}\n${value}\n${ticks}\n\n`; }
        if (tag === 'code') { const value = rawText(node); const ticks = '`'.repeat(Math.max(1, ...((value.match(/`+/g) || []).map(run => run.length + 1)))); return `${ticks} ${value} ${ticks}`; }
        if (['b', 'strong'].includes(tag)) return `**${content()}**`;
        if (['i', 'em'].includes(tag)) return `*${content()}*`;
        if (tag === 's') return `~~${content()}~~`;
        if (tag === 'blockquote') return `\n\n${content().split('\n').map(line => `> ${line}`).join('\n')}\n\n`;
        if (tag === 'a') { const url = safeURL(node.attribs.href, source); return url ? `[${content()}](<${url}>)` : inside(); }
        if (tag === 'img') { const url = safeURL(node.attribs.src, source, true); return url ? `\n\n![${escapeMarkdown(node.attribs.alt)}](<${url}>)\n\n` : ''; }
        if (tag === 'ul' || tag === 'ol') return `\n\n${children(node).filter(child => child.name === 'li').map((child, i) => `${tag === 'ol' ? `${i + 1}.` : '-'} ${render(child).trim().replace(/\n/g, '\n  ')}`).join('\n')}\n\n`;
        if (tag === 'table') {
            const rows = findAll(node, child => child.name === 'tr').map(row => children(row).filter(cell => ['th', 'td'].includes(cell.name)).map(cell => render(cell).trim().replace(/\n/g, ' ')));
            if (!rows.length) return '';
            const width = Math.max(...rows.map(row => row.length));
            const line = row => `| ${Array.from({ length: width }, (_, i) => row[i] || '').join(' | ')} |`;
            return `\n\n${[line(rows[0]), line(Array(width).fill('---')), ...rows.slice(1).map(line)].join('\n')}\n\n`;
        }
        return inside();
    }
    // Reduce HTML indentation noise without changing blank lines inside code fences.
    const lines = [];
    let fenceWidth = 0;
    for (const line of children(document).map(render).join('').trim().split('\n')) {
        const marker = /^(`{3,})$/.exec(line);
        if (marker && (!fenceWidth || marker[1].length >= fenceWidth)) {
            fenceWidth = fenceWidth ? 0 : marker[1].length;
            lines.push(line);
        } else if (fenceWidth || line.trim()) lines.push(line);
        else if (lines.at(-1) !== '') lines.push('');
    }
    return lines.join('\n').trim() + '\n';
}

function createContentReader({ root, db, limits }) {
    let sourceBytes = 0;
    const checkRows = rows => {
        if (limits && rows.length > limits.maxItems) throw new Error('Public source limit exceeded');
        return rows;
    };
    const charge = bytes => {
        sourceBytes += bytes;
        if (limits && sourceBytes > limits.maxDatasetBytes) throw new Error('Public source limit exceeded');
    };
    const readText = filename => {
        if (!limits) return fs.readFileSync(path.join(root, filename), 'utf8');
        const target = fs.realpathSync(path.join(root, filename));
        if (!target.startsWith(fs.realpathSync(root) + path.sep)) throw new Error('Source escapes root');
        const fd = fs.openSync(target, 'r');
        try {
            const stat = fs.fstatSync(fd);
            if (!stat.isFile() || stat.size > limits.maxFileBytes) throw new Error('Public source limit exceeded');
            charge(stat.size);
            const value = fs.readFileSync(fd, 'utf8');
            const bytes = Buffer.byteLength(value);
            if (bytes > limits.maxFileBytes) throw new Error('Public source limit exceeded');
            if (bytes > stat.size) charge(bytes - stat.size);
            return value;
        } finally { fs.closeSync(fd); }
    };
    const read = filename => parseDocument(readText(filename));
    const modified = filename => fs.statSync(path.join(root, filename)).mtime.toISOString();
    function profile() {
        const html = read('index.html');
        const section = find(html, node => node.attribs?.id === 'profile');
        if (!section) throw new Error('Profile source is missing');
        const bio = find(section, node => hasClass(node, 'bio'));
        const social = find(section, node => hasClass(node, 'profile-social'));
        const links = findAll(social, node => node.name === 'a').map(node => safeURL(node.attribs.href, SITE)).filter(Boolean);
        const terminal = readText('terminal/profile.txt');
        const roles = terminal.split('\n').filter(line => /Role\s+|Frontend Developer/.test(line)).map(line => line.replace(/^.*?\|(?:__)?\s*(?:Role\s+)?/, '').trim());
        return { id: 'altena', type: 'profile', name: text(find(section, node => hasClass(node, 'brand'))), roles,
            description: text(find(section, node => hasClass(node, 'philosophy'))),
            bio: findAll(bio, node => node.name === 'p').map(text).join('\n'),
            focus: findAll(find(html, node => hasClass(node, 'hero-foot')), node => node.name === 'span' && !hasClass(node, 'hero-scroll')).map(text),
            links, source_url: `${SITE}index.html#profile`,
            source_modified_at: [modified('index.html'), modified('terminal/profile.txt')].sort().at(-1),
            updated_at_basis: 'source-file-mtime' };
    }
    function works() {
        const html = read('myworks.html');
        const cards = findAll(html, node => node.name === 'a' && hasClass(node, 'page-tile-item'));
        if (limits && !cards.length && !find(html, node => hasClass(node, 'page-tile-container'))) throw new Error('Works source is missing');
        const publishedCards = limits ? cards.filter(card => /^works\/[A-Za-z0-9_-]{1,128}\/index\.html$/.test(card.attribs.href || '')) : cards;
        return checkRows(publishedCards).flatMap(card => {
            const match = /^works\/([A-Za-z0-9_-]{1,128})\/index\.html$/.exec(card.attribs.href || '');
            if (!match) return [];
            const filename = `works/${match[1]}/index.html`;
            // Only read a published card target inside the repository, never an arbitrary path/symlink.
            const target = fs.realpathSync(path.join(root, filename));
            if (!target.startsWith(fs.realpathSync(root) + path.sep)) throw new Error('Work source escapes root');
            const detail = read(filename);
            const desc = find(detail, node => hasClass(node, 'project-desc'));
            if (!desc) throw new Error('Work description is missing');
            findAll(desc, node => node.name === 'img').forEach(image => {
                const src = safeURL(image.attribs.src, SITE + filename, true);
                if (src) image.attribs.src = src;
            });
            const inner = require('domutils').getInnerHTML(desc);
            if (limits && Buffer.byteLength(inner) > limits.maxBodyBytes) throw new Error('Public source limit exceeded');
            return [{ id: match[1], type: 'work', title: text(find(card, node => node.name === 'h3')),
                date: text(find(card, node => hasClass(node, 'note-date'))).replaceAll('/', '-'),
                tags: (card.attribs['data-tags'] || '').split(/\s+/).filter(Boolean).map(tag => tag.replace(/^#/, '')),
                excerpt: text(find(card, node => node.name === 'p')), content_markdown: htmlToMarkdown(inner, SITE + filename),
                source_url: SITE + filename, source_modified_at: [modified(filename), modified('myworks.html')].sort().at(-1),
                updated_at_basis: 'source-file-mtime' }];
        });
    }
    function notes(id) {
        if (id !== undefined && !ID.test(id)) return [];
        const columns = 'id,title,date,tags,excerpt,content,created_at,updated_at,published_at';
        const where = `visibility='public'${limits ? ` AND ${PUBLIC_ID_SQL}` : ''}${id === undefined ? '' : ' AND id=?'}`;
        if (limits) checkTable('articles', columns, where, id === undefined ? [] : [id], 'content');
        const statement = db.prepare(`SELECT ${columns} FROM articles WHERE ${where}${id === undefined ? ' ORDER BY published_at DESC,id DESC' : ''}`);
        const rows = id === undefined ? statement.all() : statement.all(id);
        return checkRows(rows).map(row => ({ id: row.id, type: 'note', title: row.title, date: row.date.replaceAll('/', '-'),
            tags: JSON.parse(row.tags), excerpt: row.excerpt || '', content_markdown: htmlToMarkdown(row.content, `${SITE}notes/${row.id}/index.html`),
            source_url: `${SITE}notes/${row.id}/index.html`, updated_at: new Date(row.updated_at ?? row.created_at).toISOString(),
            published_at: row.published_at == null ? null : new Date(row.published_at).toISOString(), updated_at_basis: 'article-record' }));
    }
    function checkTable(table, columns, where = '1', values = [], bodyColumn) {
        // Fixed internal column names only; callers never supply SQL identifiers.
        const bytes = columns.split(',').map(column => `coalesce(length(CAST(${column} AS BLOB)),0)`).join('+');
        const body = bodyColumn ? `max(length(CAST(${bodyColumn} AS BLOB)))` : '0';
        const stats = db.prepare(`SELECT count(*) AS count,coalesce(sum(${bytes}),0) AS bytes,coalesce(${body},0) AS body
            FROM (SELECT ${columns} FROM ${table} WHERE ${where} LIMIT ${limits.maxItems + 1})`).get(...values);
        if (stats.count > limits.maxItems || stats.body > limits.maxBodyBytes) throw new Error('Public source limit exceeded');
        charge(stats.bytes);
    }
    function noteSummaries({ limit = 20, offset = 0 } = {}) {
        if (!Number.isInteger(limit) || limit < 1 || limit > 21 || !Number.isInteger(offset) || offset < 0) throw new Error('Invalid note window');
        return db.prepare(`SELECT id,title,date,tags,excerpt FROM articles WHERE visibility='public'
            AND length(id) BETWEEN 1 AND 128 AND id NOT GLOB '*[^A-Za-z0-9_-]*'
            ORDER BY published_at DESC,id DESC LIMIT ? OFFSET ?`).all(limit, offset).map(row => ({
            id: row.id, title: row.title, date: row.date.replaceAll('/', '-'), excerpt: row.excerpt || '',
            tags: JSON.parse(row.tags), source_url: `${SITE}notes/${row.id}/index.html`
        }));
    }
    function publicSnapshot(kind, id) {
        sourceBytes = 0;
        if (kind === 'profile') return profile();
        if (kind === 'works') return works();
        if (kind === 'notes') return notes(id);
        const where = PUBLIC_ID_SQL;
        if (kind === 'skills') {
            if (limits) checkTable('skills', 'id,name,description,sort_order', where);
            return checkRows(db.prepare(`SELECT id,name,description,sort_order FROM skills WHERE ${where} ORDER BY sort_order,id`).all());
        }
        if (kind === 'timeline') {
            if (limits) checkTable('timeline', 'id,date,title,category,href', where);
            return checkRows(db.prepare(`SELECT id,date,title,category,href FROM timeline WHERE ${where} ORDER BY date DESC,id DESC`).all());
        }
        throw new Error('Unknown public source');
    }
    return { profile, works, notes, noteSummaries, publicSnapshot,
        skills: () => db.prepare('SELECT id,name,description FROM skills ORDER BY sort_order,id').all(),
        timeline: () => db.prepare('SELECT id,date,title,category,href FROM timeline ORDER BY date DESC,id DESC').all() };
}

function documentMarkdown(item) {
    const title = item.name || item.title;
    const meta = `取得元: ${item.source_url}\n更新日時: ${item.updated_at || item.source_modified_at}\n更新日時の根拠: ${item.updated_at_basis}\nID: ${item.id}${item.revision ? `\nrevision: ${escapeMarkdown(item.revision)}` : ''}`;
    return `# ${escapeMarkdown(title)}\n\n${meta}\n\n` + (item.type === 'profile'
        ? `${item.roles.map(escapeMarkdown).join('\n')}\n\n${escapeMarkdown(item.description)}\n\n${escapeMarkdown(item.bio)}\n\n## 活動分野\n${item.focus.map(value => `- ${escapeMarkdown(value)}`).join('\n')}\n\n## Links\n${item.links.map(url => `- <${url}>`).join('\n')}\n`
        : `日付: ${item.date}\nタグ: ${item.tags.map(escapeMarkdown).join(', ')}\n\n${escapeMarkdown(item.excerpt)}\n\n${item.content_markdown}`);
}
function structuredData(item) {
    if (item.type === 'profile') return { '@context': 'https://schema.org', '@type': 'ProfilePage', '@id': item.source_url,
        url: item.source_url, dateModified: item.source_modified_at, mainEntity: { '@type': 'Person', '@id': `${SITE}#altena`, name: item.name,
            description: item.bio, jobTitle: item.roles, knowsAbout: item.focus,
            sameAs: item.links.filter(url => /^https:/.test(url)), email: item.links.find(url => url.startsWith('mailto:'))?.slice(7) } };
    return { '@context': 'https://schema.org', '@type': item.type === 'note' ? 'BlogPosting' : 'CreativeWork',
        '@id': item.source_url, url: item.source_url, name: item.title, headline: item.title,
        description: item.excerpt, keywords: item.tags, datePublished: item.published_at || item.date,
        dateModified: item.updated_at || item.source_modified_at, author: { '@type': 'Person', '@id': `${SITE}#altena`, name: 'Altena' } };
}
module.exports = { createContentReader, htmlToMarkdown, documentMarkdown, structuredData, escapeMarkdown, SITE };
