'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
    migrateNotesSchema, sanitizeHtml, normalizeArticlePayload,
    makeShareSignature, hasValidShareSignature, nextPublishedAt, articleView, writeStagedArticle,
    quarantineManagedDirectory, removeManagedDirectory, promoteStagedArticle, targetDirectory,
    assertPublishTargetManagedOrAbsent
} = require('./notes-publication');

function database() {
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE articles (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, date TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]',
        excerpt TEXT DEFAULT '', content TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER
    )`);
    db.prepare('INSERT INTO articles VALUES (?,?,?,?,?,?,?,?)').run('legacy', 'Legacy', '2026/09/22', '[]', '', '<p>old</p>', 1, null);
    db.transaction = callback => (...args) => { db.exec('BEGIN'); try { const result = callback(...args); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } };
    return db;
}

test('visibility migration is idempotent and backfills existing articles', () => {
    const db = database();
    assert.equal(migrateNotesSchema(db), true);
    const row = db.prepare('SELECT visibility,published_at,share_version FROM articles WHERE id=?').get('legacy');
    assert.deepEqual({ ...row }, { visibility: 'public', published_at: 1, share_version: 0 });
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='article_publication_jobs'").get().name, 'article_publication_jobs');
    assert.equal(migrateNotesSchema(db), false);
    db.close();
});

test('sanitizer strips executable content and rebuilds safe links', () => {
    const output = sanitizeHtml('<p onclick="x()">safe<script>alert(1)</script><a href="javascript:alert(1)">bad</a><a href="https://example.test/a" onclick="x">good</a></p>');
    assert.equal(output.includes('script'), false);
    assert.equal(output.includes('onclick'), false);
    assert.match(output, /<a>bad<\/a>/);
    assert.match(output, /href="https:\/\/example\.test\/a" rel="noopener noreferrer"/);
});

test('sanitizer preserves only self-hosted images and safe image attributes', () => {
    const output = sanitizeHtml('<img src="/portfolio/img/cover.png" alt="Cover" width="320" height="180" onclick="x"><img src="https://cdn.example.test/x.png" title="External"><img src="data:image/png;base64,x"><img src="javascript:alert(1)">');
    assert.match(output, /src="\/portfolio\/img\/cover\.png" alt="Cover" width="320" height="180"/);
    assert.match(output, /src="https:\/\/cdn\.example\.test\/x\.png" title="External"/);
    assert.equal((output.match(/<img/g) || []).length, 2);
    assert.equal(output.includes('onclick'), false);
});

test('sanitizer handles malformed HTML, tables, encodings, and active SVG/MathML safely', () => {
    const output = sanitizeHtml('<table><thead><tr><th colspan="2" onclick="x">A<th>B</thead><tbody><tr><td rowspan="2">&lt;safe<td>C</tbody></table><svg onload="x"><circle></circle></svg><math><mi>x</mi></math><p><img src="&#x6a;avascript:alert(1)">');
    assert.match(output, /<table>/);
    assert.match(output, /<th colspan="2">A<\/th><th>B<\/th>/);
    assert.match(output, /&lt;safe/);
    assert.equal(output.includes('<svg'), false);
    assert.equal(output.includes('<math'), false);
    assert.equal(output.includes('javascript:'), false);
    assert.equal(output.includes('onload'), false);
    assert.equal(output.includes('onclick'), false);
});

test('payload validation rejects server-owned and unsafe shape fields', () => {
    const valid = normalizeArticlePayload({ title: 'Title', date: '2026/09/22', tags: ['Notes'], excerpt: '', content: '<p>body</p>', visibility: 'draft' });
    assert.equal(valid.visibility, 'draft');
    assert.throws(() => normalizeArticlePayload({ ...valid, id: 'forged' }), /Unknown article field/);
    assert.throws(() => normalizeArticlePayload({ ...valid, visibility: 'secret' }), /Invalid visibility/);
});

test('payload validation enforces limits, real dates and unique tags', () => {
    const base = { title: 'T', date: '2026/09/22', tags: [' design ', 'design', 'infra'], excerpt: '', content: '<p>x</p>', visibility: 'draft' };
    assert.deepEqual(normalizeArticlePayload(base).tags, ['design', 'infra']);
    assert.throws(() => normalizeArticlePayload({ ...base, date: '2026/02/30' }), /Invalid date/);
    assert.throws(() => normalizeArticlePayload({ ...base, title: 'a'.repeat(161) }), /Invalid title/);
    assert.throws(() => normalizeArticlePayload({ ...base, excerpt: 'a'.repeat(501) }), /Invalid excerpt/);
    assert.throws(() => normalizeArticlePayload({ ...base, tags: ['a'.repeat(41)] }), /Invalid tags/);
});

test('published_at follows every visibility transition without erasing publication history', () => {
    const now = 200;
    assert.equal(nextPublishedAt(null, 'public', now), now);
    assert.equal(nextPublishedAt(null, 'draft', now), null);
    assert.equal(nextPublishedAt(null, 'unlisted', now), null);
    const publicRow = { visibility: 'public', published_at: 100 };
    assert.equal(nextPublishedAt(publicRow, 'public', now), 100);
    assert.equal(nextPublishedAt(publicRow, 'draft', now), 100);
    assert.equal(nextPublishedAt(publicRow, 'unlisted', now), 100);
    const draftRow = { visibility: 'draft', published_at: null };
    assert.equal(nextPublishedAt(draftRow, 'draft', now), null);
    assert.equal(nextPublishedAt(draftRow, 'unlisted', now), null);
    assert.equal(nextPublishedAt(draftRow, 'public', now), now);
    const unlistedRow = { visibility: 'unlisted', published_at: 100 };
    assert.equal(nextPublishedAt(unlistedRow, 'draft', now), 100);
    assert.equal(nextPublishedAt(unlistedRow, 'unlisted', now), 100);
    assert.equal(nextPublishedAt(unlistedRow, 'public', now), now);
});

test('share HMAC rejects malformed and stale signatures', () => {
    const secret = 'fixed-test-secret';
    const signature = makeShareSignature(secret, 'private-note', 1);
    assert.equal(hasValidShareSignature(secret, 'private-note', 1, signature), true);
    assert.equal(hasValidShareSignature(secret, 'private-note', 2, signature), false);
    assert.equal(hasValidShareSignature(secret, 'private-note', 1, 'short'), false);
});

test('article view only exposes a server-authoritative URL for public articles', () => {
    const row = { id: 'a'.repeat(128), title: 'T', date: '2026/09/22', tags: '[]', excerpt: '', content: '<p>x</p>', visibility: 'public', created_at: 1, updated_at: 1, published_at: 1 };
    assert.equal(articleView(row).url, `/portfolio/notes/${row.id}/`);
    assert.equal(articleView({ ...row, visibility: 'unlisted' }).url, null);
    assert.equal(articleView({ ...row, visibility: 'draft' }).url, null);
});

test('managed output uses marker, leaves unmanaged directories intact, and supports restart cleanup', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'portfolio-static-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const staged = writeStagedArticle(root, 'note', '<p>v1</p>');
    promoteStagedArticle(root, 'note', staged);
    const target = targetDirectory(root, 'note');
    assert.equal(fs.readFileSync(path.join(target, 'index.html'), 'utf8'), '<p>v1</p>');
    const quarantine = quarantineManagedDirectory(root, 'note');
    assert.equal(fs.existsSync(target), false);
    // This is the state a restart reconciliation observes after a restricted-state DB commit.
    assert.equal(removeManagedDirectory(quarantine, 'note'), true);
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'index.html'), 'user-owned');
    assert.throws(() => assertPublishTargetManagedOrAbsent(root, 'note'), /unmanaged/);
    assert.throws(() => removeManagedDirectory(target, 'note'), /unmanaged/);
    assert.equal(fs.readFileSync(path.join(target, 'index.html'), 'utf8'), 'user-owned');
});

test('rename and write failures preserve a public managed target', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'portfolio-static-fail-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const first = writeStagedArticle(root, 'note', '<p>old</p>');
    promoteStagedArticle(root, 'note', first);
    const target = targetDirectory(root, 'note');
    assert.throws(() => quarantineManagedDirectory(root, 'note', { ...fs, renameSync() { throw new Error('rename failed'); } }), /rename failed/);
    assert.equal(fs.readFileSync(path.join(target, 'index.html'), 'utf8'), '<p>old</p>');
    const staged = writeStagedArticle(root, 'note', '<p>new</p>');
    assert.throws(() => promoteStagedArticle(root, 'note', staged, { ...fs, renameSync(source, destination) {
        if (source === staged) throw new Error('activate failed');
        return fs.renameSync(source, destination);
    } }), /activate failed/);
    assert.equal(fs.readFileSync(path.join(target, 'index.html'), 'utf8'), '<p>old</p>');
    assert.equal(fs.existsSync(staged), true);
    assert.throws(() => writeStagedArticle(root, 'write-fail', '<p>x</p>', { ...fs, writeFileSync(filename, ...rest) {
        if (String(filename).endsWith('index.html')) throw new Error('write failed');
        return fs.writeFileSync(filename, ...rest);
    } }), /write failed/);
    assert.equal(fs.readdirSync(root).some(name => name.startsWith('.write-fail.pending-')), false);
});
