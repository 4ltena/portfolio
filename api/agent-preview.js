'use strict';

const path = require('node:path');
const express = require('express');
const Database = require('better-sqlite3');
const { createContentReader } = require('./agent-content');
const { createPublicService, errorEnvelope, publicError, DEFAULT_LIMITS } = require('./agent-public-service');
const { createPublicRouter } = require('./agent-public');
const { generateJsonLd, serializeJsonLd } = require('./agent-jsonld');
const { createMarkdownRouter, siteLlms } = require('./agent-markdown');
const html = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function createPreview({ root, db }) {
    const app = express();
    app.disable('x-powered-by');
    const reader = createContentReader({ root, db });
    const service = createPublicService({ root, db });
    app.use((req, res, next) => {
        res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'X-Content-Type-Options': 'nosniff',
            'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'" });
        next();
    });
    app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'agent-preview/index.html')));
    for (const file of ['preview.css', 'preview.js']) app.get('/' + file, (req, res) => res.sendFile(path.join(__dirname, 'agent-preview', file)));
    app.get('/llms.txt', (req, res) => res.type('text/plain').send(siteLlms()));
    app.use('/portfolio', createMarkdownRouter({ reader }));
    app.use('/portfolio/api/public', createPublicRouter({ service }));
    function send(res, value, type) {
        if (Buffer.byteLength(value) > DEFAULT_LIMITS.maxOutputBytes) throw publicError('source_unavailable');
        return res.type(type).set('Content-Length', String(Buffer.byteLength(value))).end(value);
    }
    function schema(kind, id) {
        const profile = service.get({ kind: 'profile' }).item;
        if (['works', 'notes', 'skills', 'timeline'].includes(kind) && !id) {
            // Match the initial source HTML: Notes cards are JS-rendered; other collections are complete.
            const items = [];
            let cursor;
            if (kind !== 'notes') do {
                const result = service.list({ kind, limit: 50, cursor });
                items.push(...result.items);
                cursor = result.next_cursor || undefined;
            } while (cursor);
            return generateJsonLd({ kind, items, profile });
        }
        const item = service.get({ kind: kind === 'index' ? 'profile' : kind, id }).item;
        return generateJsonLd({ kind: id ? (kind === 'works' ? 'work' : 'note') : kind, item, profile });
    }
    function page(req, res, kind, id) {
        const item = service.get({ kind: kind === 'index' ? 'profile' : kind, id }).item;
        const mdPath = `/portfolio/${id ? kind + '/' + id : kind}.md`;
        const md = service.markdown({ kind, id });
        res.vary('Accept').set('Link', `<${mdPath}>; rel="alternate"; type="text/markdown", </portfolio/llms.txt>; rel="describedby"`);
        if (req.accepts(['html', 'text/markdown']) === 'text/markdown') return send(res, md, 'text/markdown');
        const data = serializeJsonLd(schema(kind, id));
        return send(res, `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${html(item.title)}</title><link rel="stylesheet" href="/preview.css"><link rel="canonical" href="${html(item.canonical_url)}"><link rel="alternate" type="text/markdown" href="${mdPath}"><link rel="describedby" href="/portfolio/llms.txt"><script id="portfolio-agent-jsonld" type="application/ld+json">${data}</script></head><body><main class="document"><a href="/">← Agent preview</a><article><h1>${html(item.title)}</h1><p>ローカル試作 / <a href="${html(item.canonical_url)}">取得元</a> / <a href="${mdPath}">Markdown</a></p><pre>${html(md)}</pre></article></main></body></html>`, 'html');
    }
    for (const kind of ['index', 'profile', 'works', 'notes', 'skills', 'timeline']) {
        app.get(`/portfolio/${kind}.jsonld`, (req, res) => send(res, serializeJsonLd(schema(kind)), 'application/ld+json'));
    }
    app.get(['/portfolio/', '/portfolio/index.html'], (req, res) => page(req, res, 'index'));
    app.get('/portfolio/profile.html', (req, res) => page(req, res, 'profile'));
    for (const kind of ['notes', 'works']) {
        app.get(`/portfolio/${kind}/:id.jsonld`, (req, res) => send(res, serializeJsonLd(schema(kind, req.params.id)), 'application/ld+json'));
        app.get([`/portfolio/${kind}/:id/index.html`, `/portfolio/${kind}/:id/`], (req, res) => page(req, res, kind, req.params.id));
    }
    app.use((req, res) => res.status(404).json({ schema_version: 1, error: { code: 'not_found', message: 'Not found' } }));
    app.use((error, req, res, next) => {
        const payload = errorEnvelope(error);
        res.status(error.status || 503).json(payload);
    });
    return app;
}

if (require.main === module) {
    const root = path.resolve(__dirname, '..');
    const port = Number(process.env.AGENT_PREVIEW_PORT || 8785);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid preview port');
    const db = new Database(path.join(root, 'api/data/portfolio.db'), { readonly: true, fileMustExist: true });
    const app = createPreview({ root, db });
    const server = app.listen(port, '127.0.0.1', () => console.log(`Agent preview: http://127.0.0.1:${port}/ (read-only)`));
    server.on('error', error => { db.close(); console.error(error.message); process.exitCode = 1; });
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close(() => { db.close(); process.exit(0); }));
}
module.exports = { createPreview };
