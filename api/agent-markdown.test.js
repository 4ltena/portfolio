'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const Database = require('better-sqlite3');
const { createMarkdownRouter } = require('./agent-markdown');

function sourceFiles(root) {
    const write = (name, value) => { const target = path.join(root, name); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, value); };
    write('index.html', '<div class="hero-foot"><span>Infrastructure</span></div><section id="profile"><span class="brand">Altena</span><p class="philosophy">Alt &amp; Higher Standards</p><div class="bio"><p>公開プロフィール</p></div><nav class="profile-social"><a href="https://github.com/4ltena">GitHub</a></nav></section>');
    write('terminal/profile.txt', ' / / /| Role Software Engineer\n');
    write('myworks.html', '<a class="page-tile-item" href="works/public-work/index.html" data-tags="#Blender"><h3>制作物</h3><span class="note-date">2026/04/11</span><p>公開作品</p></a>');
    write('works/public-work/index.html', '<div class="project-desc"><h3>About</h3><p>制作内容。</p><pre>const x = 1;</pre></div>');
    write('works/work-template.html', 'TEMPLATE_SECRET');
}

async function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'portfolio-public-markdown-'));
    sourceFiles(root);
    const file = path.join(root, 'portfolio.db');
    const writer = new Database(file);
    writer.exec(`CREATE TABLE articles (id TEXT,title TEXT,date TEXT,tags TEXT,excerpt TEXT,content TEXT,created_at INTEGER,updated_at INTEGER,published_at INTEGER,visibility TEXT);
        CREATE TABLE skills (id TEXT,name TEXT,description TEXT,sort_order INTEGER);
        CREATE TABLE timeline (id TEXT,date TEXT,title TEXT,category TEXT,href TEXT);`);
    const insert = writer.prepare('INSERT INTO articles VALUES (?,?,?,?,?,?,?,?,?,?)');
    for (let i = 0; i < 25; i++) insert.run(`note-${i}`, `公開記事${i}`, '2026/10/09', '["Linux"]', '公開概要', `<h2>章</h2><p>本文${i}</p>`, 1, 2, i + 1, 'public');
    // A legacy malformed ID must be removed before LIMIT, or it hides the next-page sentinel.
    insert.run('bad/id', 'INVALID_ID_SECRET', '2026/10/09', '[]', 'INVALID_ID_SUMMARY', 'INVALID_ID_BODY', 1, 2, 5.5, 'public');
    for (const visibility of ['draft', 'unlisted']) insert.run(visibility, visibility + '_SECRET', '2026/10/09', '[]', visibility + '_SUMMARY', visibility + '_BODY', 1, 2, 999, visibility);
    writer.prepare('INSERT INTO skills VALUES (?,?,?,?)').run('linux', 'Linux', '運用', 0);
    writer.prepare('INSERT INTO timeline VALUES (?,?,?,?,?)').run('event', '2026/10/09', '制作開始', 'school', null);
    writer.close();
    const hash = () => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    const db = new Database(file, { readonly: true });
    const app = express();
    app.use('/agent', createMarkdownRouter({ root, db }));
    app.use((req, res) => res.status(404).end('Not found'));
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    t.after(async () => { await new Promise(resolve => server.close(resolve)); db.close(); fs.rmSync(root, { recursive: true }); });
    return { root, file, db, hash, get: (url, options) => fetch(base + url, options) };
}

test('public Markdown provides discoverable summaries, complete details, and bounded pages without writing the DB', async t => {
    const { get, hash } = await fixture(t);
    const before = hash();
    for (const name of ['site-llms.txt', 'llms.txt', 'index.md', 'profile.md', 'skills.md', 'timeline.md', 'works.md', 'notes.md', 'works/public-work.md', 'notes/note-24.md']) {
        const response = await get('/agent/' + name);
        assert.equal(response.status, 200, name);
        assert.match(response.headers.get('content-type'), name.endsWith('.txt') ? /^text\/plain/ : /^text\/markdown/);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        const body = await response.text();
        assert.doesNotMatch(body, /draft_SECRET|unlisted_SECRET|draft_BODY|unlisted_BODY|TEMPLATE_SECRET|INVALID_ID_/);
        if (name === 'index.md') assert.match(body, /公開プロフィール[\s\S]*活動分野[\s\S]*works\.md[\s\S]*notes\.md/);
        if (name === 'notes.md') {
            assert.equal((body.match(/\[2026-10-09 公開記事/g) || []).length, 20);
            assert.match(body, /notes\.md\?page=2/); assert.doesNotMatch(body, /本文/);
        }
        if (name === 'notes/note-24.md') assert.match(body, /## 章[\s\S]*本文24/);
        if (name === 'works/public-work.md') assert.match(body, /制作内容[\s\S]*```\nconst x = 1;/);
    }
    const second = await get('/agent/notes.md?page=2');
    assert.equal(second.status, 200); assert.equal(((await second.text()).match(/\[2026-10-09 公開記事/g) || []).length, 5);
    const head = await get('/agent/index.md', { method: 'HEAD' });
    assert.equal(head.status, 200); assert.equal(await head.text(), '');
    assert.ok(Number(head.headers.get('content-length')) > 0);
    assert.equal(hash(), before);
});

test('nonpublic IDs, traversal, write methods, and malformed pagination never expose hidden content', async t => {
    const { get } = await fixture(t);
    for (const url of ['/agent/notes/draft.md', '/agent/notes/unlisted.md', '/agent/notes/missing.md', '/agent/works/work-template.md', '/agent/notes/..%2Fsecret.md', '/agent/works/%2Fetc%2Fpasswd.md']) {
        assert.equal((await get(url)).status, 404, url);
    }
    for (const value of ['0', '-1', '1.5', '10000', 'x', '1&page=2', '1&page[]=2']) {
        assert.equal((await get('/agent/notes.md?page=' + value)).status, 400, value);
    }
    assert.equal((await get('/agent/notes.md?page=3')).status, 404);
    assert.equal((await get('/agent/index.md', { method: 'POST', body: 'write' })).status, 404);
});

test('public-to-draft transitions remove details and listings immediately, including conditional requests', async t => {
    const { get, file } = await fixture(t);
    assert.equal((await get('/agent/notes/note-24.md')).status, 200);
    const writer = new Database(file);
    writer.prepare("UPDATE articles SET visibility='draft' WHERE id=?").run('note-24');
    writer.close();
    const response = await get('/agent/notes/note-24.md', { headers: { 'If-None-Match': '*' } });
    assert.equal(response.status, 404); assert.equal(response.headers.get('cache-control'), 'no-store');
    for (const name of ['llms.txt', 'index.md', 'notes.md']) assert.doesNotMatch(await (await get('/agent/' + name)).text(), /公開記事24|note-24/);
});

test('the real API mounts the Markdown reader against an isolated database', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'portfolio-markdown-integration-'));
    sourceFiles(root);
    const names = ['PORTFOLIO_ROOT', 'PORTFOLIO_DATA_DIR', 'PORTFOLIO_NOTES_OUT_DIR', 'PORTFOLIO_IMG_DIR'];
    const old = Object.fromEntries(names.map(name => [name, process.env[name]]));
    process.env.PORTFOLIO_ROOT = root;
    process.env.PORTFOLIO_DATA_DIR = path.join(root, 'data');
    process.env.PORTFOLIO_NOTES_OUT_DIR = path.join(root, 'notes');
    process.env.PORTFOLIO_IMG_DIR = path.join(root, 'img');
    fs.mkdirSync(process.env.PORTFOLIO_DATA_DIR);
    fs.writeFileSync(path.join(process.env.PORTFOLIO_DATA_DIR, 'config.json'), JSON.stringify({ passwordHash: 'unused', jwtSecret: 'isolated-markdown-contract' }));
    let server, db;
    const modulePath = require.resolve('./server');
    t.after(async () => {
        if (server) await new Promise(resolve => server.close(resolve));
        if (db) db.close(); delete require.cache[modulePath];
        for (const name of names) old[name] === undefined ? delete process.env[name] : process.env[name] = old[name];
        fs.rmSync(root, { recursive: true });
    });
    delete require.cache[modulePath];
    const runtime = require('./server'); db = runtime.db;
    server = runtime.app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const response = await fetch(`http://127.0.0.1:${server.address().port}/agent/index.md`);
    assert.equal(response.status, 200); assert.match(await response.text(), /公開プロフィール/);
    const admin = await fetch(`http://127.0.0.1:${server.address().port}/admin/articles`);
    assert.equal(admin.status, 401);
});
