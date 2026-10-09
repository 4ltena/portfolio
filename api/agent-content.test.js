'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const { htmlToMarkdown } = require('./agent-content');
const { createPreview } = require('./agent-preview');

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'portfolio-agent-preview-'));
    const write = (name, value) => { const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); };
    write('index.html', '<div class="hero-foot"><span>Infrastructure</span><span class="hero-scroll">Scroll</span></div><section id="profile"><span class="brand">Altena</span><p class="philosophy">Alt &amp; Higher Standards</p><div class="bio"><p>公開プロフィール<br>二行目。</p></div><nav class="profile-social"><a href="https://github.com/4ltena">GitHub</a><a href="mailto:contact@altena.me">Mail</a></nav></section>');
    write('terminal/profile.txt', ' / / /|   Role    Software & Infrastructure Engineer\n / / / |          Frontend Developer / 3D Artist\n');
    write('myworks.html', '<a class="page-tile-item" href="works/public-work/index.html" data-tags="#Blender #3DCG"><span class="note-date">2026/04/11</span><h3>制作物</h3><p>公開作品</p></a><a class="page-tile-item" href="../secret.html"><h3>Outside</h3></a>');
    write('works/public-work/index.html', '<div class="project-desc"><h3>About</h3><p>Blenderで作成。</p><p>次の課題は軽量化。</p><img src="../../img/work.png" alt="作品の図"></div>');
    write('works/work-template.html', 'TEMPLATE_SECRET');
    const dbPath = path.join(root, 'portfolio.db');
    const writer = new Database(dbPath);
    writer.exec(`CREATE TABLE articles (id TEXT,title TEXT,date TEXT,tags TEXT,excerpt TEXT,content TEXT,created_at INTEGER,updated_at INTEGER,published_at INTEGER,visibility TEXT,share_version INTEGER);
        CREATE TABLE skills (id TEXT,name TEXT,description TEXT,sort_order INTEGER);
        CREATE TABLE timeline (id TEXT,date TEXT,title TEXT,category TEXT,href TEXT);`);
    const insert = writer.prepare('INSERT INTO articles VALUES (?,?,?,?,?,?,?,?,?,?,?)');
    for (const visibility of ['public', 'draft', 'unlisted']) insert.run(visibility, visibility === 'public' ? '公開ノート' : `${visibility}_SECRET`, '2026/10/09', '["Linux"]', `${visibility}_SUMMARY`, `<h2>見出し</h2><p>${visibility}_BODY</p><p><a href="/portfolio/index.html">取得元</a></p>`, 1000, 2000, visibility === 'public' ? 1500 : null, visibility, 77);
    writer.prepare('INSERT INTO skills VALUES (?,?,?,?)').run('linux', 'Linux', '運用', 0);
    writer.prepare('INSERT INTO timeline VALUES (?,?,?,?,?)').run('event', '2026/10/09', '制作開始', 'school', null);
    writer.close();
    const hash = () => crypto.createHash('sha256').update(fs.readFileSync(dbPath)).digest('hex');
    const before = hash();
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const app = createPreview({ root, db });
    const server = app.listen(0, '127.0.0.1');
    t.after(async () => { await new Promise(resolve => server.close(resolve)); db.close(); assert.equal(hash(), before); fs.rmSync(root, { recursive: true }); });
    return { server, db, root };
}

test('all public retrieval paths exclude draft and unlisted rows and leave the DB unchanged', async t => {
    const { server, db } = fixture(t);
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const get = route => fetch(base + route);
    assert.throws(() => db.exec("DELETE FROM articles"), /readonly/);
    for (const route of ['/portfolio/llms.txt', '/llms.txt', '/portfolio/api/public/notes', '/portfolio/api/public/notes?q=SECRET', '/portfolio/notes/public.md', '/portfolio/notes/public.jsonld', '/portfolio/notes/public/index.html', '/portfolio/api/public/notes/public']) {
        const response = await get(route); assert.equal(response.status, 200, route);
        const value = await response.text();
        assert.doesNotMatch(value, /draft_SECRET|unlisted_SECRET|draft_BODY|unlisted_BODY|share_version/, route);
    }
    const listed = await (await get('/portfolio/api/public/notes')).json();
    assert.equal(listed.count, 1); assert.equal(listed.items[0].id, 'public'); assert.equal(listed.items[0].content_markdown, undefined);
    const found = await (await get('/portfolio/api/public/notes?q=Linux')).json(); assert.equal(found.count, 1);
    const hiddenSearch = await (await get('/portfolio/api/public/notes?q=SECRET')).json(); assert.equal(hiddenSearch.count, 0);
    const detail = await (await get('/portfolio/api/public/notes/public')).json();
    assert.match(detail.item.content_markdown, /## 見出し/); assert.equal(detail.item.updated_at, '1970-01-01T00:00:02.000Z');
    for (const id of ['draft', 'unlisted', 'missing']) for (const suffix of ['.md', '.jsonld', '/index.html']) assert.equal((await get(`/portfolio/notes/${id}${suffix}`)).status, 404);
    for (const route of ['/portfolio/api/public/notes/draft', '/portfolio/api/public/notes/unlisted', '/portfolio/admin/editor.html', '/portfolio/api/data/config.json', '/api/server.js', '/portfolio/works/work-template.md', '/portfolio/works/..%2Fsecret.md', '/portfolio/notes/..%2Fsecret.md']) assert.equal((await get(route)).status, 404, route);
    assert.equal((await fetch(base + '/portfolio/api/public/notes', { method: 'POST', body: 'mutate' })).status, 405);
    assert.equal((await get('/portfolio/api/public/notes?q[]=x')).status, 400);
    assert.equal((await get('/portfolio/api/public/notes?q=' + 'x'.repeat(121))).status, 400);
});

test('HTML, Markdown negotiation, JSON and JSON-LD describe the same source', async t => {
    const { server } = fixture(t);
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const md = await fetch(base + '/portfolio/profile.html', { headers: { Accept: 'text/markdown' } });
    assert.match(md.headers.get('content-type'), /^text\/markdown/); assert.match(md.headers.get('vary'), /Accept/);
    assert.match(md.headers.get('link'), /rel="alternate".*text\/markdown/);
    const body = await md.text(); assert.match(body, /^# Altena/); assert.match(body, /Software & Infrastructure Engineer/); assert.match(body, /公開プロフィール 二行目/);
    assert.doesNotMatch(body, /Scroll/);
    const html = await fetch(base + '/portfolio/profile.html', { headers: { Accept: 'text/markdown;q=0, text/html;q=1' } });
    assert.match(html.headers.get('content-type'), /^text\/html/); const markup = await html.text(); assert.match(markup, /application\/ld\+json/);
    const profile = (await (await fetch(base + '/portfolio/api/public/profile')).json()).item;
    const schema = await (await fetch(base + '/portfolio/profile.jsonld')).json();
    const person = schema['@graph'].find(node => node['@type'] === 'Person');
    const webpage = schema['@graph'].find(node => node['@type'] === 'WebPage');
    assert.equal(person.name, profile.name); assert.equal(person.description, profile.bio);
    assert.deepEqual(person.sameAs, ['https://github.com/4ltena']);
    assert.equal(webpage.url, 'https://altena.me/portfolio/index.html');
    assert.equal(webpage.dateModified, undefined); // file mtime is not an editorial update date.
    const works = await (await fetch(base + '/portfolio/api/public/works')).json(); assert.equal(works.count, 1); assert.equal(works.items[0].date, '2026-04-11');
    const work = (await (await fetch(base + '/portfolio/api/public/works/public-work')).json()).item; assert.match(work.content_markdown, /軽量化/);
    assert.match(work.content_markdown, /!\[作品の図\]\(<https:\/\/altena.me\/portfolio\/img\/work.png>\)/);
    const workSchema = await (await fetch(base + '/portfolio/works/public-work.jsonld')).json(); assert.equal(workSchema['@graph'].find(node => node['@type'] === 'CreativeWork').dateModified, undefined);
    const noteSchema = await (await fetch(base + '/portfolio/notes/public.jsonld')).json(); assert.equal(noteSchema['@graph'].find(node => node['@type'] === 'BlogPosting').dateModified, '1970-01-01T00:00:02.000Z');
    const noteCollection = await (await fetch(base + '/portfolio/notes.jsonld')).json();
    assert.equal(noteCollection['@graph'].find(node => node['@type'] === 'ItemList').numberOfItems, 0);
    const workCollection = await (await fetch(base + '/portfolio/works.jsonld')).json();
    assert.equal(workCollection['@graph'].find(node => node['@type'] === 'ItemList').numberOfItems, works.total_count);
    for (const kind of ['skills', 'timeline']) assert.equal((await fetch(base + `/portfolio/${kind}.md`)).status, 200);
});

test('Markdown conversion preserves structure and literal code while dropping active content', () => {
    const md = htmlToMarkdown('<h2>章</h2><p><strong>強調</strong>と<a href="../other.html">リンク</a><br>次行</p><ul><li>一</li><li>二</li></ul><pre><code>const x = `a`;\n  ```\n  x &lt; 3;</code></pre><table><tr><th>キー</th><th>値</th></tr><tr><td>A|B</td><td>1</td></tr></table><script>ACTIVE_SECRET</script><a href="javascript:evil()">安全な文字</a>', 'https://altena.me/portfolio/notes/test/index.html');
    assert.match(md, /## 章/); assert.match(md, /\*\*強調\*\*/); assert.match(md, /https:\/\/altena.me\/portfolio\/notes\/other.html/);
    assert.match(md, /- 一\n- 二/); assert.match(md, /````\nconst x = `a`;\n  ```\n  x < 3;\n````/);
    assert.match(md, /\| キー \| 値 \|/); assert.match(md, /A\\\|B/); assert.doesNotMatch(md, /ACTIVE_SECRET|javascript:/);
    assert.equal(htmlToMarkdown('<pre>first\n\n\nlast</pre>'), '```\nfirst\n\n\nlast\n```\n');
});
