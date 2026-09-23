'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dependenciesAvailable = (() => {
    try {
        require.resolve('express'); require.resolve('jsonwebtoken');
        const Database = require('better-sqlite3');
        const probe = new Database(':memory:'); probe.close();
        return true;
    }
    catch { return false; }
})();

test('request contract exposes only public URLs to unauthenticated readers', { skip: !dependenciesAvailable }, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'portfolio-api-contract-'));
    const old = {
        PORTFOLIO_ROOT: process.env.PORTFOLIO_ROOT,
        PORTFOLIO_DATA_DIR: process.env.PORTFOLIO_DATA_DIR,
        PORTFOLIO_NOTES_OUT_DIR: process.env.PORTFOLIO_NOTES_OUT_DIR,
        PORTFOLIO_IMG_DIR: process.env.PORTFOLIO_IMG_DIR
    };
    process.env.PORTFOLIO_ROOT = root;
    process.env.PORTFOLIO_DATA_DIR = path.join(root, 'data');
    process.env.PORTFOLIO_NOTES_OUT_DIR = path.join(root, 'notes');
    process.env.PORTFOLIO_IMG_DIR = path.join(root, 'img');
    fs.mkdirSync(process.env.PORTFOLIO_DATA_DIR, { recursive: true });
    const configFile = path.join(process.env.PORTFOLIO_DATA_DIR, 'config.json');
    fs.writeFileSync(configFile, JSON.stringify({ passwordHash: 'unused', jwtSecret: 'contract-test-secret' }), { mode: 0o644 });
    const serverPath = require.resolve('./server');
    delete require.cache[serverPath];
    const initial = require('./server');
    const persistedConfig = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    assert.equal(persistedConfig.shareSecret, initial.config.shareSecret);
    assert.equal(fs.statSync(configFile).mode & 0o777, 0o600);
    let db = initial.db;
    let listener = initial.app.listen(0, '127.0.0.1');
    await new Promise(resolve => listener.once('listening', resolve));
    const base = `http://127.0.0.1:${listener.address().port}`;
    const jwt = require('jsonwebtoken');
    const auth = { Authorization: `Bearer ${jwt.sign({ admin: true }, initial.config.jwtSecret)}`, 'Content-Type': 'application/json' };
    t.after(() => {
        if (listener?.listening) listener.close();
        try { db?.close(); } catch { /* already closed after restart */ }
        fs.rmSync(root, { recursive: true, force: true });
        for (const [key, value] of Object.entries(old)) value === undefined ? delete process.env[key] : process.env[key] = value;
        delete require.cache[serverPath];
    });
    const create = async visibility => {
        const response = await fetch(`${base}/admin/articles`, { method: 'POST', headers: auth, body: JSON.stringify({ title: visibility, date: '2026/09/22', tags: [], excerpt: '', content: '<p>x</p>', visibility }) });
        assert.equal(response.status, 201, await response.clone().text());
        return response.json();
    };
    const publicArticle = await create('public');
    const privateArticle = await create('unlisted');
    assert.match(publicArticle.url, /^\/portfolio\/notes\//);
    assert.equal(privateArticle.url, null);
    const publicList = await (await fetch(`${base}/articles`)).json();
    assert.equal(publicList.length, 1);
    assert.equal(publicList[0].id, publicArticle.id);
    assert.equal((await fetch(`${base}/articles/${privateArticle.id}`)).status, 404);

    // Stop after filesystem preparation but before the database commit: staging is discarded and
    // a quarantined public page is restored at its original URL.
    const publicOutput = path.join(root, 'notes', publicArticle.id);
    const pendingStage = path.join(root, 'notes', `.${publicArticle.id}.pending-restart`);
    const pendingQuarantine = path.join(root, 'notes', `.${publicArticle.id}.quarantine-pending`);
    fs.mkdirSync(pendingStage); fs.writeFileSync(path.join(pendingStage, '.portfolio-note-managed-v1'), `article:${publicArticle.id}\n`); fs.writeFileSync(path.join(pendingStage, 'index.html'), 'staged');
    fs.renameSync(publicOutput, pendingQuarantine);
    const now = Date.now();
    db.prepare(`INSERT INTO article_publication_jobs (article_id,operation,target_visibility,stage,expected_updated_at,content_hash,created_at,updated_at)
        VALUES (?,?,?,'pending',?,?,?,?)`).run(publicArticle.id, 'unpublish', 'unlisted', now, 'pending-test', now, now);
    await new Promise(resolve => listener.close(resolve));
    listener = null;
    db.close(); db = null;
    delete require.cache[serverPath];
    let restarted = require('./server');
    db = restarted.db;
    assert.equal(fs.existsSync(publicOutput), true);
    assert.equal(fs.existsSync(pendingQuarantine), false);
    assert.equal(fs.existsSync(pendingStage), false);

    // Recreate a process stop after the DB commit but before a restricted page is removed.
    const quarantine = path.join(root, 'notes', `.${publicArticle.id}.quarantine-restart`);
    fs.renameSync(publicOutput, quarantine);
    db.prepare("UPDATE articles SET visibility='unlisted',updated_at=? WHERE id=?").run(now, publicArticle.id);
    db.prepare(`INSERT INTO article_publication_jobs (article_id,operation,target_visibility,stage,expected_updated_at,content_hash,created_at,updated_at)
        VALUES (?,?,?,'database_committed',?,?,?,?)`).run(publicArticle.id, 'unpublish', 'unlisted', now, 'restart-test', now, now);
    db.close();
    db = null;
    delete require.cache[serverPath];
    restarted = require('./server');
    db = restarted.db;
    assert.equal(fs.existsSync(publicOutput), false);
    assert.equal(fs.existsSync(quarantine), false);
    assert.equal(db.prepare("SELECT stage FROM article_publication_jobs WHERE article_id=? ORDER BY id DESC LIMIT 1").get(publicArticle.id).stage, 'complete');
});

test('post-commit filesystem failures restore the prior article, cover and public output', { skip: !dependenciesAvailable }, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'portfolio-api-compensation-'));
    const old = {
        PORTFOLIO_ROOT: process.env.PORTFOLIO_ROOT,
        PORTFOLIO_DATA_DIR: process.env.PORTFOLIO_DATA_DIR,
        PORTFOLIO_NOTES_OUT_DIR: process.env.PORTFOLIO_NOTES_OUT_DIR,
        PORTFOLIO_IMG_DIR: process.env.PORTFOLIO_IMG_DIR,
        ADMIN_PASSWORD: process.env.ADMIN_PASSWORD,
        PORTFOLIO_TEST_PUBLICATION_FAILURE: process.env.PORTFOLIO_TEST_PUBLICATION_FAILURE,
        NODE_ENV: process.env.NODE_ENV
    };
    process.env.PORTFOLIO_ROOT = root;
    process.env.PORTFOLIO_DATA_DIR = path.join(root, 'data');
    process.env.PORTFOLIO_NOTES_OUT_DIR = path.join(root, 'notes');
    process.env.PORTFOLIO_IMG_DIR = path.join(root, 'img');
    process.env.ADMIN_PASSWORD = 'test-only-password-123';
    process.env.NODE_ENV = 'test';
    delete process.env.PORTFOLIO_TEST_PUBLICATION_FAILURE;
    const serverPath = require.resolve('./server');
    delete require.cache[serverPath];
    const server = require('./server');
    const { app, db, config } = server;
    const listener = app.listen(0, '127.0.0.1');
    await new Promise(resolve => listener.once('listening', resolve));
    const base = `http://127.0.0.1:${listener.address().port}`;
    const jwt = require('jsonwebtoken');
    const auth = { Authorization: `Bearer ${jwt.sign({ admin: true }, config.jwtSecret)}`, 'Content-Type': 'application/json' };
    t.after(async () => {
        delete process.env.PORTFOLIO_TEST_PUBLICATION_FAILURE;
        if (listener.listening) await new Promise(resolve => listener.close(resolve));
        try { db.close(); } catch { /* already closed */ }
        fs.rmSync(root, { recursive: true, force: true });
        for (const [key, value] of Object.entries(old)) value === undefined ? delete process.env[key] : process.env[key] = value;
        delete require.cache[serverPath];
    });

    const body = (title, visibility = 'public') => ({
        title, date: '2026/09/22', tags: ['Test'], excerpt: `${title} excerpt`, content: `<p>${title}</p>`, visibility
    });
    const request = (url, method, payload) => fetch(`${base}${url}`, {
        method, headers: auth, body: payload === undefined ? undefined : JSON.stringify(payload)
    });

    process.env.PORTFOLIO_TEST_PUBLICATION_FAILURE = 'promote';
    const failedCreate = await request('/admin/articles', 'POST', body('failed create'));
    assert.equal(failedCreate.status, 400);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM articles').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM article_covers').get().n, 0);
    assert.deepEqual(fs.readdirSync(process.env.PORTFOLIO_NOTES_OUT_DIR), []);

    delete process.env.PORTFOLIO_TEST_PUBLICATION_FAILURE;
    const createdResponse = await request('/admin/articles', 'POST', body('stable public'));
    assert.equal(createdResponse.status, 201, await createdResponse.clone().text());
    const created = await createdResponse.json();
    const output = path.join(process.env.PORTFOLIO_NOTES_OUT_DIR, created.id, 'index.html');
    const priorRow = db.prepare('SELECT * FROM articles WHERE id=?').get(created.id);
    const priorCover = db.prepare('SELECT * FROM article_covers WHERE article_id=?').get(created.id);
    const priorHtml = fs.readFileSync(output, 'utf8');
    const assertRestored = () => {
        assert.deepEqual(db.prepare('SELECT * FROM articles WHERE id=?').get(created.id), priorRow);
        assert.deepEqual(db.prepare('SELECT * FROM article_covers WHERE article_id=?').get(created.id), priorCover);
        assert.equal(fs.readFileSync(output, 'utf8'), priorHtml);
        assert.equal(db.prepare("SELECT stage FROM article_publication_jobs WHERE article_id=? ORDER BY id DESC LIMIT 1").get(created.id).stage, 'complete');
    };

    process.env.PORTFOLIO_TEST_PUBLICATION_FAILURE = 'remove';
    const failedUnpublish = await request(`/admin/articles/${created.id}`, 'PUT', body('restricted update', 'unlisted'));
    assert.equal(failedUnpublish.status, 400);
    assertRestored();

    process.env.PORTFOLIO_TEST_PUBLICATION_FAILURE = 'cleanup';
    const failedUpdate = await request(`/admin/articles/${created.id}`, 'PUT', body('replacement public'));
    assert.equal(failedUpdate.status, 400);
    assertRestored();

    process.env.PORTFOLIO_TEST_PUBLICATION_FAILURE = 'remove';
    const failedDelete = await request(`/admin/articles/${created.id}`, 'DELETE');
    assert.equal(failedDelete.status, 400);
    assertRestored();
});
