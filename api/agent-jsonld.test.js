'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseDocument } = require('htmlparser2');
const { generateJsonLd, serializeJsonLd, embedJsonLd } = require('./agent-jsonld');

const SITE = 'https://altena.me/portfolio/';
const profile = {
    id: 'altena', type: 'profile', name: 'Altena', title: 'Altena',
    canonical_url: `${SITE}index.html#profile`, summary: '公開の説明', bio: '公開プロフィール',
    roles: ['Developer'], focus: ['Infrastructure'],
    links: ['https://github.com/4ltena', 'mailto:contact@altena.me', 'javascript:alert(1)', 'https://user:password@example.com'],
    updated_at: '2026-10-09T01:02:03.000Z', source_modified_at: '2026-10-09T01:02:03.000Z', updated_at_basis: 'source-file-mtime'
};
const note = (id = 'article', fields = {}) => ({
    id, type: 'note', title: '公開記事', summary: '記事の概要', tags: ['Linux'],
    canonical_url: `${SITE}notes/${id}/`, source_url: `${SITE}notes/${id}/index.html`,
    date: '2026-10-09', published_at: '2026-10-08T01:02:03.000Z', updated_at: '2026-10-09T01:02:03.000Z',
    updated_at_basis: 'article-record', revision: 'revision-1', ...fields
});
const work = (id = 'creative', fields = {}) => ({
    id, type: 'work', title: '公開作品', summary: '作品の概要', tags: ['3DCG'],
    canonical_url: `${SITE}works/${id}/index.html`, date: '2026-10-09',
    updated_at: '2026-10-09T01:02:03.000Z', source_modified_at: '2026-10-09T01:02:03.000Z',
    updated_at_basis: 'source-file-mtime', ...fields
});
const node = (data, type) => data['@graph'].find(value => value['@type'] === type);
const scripts = html => {
    const result = [];
    function visit(value) { if (value.name === 'script') result.push(value); for (const child of value.children || []) visit(child); }
    visit(parseDocument(html));
    return result;
};
const scriptData = html => JSON.parse(scripts(html).find(value => value.attribs.id === 'portfolio-agent-jsonld' && value.attribs.type.toLowerCase() === 'application/ld+json').children[0].data);

test('top and initial Profile share stable website/person IDs and describe a WebPage', () => {
    const top = generateJsonLd({ kind: 'index', profile });
    const prof = generateJsonLd({ kind: 'profile', item: profile });
    assert.deepEqual(prof, top);
    assert.equal(top['@context'], 'https://schema.org');
    assert.equal(node(top, 'WebSite')['@id'], `${SITE}#website`);
    assert.equal(node(top, 'Person')['@id'], `${SITE}#altena`);
    assert.deepEqual(node(top, 'Person').sameAs, ['https://github.com/4ltena']);
    assert.deepEqual(node(top, 'Person').jobTitle, ['Developer']);
    assert.deepEqual(node(top, 'Person').knowsAbout, ['Infrastructure']);
    assert.equal(node(top, 'WebPage')['@id'], `${SITE}index.html#webpage`);
    assert.deepEqual(node(top, 'WebPage').isPartOf, { '@id': `${SITE}#website` });
    assert.deepEqual(node(top, 'WebPage').about, { '@id': `${SITE}#altena` });
    assert.equal(node(top, 'ProfilePage'), undefined);
    assert.ok(!serializeJsonLd(top).includes('dateModified'));
});

test('ProfilePage needs an explicit dedicated page rather than the current top section', () => {
    assert.throws(() => generateJsonLd({ kind: 'profile-page', item: profile }), /canonical URL/);
    assert.throws(() => generateJsonLd({ kind: 'profile-page', item: profile, pageUrl: `${SITE}index.html` }), /dedicated page/);
    assert.throws(() => generateJsonLd({ kind: 'profile-page', profile, pageUrl: `${SITE}api/public/profile` }), /canonical URL/);
    assert.throws(() => generateJsonLd({ kind: 'profile-page', profile, pageUrl: `${SITE}profile.jsonld` }), /canonical URL/);
    const data = generateJsonLd({ kind: 'profile-page', profile, pageUrl: `${SITE}profile.html` });
    assert.equal(node(data, 'ProfilePage')['@id'], `${SITE}profile.html#profile-page`);
    assert.deepEqual(node(data, 'ProfilePage').mainEntity, { '@id': `${SITE}#altena` });
});

test('note details use directory canonical and shared Person/Website relations', () => {
    const data = generateJsonLd({ kind: 'note', item: note(), profile });
    const article = node(data, 'BlogPosting');
    assert.equal(article['@id'], `${SITE}notes/article/#article`);
    assert.equal(article.url, `${SITE}notes/article/`);
    assert.equal(article.name, '公開記事');
    assert.equal(article.description, '記事の概要');
    assert.equal(article.version, 'revision-1');
    assert.deepEqual(article.author, { '@id': `${SITE}#altena` });
    assert.deepEqual(article.publisher, { '@id': `${SITE}#altena` });
    assert.deepEqual(article.isPartOf, { '@id': `${SITE}#website` });
    assert.deepEqual(article.mainEntityOfPage, { '@id': `${SITE}notes/article/#webpage` });
    assert.deepEqual(node(data, 'WebPage').mainEntity, { '@id': article['@id'] });
    assert.equal(article.datePublished, note().published_at);
    assert.equal(article.dateModified, note().updated_at);
    assert.ok(!serializeJsonLd(data).includes('schema_version'));
    assert.ok(!serializeJsonLd(data).includes('generated_at'));
});

test('work metadata stays CreativeWork and omits file-mtime and display dates', () => {
    const data = generateJsonLd({ kind: 'work', item: work(), profile });
    const creative = node(data, 'CreativeWork');
    assert.equal(creative['@id'], `${SITE}works/creative/index.html#work`);
    assert.equal(creative.datePublished, undefined);
    assert.equal(creative.dateModified, undefined);
    assert.equal(node(data, 'SoftwareApplication'), undefined);
});

test('missing, untracked, and invalid note dates are omitted instead of invented', () => {
    for (const fields of [
        { published_at: null, updated_at: null },
        { published_at: '2026-10-09', updated_at: 'invalid' },
        { published_at: '2026-02-31T01:02:03.000Z', updated_at: '2026-02-31T01:02:03.000Z' }
    ]) {
        const article = node(generateJsonLd({ kind: 'note', item: note('article', fields) }), 'BlogPosting');
        assert.equal(article.datePublished, undefined);
        assert.equal(article.dateModified, undefined);
    }
    const article = node(generateJsonLd({ kind: 'note', item: note('article', { updated_at_basis: 'not-tracked' }) }), 'BlogPosting');
    assert.equal(article.dateModified, undefined);
    assert.equal(article.datePublished, note().published_at);
});

test('lists preserve supplied visible subset/order and reference typed content nodes', () => {
    for (const [kind, make, contentType, pageName] of [['works', work, 'CreativeWork', 'myworks'], ['notes', note, 'BlogPosting', 'notes']]) {
        const items = [make('second'), make('first')];
        const data = generateJsonLd({ kind, items, profile });
        const list = node(data, 'ItemList');
        const page = node(data, 'CollectionPage');
        assert.equal(page['@id'], `${SITE}${pageName}.html#webpage`);
        assert.deepEqual(page.mainEntity, { '@id': `${SITE}${pageName}.html#itemlist` });
        assert.equal(list.numberOfItems, 2);
        assert.deepEqual(list.itemListElement.map(entry => entry.position), [1, 2]);
        assert.deepEqual(list.itemListElement.map(entry => entry.item['@id']), data['@graph'].filter(value => value['@type'] === contentType).map(value => value['@id']));
        assert.ok(list.itemListElement[0].item['@id'].includes('/second/'));
        assert.ok(list.itemListElement[1].item['@id'].includes('/first/'));
        const empty = node(generateJsonLd({ kind, items: [] }), 'ItemList');
        assert.equal(empty.numberOfItems, 0);
        assert.deepEqual(empty.itemListElement, []);
    }
    assert.throws(() => generateJsonLd({ kind: 'notes' }), /Visible items/);
});

test('Skills and Timeline use supplied content without fabricated timestamps', () => {
    for (const kind of ['skills', 'timeline']) {
        const item = { id: 'known', type: kind === 'skills' ? 'skill' : 'timeline', title: '公開項目', summary: '概要',
            canonical_url: `${SITE}index.html#${kind}`, date: '2026-10-09', published_at: '2026-10-09T01:02:03.000Z',
            updated_at: '2026-10-09T01:02:03.000Z', updated_at_basis: 'not-tracked' };
        const data = generateJsonLd({ kind, items: [item], profile });
        const list = node(data, 'ItemList');
        assert.equal(list.itemListElement[0].item.name, item.title);
        assert.equal(list.itemListElement[0].item.description, item.summary);
        assert.ok(!serializeJsonLd(data).includes('datePublished'));
        assert.ok(!serializeJsonLd(data).includes('dateModified'));
    }
});

test('canonical URLs reject other hosts, credentials, APIs, unsafe paths and wrong IDs', () => {
    for (const canonical_url of [
        'javascript:alert(1)', 'http://altena.me/portfolio/notes/article/',
        'https://example.com/portfolio/notes/article/', 'https://altena.me.evil/portfolio/notes/article/',
        'https://user:password@altena.me/portfolio/notes/article/',
        `${SITE}api/public/notes/article`, `${SITE}notes/other/`, `${SITE}notes/article/index.html`,
        `${SITE}notes/article/?shared=1`, `${SITE}notes/article/#section`, `${SITE}notes/%2farticle/`,
        `${SITE}notes/article/\n`, `${SITE}notes/article/\u0000`, `${SITE}notes/article\\`
    ]) assert.throws(() => generateJsonLd({ kind: 'note', item: note('article', { canonical_url }) }), /canonical URL/);
    assert.throws(() => generateJsonLd({ kind: 'note', item: note('../secret') }), /public item/);
    assert.throws(() => generateJsonLd({ kind: 'note', item: note(), pageUrl: `${SITE}notes/other/` }), /does not match/);
    assert.throws(() => generateJsonLd({ kind: 'notes', items: [work()] }), /public item/);
});

test('generator projects metadata only and does not derive publication from external links', () => {
    const item = note('article', { external_url: 'https://private.example.com/SECRET', visibility: 'ignored-input', share_token: 'TOKEN', internal_job: 'JOB', content_markdown: 'BODY' });
    const value = serializeJsonLd(generateJsonLd({ kind: 'note', item }));
    assert.ok(value.includes('公開記事'));
    for (const secret of ['SECRET', 'ignored-input', 'TOKEN', 'JOB', 'BODY']) assert.ok(!value.includes(secret));
});

test('serialization escapes script breakouts, comments and JavaScript line separators with exact JSON roundtrip', () => {
    const value = { title: '</script><script>alert("x")</script><!--', body: 'backslash \\ and "quotes"\u2028\u2029日本語' };
    const serialized = serializeJsonLd(value);
    assert.ok(!serialized.includes('<'));
    assert.ok(!serialized.includes('\u2028'));
    assert.ok(!serialized.includes('\u2029'));
    assert.ok(serialized.includes('\\u003c/script>'));
    assert.ok(serialized.includes('\\u2028\\u2029'));
    assert.deepEqual(JSON.parse(serialized), value);
    const html = embedJsonLd('<html><head></head><body>Visible</body></html>', value);
    assert.equal(scripts(html).length, 1);
    assert.deepEqual(scriptData(html), value);
    assert.throws(() => serializeJsonLd(undefined), /serializable/);
});

test('embedding changes only owned JSON-LD scripts and preserves unrelated HTML byte for byte', () => {
    const before = '<!doctype html><html><head>\n<!-- <script id="portfolio-agent-jsonld" type="application/ld+json">fake</script> -->\n' +
        '<script type="application/ld+json">{"unrelated":true}</script>\n' +
        '<script id="portfolio-agent-jsonld" type="text/javascript">/* unrelated */</script>\n';
    const after = '\n<script>const untouched = "&<>";</script>\n</head><body data-x="&amp;">本文</body></html>';
    const owned = '<SCRIPT TYPE="application/ld+json" ID="portfolio-agent-jsonld">{"old":true}</SCRIPT>';
    const data = generateJsonLd({ kind: 'note', item: note() });
    const output = embedJsonLd(before + owned + after, data);
    assert.equal(output, before + `<script id="portfolio-agent-jsonld" type="application/ld+json">${serializeJsonLd(data)}</script>` + after);
    assert.deepEqual(scriptData(output), data);
    assert.equal(embedJsonLd(output, data), output);
});

test('embedding adds metadata to head and removes duplicate owned scripts only', () => {
    const owned = '<script id="portfolio-agent-jsonld" type="application/ld+json">{}</script>';
    const data = { name: 'current' };
    const output = embedJsonLd(`<html><head>${owned}<meta charset="utf-8">${owned}</head><body>visible</body></html>`, data);
    assert.equal(scripts(output).length, 1);
    assert.ok(output.includes('<meta charset="utf-8">'));
    assert.deepEqual(scriptData(output), data);
    const initial = embedJsonLd('<html><HEAD>\n<title>Title</title>\n</HEAD><body>visible</body></html>', data);
    assert.match(initial, /<title>Title<\/title>\n<script[^>]+>.+<\/script><\/HEAD>/);
    assert.deepEqual(scriptData(initial), data);
    assert.equal(embedJsonLd('<body>visible</body>', data), `<script id="portfolio-agent-jsonld" type="application/ld+json">${serializeJsonLd(data)}</script><body>visible</body>`);
});
