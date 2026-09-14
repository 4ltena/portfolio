'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { DatabaseSync } = require('node:sqlite');
const { createArticleCovers, PATTERN_COUNT } = require('./article-covers');
const { publishArticle } = require('./publish-article');

function database(filename = ':memory:') {
    const db = new DatabaseSync(filename);
    // 本番のbetter-sqlite3と同じトランザクション境界を実SQLiteで検証する。
    db.transaction = callback => (...args) => {
        db.exec('BEGIN');
        try { const result = callback(...args); db.exec('COMMIT'); return result; }
        catch (error) { db.exec('ROLLBACK'); throw error; }
    };
    db.exec(`CREATE TABLE IF NOT EXISTS articles (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, date TEXT NOT NULL,
        tags TEXT NOT NULL, excerpt TEXT, content TEXT NOT NULL, created_at INTEGER NOT NULL
    )`);
    return db;
}
function article(id, createdAt = 1) {
    return { id, title: id, date: '2026/09/14', tags: ['Test'], excerpt: '', content: 'content', createdAt };
}
function insert(db, value) {
    db.prepare('INSERT INTO articles VALUES (?,?,?,?,?,?,?)').run(value.id, value.title,
        value.date, JSON.stringify(value.tags), value.excerpt, value.content, value.createdAt);
}

test('new assignments exclude the last three and current latest three', () => {
    const db = database();
    let seed = 42;
    const covers = createArticleCovers(db, length => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed % length;
    });
    const history = [], used = new Set();
    for (let i = 0; i < 1000; i++) {
        const id = `article-${i}`;
        insert(db, article(id, i));
        const pattern = covers.assign(id);
        assert(!history.slice(-3).includes(pattern));
        history.push(pattern);
        used.add(pattern);
        const latest = db.prepare(`SELECT c.cover_pattern FROM articles a JOIN article_covers c
            ON c.article_id=a.id ORDER BY a.created_at DESC,a.id DESC LIMIT 3`).all();
        assert.equal(new Set(latest.map(a => a.cover_pattern)).size, latest.length);
        assert.equal(covers.assign(id), pattern);
    }
    assert.equal(used.size, PATTERN_COUNT);
    db.close();
});

test('legacy ties, edits, deletion history and restart preserve assignments', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'portfolio-covers-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const filename = path.join(directory, 'test.db');
    let db = database(filename);
    for (const id of ['c', 'a', 'b']) insert(db, article(id));
    createArticleCovers(db, () => 0);
    const before = db.prepare('SELECT * FROM article_covers ORDER BY assignment_order').all();
    assert.deepEqual(before.map(row => row.article_id), ['a', 'b', 'c']);
    db.prepare("UPDATE articles SET title='edited' WHERE id='a'").run();
    db.prepare("DELETE FROM articles WHERE id='b'").run();
    db.close();
    db = database(filename);
    const covers = createArticleCovers(db, () => { throw new Error('Must not reroll'); });
    assert.deepEqual(db.prepare('SELECT * FROM article_covers ORDER BY assignment_order').all(), before);
    assert.equal(covers.assign('a'), before[0].cover_pattern);
    assert.throws(() => db.prepare('INSERT INTO article_covers(article_id,cover_pattern) VALUES (?,?)').run('invalid', 10));
    assert.throws(() => db.prepare('INSERT INTO article_covers(article_id,cover_pattern) VALUES (?,?)').run('fraction', 1.5));
    db.close();
});

test('failed publishing rolls back both rows and removes only newly created output', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'portfolio-publish-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const db = database();
    t.after(() => db.close());
    const covers = createArticleCovers(db, () => 0);
    const good = path.join(directory, 'good');
    assert.equal(publishArticle(db, covers, article('good'), good, '<p>saved</p>'), 0);
    const before = db.prepare('SELECT * FROM article_covers').all();

    const broken = path.join(directory, 'broken');
    const io = { ...fs, writeFileSync(filename) {
        fs.writeFileSync(filename, 'partial');
        const error = new Error('Disk full'); error.code = 'ENOSPC'; throw error;
    } };
    assert.throws(() => publishArticle(db, covers, article('broken', 2), broken, 'html', io));
    assert.equal(fs.existsSync(broken), false);
    assert.equal(db.prepare("SELECT id FROM articles WHERE id='broken'").get(), undefined);
    assert.deepEqual(db.prepare('SELECT * FROM article_covers').all(), before);

    const duplicate = path.join(directory, 'duplicate');
    assert.throws(() => publishArticle(db, covers, article('good', 3), duplicate, 'html'));
    assert.equal(fs.existsSync(duplicate), false);
    assert.deepEqual(db.prepare('SELECT * FROM article_covers').all(), before);
    assert.throws(() => publishArticle(db, covers, article('collision', 4), good, 'overwrite'));
    assert.equal(fs.readFileSync(path.join(good, 'index.html'), 'utf8'), '<p>saved</p>');
    assert.equal(db.prepare("SELECT id FROM articles WHERE id='collision'").get(), undefined);
});

test('server pattern IDs match the unchanged ten-template renderer', () => {
    const context = vm.createContext({});
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/cover-art.js'), 'utf8'), context);
    assert.equal(vm.runInContext('PastelCover.patterns.length', context), PATTERN_COUNT);
    for (let pattern = 0; pattern < PATTERN_COUNT; pattern++) {
        const source = `PastelCover.render('article-safe', 3, 0, ${pattern})`;
        const svg = vm.runInContext(source, context);
        assert.equal(vm.runInContext(source, context), svg);
        assert(svg.includes(`data-composition="${pattern}"`));
        assert(!/NaN|undefined/.test(svg));
    }
});
