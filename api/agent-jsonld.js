'use strict';

const { parseDocument } = require('htmlparser2');

const SITE = 'https://altena.me/portfolio/';
const WEBSITE_ID = `${SITE}#website`;
const PERSON_ID = `${SITE}#altena`;
const SCRIPT_ID = 'portfolio-agent-jsonld';
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const ref = id => ({ '@id': id });
const text = value => typeof value === 'string' && value.trim() ? value : undefined;
const strings = value => Array.isArray(value) ? value.filter(entry => text(entry)) : [];

function canonicalUrl(value, { allowFragment = false } = {}) {
    if (typeof value !== 'string' || /[\s\\\u0000-\u001f\u007f]/u.test(value)) throw new TypeError('Invalid public canonical URL');
    let url;
    try { url = new URL(value); } catch { throw new TypeError('Invalid public canonical URL'); }
    if (url.origin !== new URL(SITE).origin || url.username || url.password || url.search ||
        !url.pathname.startsWith('/portfolio/') || /%(?:2f|5c|2e)/i.test(url.pathname) ||
        /\.(?:json|jsonld|md)$/i.test(url.pathname) || url.pathname.startsWith('/portfolio/api/') ||
        (!allowFragment && url.hash)) throw new TypeError('Invalid public canonical URL');
    return url.href;
}

function topUrl(value) {
    const url = new URL(canonicalUrl(value || `${SITE}index.html`, { allowFragment: true }));
    if (!['/portfolio/', '/portfolio/index.html'].includes(url.pathname)) throw new TypeError('Invalid top page URL');
    return `${SITE}index.html`;
}

function detailUrl(item, type) {
    if (!item || item.type !== type || !ID.test(item.id)) throw new TypeError('Invalid public item');
    const canonical = canonicalUrl(item.canonical_url);
    const expected = `${SITE}${type === 'note' ? 'notes' : 'works'}/${item.id}/${type === 'note' ? '' : 'index.html'}`;
    if (canonical !== expected) throw new TypeError('Invalid public item canonical URL');
    return canonical;
}

function timestamp(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return undefined;
    const normalized = value.replace(/(?:\.(\d{1,3}))?Z$/, (_, fraction) => `.${(fraction || '').padEnd(3, '0')}Z`);
    const date = new Date(value);
    return Number.isFinite(date.getTime()) && date.toISOString() === normalized ? value : undefined;
}

function publicLink(value) {
    if (typeof value !== 'string' || /[\s\\\u0000-\u001f\u007f]/u.test(value)) return false;
    try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; }
    catch { return false; }
}

function person(profile) {
    const node = { '@type': 'Person', '@id': PERSON_ID };
    if (!profile) return node;
    if (text(profile.name || profile.title)) node.name = profile.name || profile.title;
    if (text(profile.bio || profile.description || profile.summary)) node.description = profile.bio || profile.description || profile.summary;
    if (strings(profile.roles).length) node.jobTitle = strings(profile.roles);
    if (strings(profile.focus).length) node.knowsAbout = strings(profile.focus);
    const links = strings(profile.links).filter(publicLink);
    if (links.length) node.sameAs = links;
    return node;
}

function creativeWork(item, type) {
    const url = detailUrl(item, type);
    const node = {
        '@type': type === 'note' ? 'BlogPosting' : 'CreativeWork',
        '@id': `${url}#${type === 'note' ? 'article' : 'work'}`,
        url,
        author: ref(PERSON_ID), publisher: ref(PERSON_ID),
        isPartOf: ref(WEBSITE_ID), mainEntityOfPage: ref(`${url}#webpage`)
    };
    if (text(item.title)) { node.name = item.title; node.headline = item.title; }
    if (text(item.summary)) node.description = item.summary;
    if (strings(item.tags).length) node.keywords = strings(item.tags);
    if (text(item.revision)) node.version = item.revision;
    if (type === 'note') {
        if (timestamp(item.published_at)) node.datePublished = timestamp(item.published_at);
        if (item.updated_at_basis === 'article-record' && timestamp(item.updated_at)) node.dateModified = timestamp(item.updated_at);
    }
    return node;
}

/** Accept only public DTOs. Publication filtering belongs to the common public reader. */
function generateJsonLd({ kind, item, items, pageUrl, profile } = {}) {
    const website = { '@type': 'WebSite', '@id': WEBSITE_ID, url: SITE, name: 'Altena Portfolio' };
    const graph = [website, person(profile || (kind === 'profile' || kind === 'profile-page' ? item : undefined))];
    const page = (url, type, name) => ({ '@type': type, '@id': `${url}#webpage`, url, name, isPartOf: ref(WEBSITE_ID) });
    if (kind === 'index' || kind === 'profile') {
        const url = topUrl(pageUrl || item?.canonical_url);
        graph.push({ ...page(url, 'WebPage', 'Altena Portfolio'), about: ref(PERSON_ID) });
    } else if (kind === 'profile-page') {
        const url = canonicalUrl(pageUrl || item?.canonical_url);
        if (!new URL(url).pathname.endsWith('.html') || new URL(url).pathname === '/portfolio/index.html') throw new TypeError('ProfilePage requires a dedicated page URL');
        graph.push({ ...page(url, 'ProfilePage', text(item?.name || profile?.name) || 'Profile'), '@id': `${url}#profile-page`, mainEntity: ref(PERSON_ID) });
    } else if (kind === 'work' || kind === 'note') {
        const work = creativeWork(item, kind);
        if (pageUrl && canonicalUrl(pageUrl) !== work.url) throw new TypeError('Detail page URL does not match its canonical URL');
        graph.push({ ...page(work.url, 'WebPage', work.name), mainEntity: ref(work['@id']) }, work);
    } else if (kind === 'works' || kind === 'notes') {
        if (!Array.isArray(items)) throw new TypeError('Visible items must be supplied');
        const expected = `${SITE}${kind === 'works' ? 'myworks' : 'notes'}.html`;
        const url = canonicalUrl(pageUrl || expected);
        if (url !== expected) throw new TypeError('Invalid collection page URL');
        const works = items.map(entry => creativeWork(entry, kind === 'notes' ? 'note' : 'work'));
        graph.push({ ...page(url, 'CollectionPage', kind === 'works' ? 'My Works | Portfolio' : 'Notes | Portfolio'), mainEntity: ref(`${url}#itemlist`) },
            { '@type': 'ItemList', '@id': `${url}#itemlist`, numberOfItems: works.length,
                itemListElement: works.map((work, index) => ({ '@type': 'ListItem', position: index + 1, item: ref(work['@id']) })) }, ...works);
    } else if (kind === 'skills' || kind === 'timeline') {
        if (!Array.isArray(items)) throw new TypeError('Visible items must be supplied');
        const url = topUrl(pageUrl);
        const listId = `${url}#${kind}-itemlist`;
        graph.push({ ...page(url, 'WebPage', 'Altena Portfolio'), about: ref(PERSON_ID), mainEntity: ref(listId) },
            { '@type': 'ItemList', '@id': listId, numberOfItems: items.length,
                itemListElement: items.map((entry, index) => {
                    if (!entry || entry.type !== (kind === 'skills' ? 'skill' : 'timeline') || !ID.test(entry.id)) throw new TypeError('Invalid public item');
                    const result = { '@type': 'ListItem', position: index + 1,
                        item: { '@id': canonicalUrl(entry.canonical_url, { allowFragment: true }), name: entry.title } };
                    if (text(entry.summary)) result.item.description = entry.summary;
                    return result;
                }) });
    } else throw new TypeError('Unsupported JSON-LD kind');
    return { '@context': 'https://schema.org', '@graph': graph };
}

function serializeJsonLd(value) {
    const json = JSON.stringify(value);
    if (json === undefined) throw new TypeError('JSON-LD value must be serializable');
    return json.replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/** Replace this module's script only, preserving every other HTML byte. */
function embedJsonLd(html, data) {
    if (typeof html !== 'string') throw new TypeError('HTML must be a string');
    const script = `<script id="${SCRIPT_ID}" type="application/ld+json">${serializeJsonLd(data)}</script>`;
    const document = parseDocument(html, { withStartIndices: true, withEndIndices: true });
    const owned = [];
    let head, body;
    function visit(node) {
        if (node.name === 'head' && !head) head = node;
        if (node.name === 'body' && !body) body = node;
        if (node.name === 'script' && node.attribs?.id === SCRIPT_ID && node.attribs?.type?.trim().toLowerCase() === 'application/ld+json') owned.push(node);
        for (const child of node.children || []) visit(child);
    }
    visit(document);
    if (owned.length) {
        let result = '', position = 0;
        owned.forEach((node, index) => {
            result += html.slice(position, node.startIndex) + (index === 0 ? script : '');
            position = node.endIndex + 1;
        });
        return result + html.slice(position);
    }
    const close = head && /<\/head\s*>$/i.exec(html.slice(head.startIndex, head.endIndex + 1));
    const position = close ? head.startIndex + close.index : body?.startIndex ?? 0;
    return html.slice(0, position) + script + html.slice(position);
}

module.exports = { generateJsonLd, serializeJsonLd, embedJsonLd };
