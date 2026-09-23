const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const editor = read('admin/editor.html');
const sharedShell = read('shared-note.html');
const sharedScript = read('js/shared-note.js');
const utils = read('js/utils.js');
const lite = read('lite.html');

test('publication desk uses the private admin article contract', () => {
  assert.match(editor, /\/portfolio\/api\/admin\/articles/);
  assert.match(editor, /\/share-link/);
  assert.match(editor, /\/share\/rotate/);
  assert.match(editor, /\/cover\/reroll/);
  assert.doesNotMatch(editor, /fetch\('\/portfolio\/api\/articles', \{ headers: authHeader\(\) \}\)/);
});

test('publication desk expresses all visibility states and irreversible-public warning', () => {
  for (const visibility of ['public', 'unlisted', 'draft']) {
    assert.match(editor, new RegExp(`value="${visibility}"`));
  }
  assert.match(editor, /外部キャッシュ/);
  assert.match(editor, /過去cacheは回収不能|第三者アーカイブから本文を完全には回収できません/);
  assert.match(editor, /value="draft" checked/);
  assert.match(editor, /role="status" aria-live="polite"/);
  assert.match(editor, /role="tablist"/);
});

test('markdown preview has a pinned sanitizer boundary', () => {
  assert.match(editor, /dompurify@3\.2\.6/);
  assert.match(editor, /integrity="sha384-JEyTNhjM6R1ElGoJns4U2Ln4ofPcqzSsynQkmEc\/KGy6336qAZl70tDLufbkla\+3" crossorigin="anonymous"/);
  assert.match(editor, /DOMPurify\.sanitize/);
  assert.match(editor, /FORBID_TAGS/);
  assert.match(editor, /安全なプレビューを読み込めませんでした/);
});

test('narrow publication settings can collapse while the save bar preserves state', () => {
  assert.match(editor, /publication-details/);
  assert.match(editor, /max-width: 390px/);
  assert.match(editor, /publicationDetails\.open = false/);
  assert.match(editor, /save-visibility/);
});

test('shared note shell keeps the signature in a fragment and sends it only in a header', () => {
  assert.match(sharedShell, /noindex,nofollow,noarchive/);
  assert.match(sharedShell, /Referrer-Policy/);
  assert.match(sharedShell, /default-src 'self'; script-src 'self'; connect-src 'self'/);
  assert.doesNotMatch(sharedShell, /fonts\.googleapis\.com|fonts\.gstatic\.com/);
  assert.match(sharedScript, /location\.hash\.slice\(1\)/);
  assert.match(sharedScript, /X-Note-Share/);
  assert.match(sharedScript, /\/portfolio\/api\/shared-articles\//);
  assert.doesNotMatch(sharedScript, /\?signature=/);
});

test('admin normalizes returned share links to absolute URLs before display or copy', () => {
  const normalizations = editor.match(/new URL\(data\.url, location\.origin\)\.href/g) || [];
  assert.equal(normalizations.length, 2);
  assert.match(editor, /shareLinkInput\.value = url/);
  assert.doesNotMatch(editor, /shareLinkInput\.value = data\.url \|\| ''/);
});

test('admin formats epoch updatedAt as readable JST and handles missing values', () => {
  assert.match(editor, /function formatUpdatedAt\(value\)/);
  assert.match(editor, /timeZone: 'Asia\/Tokyo'/);
  assert.match(editor, /return '—';/);
  assert.match(editor, /formatUpdatedAt\(a\.updatedAt \?\? a\.updated_at\)/);
});

test('admin normalizes compact note dates and rejects impossible full dates', () => {
  const start = editor.indexOf('function formatCompactDate');
  const end = editor.indexOf('\n    function normalizeDateField', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const context = {};
  vm.runInNewContext(`${editor.slice(start, end)}\nthis.formatCompactDate = formatCompactDate;`, context);
  assert.equal(context.formatCompactDate('20260811', true), '2026/08/11');
  assert.equal(context.formatCompactDate('2026/02/30', true), null);
  assert.equal(context.formatCompactDate('2026/08/11', true), '2026/08/11');
  assert.equal(context.formatCompactDate('2026/08', false), '2026/08');
});

test('updatedAt formatter renders only valid epoch values', () => {
  const match = editor.match(/function formatUpdatedAt\(value\) \{[\s\S]*?\n    \}(?=\n    function updateDeskFilters)/);
  assert.ok(match, 'formatUpdatedAt must be extractable');
  const context = { Intl, Date };
  vm.createContext(context);
  vm.runInContext(`${match[0]}; globalThis.formatUpdatedAt = formatUpdatedAt;`, context);
  assert.equal(context.formatUpdatedAt(null), '—');
  assert.equal(context.formatUpdatedAt(undefined), '—');
  assert.equal(context.formatUpdatedAt(''), '—');
  assert.equal(context.formatUpdatedAt('invalid'), '—');
  assert.equal(context.formatUpdatedAt(0), '1970/01/01 09:00');
});

test('unknown editor visibility safely falls back to draft', () => {
  assert.match(editor, /input\.checked\)\?\.value \|\| 'draft'/);
  assert.match(editor, /includes\(value\) \? value : 'draft'/);
  assert.match(editor, /\}\)\[value\] \|\| '下書き'/);
  assert.doesNotMatch(editor, /article\.visibility \|\| 'public'/);
  assert.match(editor, /article\.visibility \|\| 'draft'/);
});

test('public note consumers use the server-returned article url', () => {
  assert.match(utils, /article\.url/);
  assert.doesNotMatch(utils, /`\/portfolio\/notes\/\$\{escHtml\(article\.id\)\}/);
  assert.match(lite, /window\.location\.assign\(article\.url\)/);
  assert.doesNotMatch(lite, /\/portfolio\/api\/articles\/\$\{article\.id\}/);
});
