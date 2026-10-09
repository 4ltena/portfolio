'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const Database = require('better-sqlite3');
const { createPublicService, noteDto, publicError, errorEnvelope } = require('./agent-public-service');
const { createPublicRouter } = require('./agent-public');
const { LIST_SCHEMA, DETAIL_SCHEMA, ERROR_SCHEMA } = require('./agent-public-schema');

function fixture(t, options = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'portfolio-json-contract-'));
    const write = (name, value) => { const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); };
    write('index.html', '<div class="hero-foot"><span>Infrastructure</span></div><section id="profile"><span class="brand">Altena</span><p class="philosophy">Public philosophy</p><div class="bio"><p>公開プロフィール</p></div><nav class="profile-social"><a href="https://github.com/4ltena">GitHub</a></nav></section>');
    write('terminal/profile.txt', '/ / | Role Software Engineer\n');
    write('myworks.html', '<div class="page-tile-container"><a class="page-tile-item" href="works/work-a/index.html" data-tags="#Linux"><h3>ＡＢＣ Work</h3><span class="note-date">2026/10/09</span><p>Public work</p></a></div>');
    write('works/work-a/index.html', '<div class="project-desc"><h3>About</h3><p>Work body</p></div>');
    write('works/work-template.html', 'UNLISTED_WORK_SECRET');
    const file = path.join(root, 'isolated.db');
    const writer = new Database(file);
    writer.pragma('journal_mode = WAL');
    writer.exec(`CREATE TABLE articles (id TEXT,title TEXT,date TEXT,tags TEXT,excerpt TEXT,content TEXT,created_at INTEGER,updated_at INTEGER,published_at INTEGER,visibility TEXT,share_version INTEGER);
        CREATE TABLE skills (id TEXT,name TEXT,description TEXT,sort_order INTEGER);
        CREATE TABLE timeline (id TEXT,date TEXT,title TEXT,category TEXT,href TEXT);`);
    const insert = writer.prepare('INSERT INTO articles VALUES (?,?,?,?,?,?,?,?,?,?,?)');
    for (let i = 0; i < 5; i++) insert.run(`note-${i}`, i === 4 ? 'ＡＢＣ 🧪 Linux' : `Public ${i}`, '2026/10/09', '["ＬＩＮＵＸ"]', `Public summary ${i}`, `<p>Body ${i} fulltextneedle 🧪</p>`, 1, 2, 1000, 'public', 99);
    insert.run('bad/id', 'INVALID_ID_SECRET', '2026/10/09', 'BROKEN_JSON', 'LEGACY_SECRET', 'INVALID_BODY_SECRET', 1, 2, 5000, 'public', 99);
    insert.run('bad\u0000id', 'INVALID_NUL_SECRET', '2026/10/09', 'BROKEN_JSON', 'LEGACY_SECRET', 'INVALID_BODY_SECRET', 1, 2, 5000, 'public', 99);
    for (const visibility of ['draft', 'unlisted']) insert.run(visibility, visibility + '_SECRET', 'BAD_DATE', 'BROKEN_JSON', visibility + '_SUMMARY', visibility + '_BODY'.repeat(1000), 1, 2, 9999, visibility, 99);
    writer.prepare('INSERT INTO skills VALUES (?,?,?,?)').run('skill-a', 'Linux', 'Public operation', 1);
    writer.prepare('INSERT INTO skills VALUES (?,?,?,?)').run('skill-b', 'Rust', 'Public systems', 2);
    writer.prepare('INSERT INTO timeline VALUES (?,?,?,?,?)').run('event-a', '2026/10/09', 'Public event', 'school', 'javascript:SECRET');
    const db = new Database(file, { readonly: true });
    const service = createPublicService({ root, db, now: () => new Date('2026-10-09T00:00:00Z'), ...options });
    t.after(() => { db.close(); writer.close(); fs.rmSync(root, { recursive: true, force: true }); });
    return { root, file, db, writer, write, service };
}
const fails = (fn, code, status) => assert.throws(fn, error => error.code === code && error.status === status && error.message === errorEnvelope(error).error.message);

test('DTO allowlist, canonical URLs, ordering, counts and private boundaries are shared by staging and reads', t => {
    const { service, writer } = fixture(t);
    const page = service.list({ kind: 'notes', limit: 2 });
    assert.deepEqual(page.items.map(item => item.id), ['note-4', 'note-3']);
    assert.equal(page.count, 2); assert.equal(page.total_count, 5);
    assert.equal(page.generated_at, '2026-10-09T00:00:00.000Z');
    assert.equal(page.schema_version, 1);
    assert.equal(page.items[0].content_markdown, undefined);
    assert.equal(page.items[0].canonical_url, 'https://altena.me/portfolio/notes/note-4/');
    assert.equal(page.items[0].source_url, 'https://altena.me/portfolio/notes/note-4/index.html');
    const detail = service.get({ kind: 'notes', id: 'note-4' });
    const staged = noteDto(writer.prepare("SELECT * FROM articles WHERE id='note-4'").get());
    assert.deepEqual(staged, detail.item);
    assert.deepEqual(noteDto({ ...writer.prepare("SELECT * FROM articles WHERE id='note-4'").get(), tags: ['ＬＩＮＵＸ'] }), staged);
    assert.match(detail.item.content_markdown, /fulltextneedle/);
    assert.doesNotMatch(JSON.stringify(detail), /share_version|visibility|created_at/);
    for (const id of ['draft', 'unlisted', 'missing', 'bad/id', '../secret']) fails(() => service.get({ kind: 'notes', id }), 'not_found', 404);
    assert.equal(service.list({ kind: 'notes', q: 'SECRET' }).total_count, 0);
    assert.equal(service.list({ kind: 'works' }).total_count, 1);
    fails(() => service.get({ kind: 'works', id: 'work-template' }), 'not_found', 404);
    for (const kind of ['skills', 'timeline']) {
        const result = service.list({ kind });
        assert.equal(result.items[0].updated_at, null); assert.equal(result.items[0].updated_at_basis, 'not-tracked');
    }
    assert.equal(service.list({ kind: 'timeline' }).items[0].href, null);
    const index = service.markdown({ kind: 'index' });
    assert.match(index, /公開プロフィール[\s\S]*活動分野[\s\S]*works\.md[\s\S]*notes\.md/);
    assert.doesNotMatch(index, /SECRET|visibility|share_version/);
    assert.match(service.markdown({ kind: 'notes', id: 'note-4' }), new RegExp('revision: ' + detail.item.revision));
    assert.match(service.markdown({ kind: 'notes' }), /list_public_content[\s\S]*next_cursor[\s\S]*search_public_content/);
});

test('Unicode search is literal, bounded by codepoints and applies to all public search fields', t => {
    const { service } = fixture(t);
    assert.equal(service.list({ kind: 'notes', q: '  abc  ' }).total_count, 1);
    assert.equal(service.list({ kind: 'notes', q: 'linux' }).total_count, 5);
    assert.equal(service.list({ kind: 'notes', q: 'fulltextneedle' }).total_count, 5);
    assert.equal(service.list({ kind: 'works', q: 'ABC' }).total_count, 1);
    assert.equal(service.list({ kind: 'notes', q: '🧪'.repeat(120) }).count, 0);
    assert.equal(service.list({ kind: 'notes', q: '　 ' }).query, '');
    for (const q of ['🧪'.repeat(121), 'a\n', 'a\u0000', [], {}]) fails(() => service.list({ kind: 'notes', q }), 'invalid_request', 400);
    fails(() => service.list({ kind: 'skills', q: '' }), 'invalid_request', 400);
    for (const limit of [0, -1, 1.5, 51, 'abc', '01', null, []]) fails(() => service.list({ kind: 'notes', limit }), 'invalid_request', 400);
    assert.deepEqual(service.list({ kind: 'notes', q: 'missing' }).items, []);
    assert.equal(service.list({ kind: 'notes', q: 'missing' }).next_cursor, null);
});

test('compact public dates share canonical DTOs and chronological cursor keys with ISO and slash dates', t => {
    const { service, writer, write } = fixture(t);
    const originalEvent = service.list({ kind: 'timeline' }).items[0];
    writer.prepare('UPDATE timeline SET date=? WHERE id=?').run('20261009', 'event-a');
    assert.deepEqual(service.list({ kind: 'timeline' }).items[0], originalEvent);
    const insert = writer.prepare('INSERT INTO timeline VALUES (?,?,?,?,?)');
    for (const [id, date] of [['compact', '20260101'], ['slash', '2026/08/11'], ['iso', '2026-07-01'], ['leap', '20240229'], ['missing', '']]) {
        insert.run(id, date, id, 'public', null);
    }
    const first = service.list({ kind: 'timeline', limit: 2 });
    assert.deepEqual(first.items.map(item => [item.id, item.date]), [['event-a', '2026-10-09'], ['slash', '2026-08-11']]);
    assert.deepEqual(JSON.parse(Buffer.from(first.next_cursor, 'base64url')).last, ['2026-08-11', 'slash']);
    const rest = service.list({ kind: 'timeline', limit: 2, cursor: first.next_cursor });
    assert.deepEqual(rest.items.map(item => [item.id, item.date]), [['iso', '2026-07-01'], ['compact', '2026-01-01']]);
    assert.equal(service.list({ kind: 'timeline' }).items.at(-1).date, null);
    assert.match(service.markdown({ kind: 'timeline' }), /2024-02-29 — leap/);

    write('myworks.html', '<div class="page-tile-container"><a class="page-tile-item" href="works/work-a/index.html"><h3>Compact</h3><span class="note-date">20260101</span><p>Older</p></a><a class="page-tile-item" href="works/work-b/index.html"><h3>Slash</h3><span class="note-date">2026/08/11</span><p>Newer</p></a></div>');
    write('works/work-b/index.html', '<div class="project-desc"><p>Body</p></div>');
    const works = service.list({ kind: 'works', limit: 1 });
    assert.deepEqual(works.items.map(item => [item.id, item.date]), [['work-b', '2026-08-11']]);
    assert.deepEqual(service.list({ kind: 'works', limit: 1, cursor: works.next_cursor }).items.map(item => [item.id, item.date]), [['work-a', '2026-01-01']]);

    const note = writer.prepare("SELECT * FROM articles WHERE id='note-4'").get();
    assert.deepEqual(noteDto({ ...note, date: '20261009' }), noteDto(note));
    for (const invalid of ['20260230', '20260229', '20261301', '2026011', '2026 0101', ' 20260101', '２０２６０１０１']) {
        writer.prepare('UPDATE timeline SET date=? WHERE id=?').run(invalid, 'compact');
        fails(() => service.list({ kind: 'timeline' }), 'source_unavailable', 503);
    }
});

test('cursor remains bounded when NFKC expands a valid 120-codepoint query', t => {
    const { service, writer } = fixture(t);
    const query = '\ufdfa'.repeat(120);
    writer.prepare('UPDATE articles SET content=? WHERE visibility=\'public\' AND id IN (?,?)').run(`<p>${query}</p>`, 'note-4', 'note-3');
    const first = service.list({ kind: 'notes', q: query, limit: 1 });
    assert.equal(first.total_count, 2); assert.ok(Buffer.byteLength(first.next_cursor) <= 2048);
    assert.equal(service.list({ kind: 'notes', q: query, limit: 1, cursor: first.next_cursor }).items[0].id, 'note-3');
});

test('cursor pages have no repeats or gaps, ignore private edits, and expire after public content or ordering changes', t => {
    const { service, writer } = fixture(t);
    const first = service.list({ kind: 'notes', limit: 2 });
    writer.prepare("UPDATE articles SET title='private changed',content='private changed' WHERE visibility!='public'").run();
    const second = service.list({ kind: 'notes', limit: 2, cursor: first.next_cursor });
    const third = service.list({ kind: 'notes', limit: 2, cursor: second.next_cursor });
    assert.deepEqual([...first.items, ...second.items, ...third.items].map(item => item.id), ['note-4', 'note-3', 'note-2', 'note-1', 'note-0']);
    assert.equal(third.next_cursor, null);
    for (const input of [{ kind: 'works' }, { q: 'changed' }, { limit: 3 }]) fails(() => service.list({ kind: 'notes', limit: 2, cursor: first.next_cursor, ...input }), 'invalid_cursor', 400);
    for (const cursor of ['', 'x'.repeat(2049), '*', Buffer.from('{}').toString('base64url')]) fails(() => service.list({ kind: 'notes', cursor }), 'invalid_cursor', 400);
    writer.prepare("UPDATE articles SET visibility='draft' WHERE id='note-4'").run();
    fails(() => service.list({ kind: 'notes', limit: 2, cursor: first.next_cursor }), 'cursor_expired', 409);
    fails(() => service.get({ kind: 'notes', id: 'note-4' }), 'not_found', 404);
    assert.equal(service.list({ kind: 'notes' }).total_count, 4);
    const skills = service.list({ kind: 'skills', limit: 1 });
    writer.prepare("UPDATE skills SET sort_order=0 WHERE id='skill-b'").run();
    fails(() => service.list({ kind: 'skills', limit: 1, cursor: skills.next_cursor }), 'cursor_expired', 409);
    const current = service.list({ kind: 'notes', limit: 1 });
    writer.prepare("UPDATE articles SET content='<p>Public change</p>' WHERE id='note-0'").run();
    fails(() => service.list({ kind: 'notes', limit: 1, cursor: current.next_cursor }), 'cursor_expired', 409);
});

test('file mtimes and generated time do not change revisions; public edits do', t => {
    const { root, service, write, db } = fixture(t);
    const before = service.get({ kind: 'works', id: 'work-a' }).item;
    fs.utimesSync(path.join(root, 'works/work-a/index.html'), new Date('2030-01-01'), new Date('2030-01-01'));
    const after = service.get({ kind: 'works', id: 'work-a' }).item;
    assert.equal(after.revision, before.revision); assert.notEqual(after.source_modified_at, before.source_modified_at);
    const other = createPublicService({ root, db, now: () => new Date('2040-01-01') });
    assert.equal(other.get({ kind: 'works', id: 'work-a' }).item.revision, after.revision);
    write('works/work-a/index.html', '<div class="project-desc"><p>Public changed</p></div>');
    assert.notEqual(service.get({ kind: 'works', id: 'work-a' }).item.revision, after.revision);
});

test('one SQLite snapshot supplies source bounds, count, revision and page during concurrent revocation', t => {
    const { db, writer, service } = fixture(t);
    const prepare = db.prepare.bind(db);
    let revoked = false;
    db.prepare = sql => {
        const statement = prepare(sql);
        if (/SELECT count\(\*\)/.test(sql) && sql.includes('FROM articles')) {
            const get = statement.get.bind(statement);
            statement.get = (...args) => {
                const result = get(...args);
                if (!revoked) { revoked = true; writer.prepare("UPDATE articles SET visibility='draft' WHERE id='note-4'").run(); }
                return result;
            };
        }
        return statement;
    };
    const first = service.list({ kind: 'notes', limit: 1 });
    assert.equal(first.total_count, 5); assert.equal(first.items[0].id, 'note-4');
    assert.equal(service.list({ kind: 'notes' }).total_count, 4);
    fails(() => service.list({ kind: 'notes', limit: 1, cursor: first.next_cursor }), 'cursor_expired', 409);
});

test('bounded files, bodies, datasets and outputs fail generically without partial results or path leaks', t => {
    const { root, db, service, writer, write } = fixture(t);
    for (const limits of [{ maxItems: 4 }, { maxBodyBytes: 4 }, { maxDatasetBytes: 5 }, { maxOutputBytes: 5 }]) {
        const bounded = createPublicService({ root, db, limits });
        fails(() => bounded.list({ kind: 'notes' }), 'source_unavailable', 503);
    }
    fails(() => createPublicService({ root, db, limits: { maxFileBytes: 5 } }).get({ kind: 'profile' }), 'source_unavailable', 503);
    fails(() => createPublicService({ root, db, limits: { typo: 1 } }), 'invalid_request', 400);
    fails(() => createPublicService({ root, db, now: () => null }).list({ kind: 'notes' }), 'source_unavailable', 503);
    writer.prepare("UPDATE articles SET content=? WHERE id='note-0'").run('X'.repeat(1024));
    fails(() => createPublicService({ root, db, limits: { maxBodyBytes: 100 } }).list({ kind: 'notes' }), 'source_unavailable', 503);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'portfolio-json-outside-'));
    t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
    fs.writeFileSync(path.join(outside, 'secret.html'), '<div class="project-desc">OUTSIDE_SECRET</div>');
    fs.unlinkSync(path.join(root, 'works/work-a/index.html'));
    fs.symlinkSync(path.join(outside, 'secret.html'), path.join(root, 'works/work-a/index.html'));
    fails(() => service.list({ kind: 'works' }), 'source_unavailable', 503);
    assert.deepEqual(errorEnvelope(new Error('SQL /secret/path PRIVATE')), { schema_version: 1, error: { code: 'source_unavailable', message: 'Source unavailable' } });
    write('myworks.html', '<html>Missing extraction source</html>');
    fails(() => service.list({ kind: 'works' }), 'source_unavailable', 503);
    write('myworks.html', '<div class="page-tile-container"></div>');
    assert.equal(service.list({ kind: 'works' }).total_count, 0);
});

test('HTTP rejects duplicate, malformed and unknown query, enforces GET/HEAD and never returns automatic 304', async t => {
    const { service, writer } = fixture(t);
    const app = express();
    app.use('/agent/api/public', createPublicRouter({ service }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    t.after(async () => { await new Promise(resolve => server.close(resolve)); });
    const get = (route, options) => fetch(`http://127.0.0.1:${server.address().port}/agent/api/public${route}`, options);
    for (const url of ['', '/openapi.json', '/profile', '/works', '/notes', '/skills', '/timeline', '/works/work-a', '/notes/note-4']) {
        const response = await get(url, { headers: { 'If-None-Match': '*' } });
        assert.equal(response.status, 200, url); assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.match(response.headers.get('content-type'), /^application\/json; charset=utf-8$/);
        assert.equal(response.headers.get('etag'), null);
        const head = await get(url, { method: 'HEAD', headers: { 'If-None-Match': '*' } });
        assert.equal(head.status, 200); assert.equal(await head.text(), '');
        assert.ok(Number(head.headers.get('content-length')) > 0);
    }
    for (const url of ['/notes?q=x&q=y', '/notes?q[]=x', '/notes?limit=1&limit=2', '/notes?cursor=x&cursor=y', '/notes?unknown=x', '/notes?q=%ZZ', '/notes?q=%FF', '/skills?q=x', '/profile?id=altena', '/notes/note-4?q=x']) {
        const response = await get(url); assert.equal(response.status, 400, url);
        assert.deepEqual(await response.json(), errorEnvelope(publicError('invalid_request')));
    }
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
        const response = await get('/notes', { method });
        assert.equal(response.status, 405); assert.equal(response.headers.get('allow'), 'GET, HEAD');
    }
    for (const url of ['/notes/draft', '/notes/unlisted', '/notes/..%2Fsecret', '/works/work-template', '/private']) {
        const response = await get(url, { headers: { Authorization: 'Bearer unused', 'X-Note-Share': 'unused', 'If-None-Match': '*' } });
        assert.equal(response.status, 404, url); assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.deepEqual(await response.json(), errorEnvelope(publicError('not_found')));
    }
    writer.prepare("UPDATE articles SET visibility='unlisted' WHERE id='note-4'").run();
    const revoked = await get('/notes/note-4', { headers: { 'If-None-Match': '*' } });
    assert.equal(revoked.status, 404);
});

test('published OpenAPI uses the exact shared schema objects and exposes only retrieval methods', () => {
    const document = require('../docs/superpowers/api/public-openapi.json');
    assert.deepEqual(document.components.schemas.List, LIST_SCHEMA);
    assert.deepEqual(document.components.schemas.Detail, DETAIL_SCHEMA);
    assert.deepEqual(document.components.schemas.Error, ERROR_SCHEMA);
    assert.equal(document.openapi, '3.1.0');
    for (const route of Object.values(document.paths)) assert.deepEqual(Object.keys(route), ['get', 'head']);
});
