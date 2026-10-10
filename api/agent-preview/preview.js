'use strict';

const sources = document.getElementById('sources');
const output = document.getElementById('output');
const feedback = document.getElementById('feedback');
let current = { kind: 'profile', title: 'Profile', id: null };
let format = 'html';
let raw = '';
let sequence = 0;
const items = [];
function urls(item) {
    const prefix = item.kind === 'profile' ? '/portfolio/profile' : `/portfolio/${item.kind}/${item.id}`;
    return { html: item.kind === 'profile' ? '/portfolio/profile.html' : `/portfolio/${item.kind}/${item.id}/index.html`,
        markdown: prefix + '.md', json: `/portfolio/api/public/${item.kind}${item.id ? '/' + item.id : ''}`, schema: prefix + '.jsonld' };
}
async function view() {
    const revision = ++sequence;
    const url = urls(current)[format];
    document.getElementById('endpoint').textContent = 'GET ' + url;
    document.getElementById('open').href = url;
    sources.querySelectorAll('button').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.key === `${current.kind}/${current.id || ''}`)));
    document.querySelectorAll('[data-format]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.format === format)));
    feedback.textContent = '';
    raw = '';
    document.getElementById('copy').disabled = true;
    document.getElementById('meta').textContent = '読み込み中…';
    output.textContent = '読み込み中…';
    try {
        const response = await fetch(url);
        const body = await response.text();
        if (revision !== sequence) return;
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        raw = body;
        document.getElementById('copy').disabled = false;
        document.getElementById('meta').textContent = `${response.status} · ${response.headers.get('content-type')} · ${new TextEncoder().encode(body).length.toLocaleString()} bytes`;
        output.replaceChildren();
        if (format === 'html') {
            // Display only text from the generated response; never execute returned markup.
            const parsed = new DOMParser().parseFromString(body, 'text/html');
            const heading = document.createElement('h1'); heading.textContent = parsed.querySelector('article h1').textContent;
            const pre = document.createElement('pre'); pre.textContent = parsed.querySelector('article pre').textContent;
            output.className = 'html-content'; output.append(heading, pre);
        } else {
            output.className = '';
            const pre = document.createElement('pre'); pre.textContent = ['json', 'schema'].includes(format) ? JSON.stringify(JSON.parse(body), null, 2) : body; output.append(pre);
        }
    } catch (error) { if (revision === sequence) { raw = ''; output.textContent = error.message; } }
}
function add(item) {
    items.push(item);
    const button = document.createElement('button'); button.type = 'button'; button.className = 'source-button';
    button.textContent = item.title; button.dataset.key = `${item.kind}/${item.id || ''}`;
    button.addEventListener('click', () => { current = item; view(); }); sources.append(button);
}
function group(title) { const label = document.createElement('p'); label.className = 'source-group'; label.textContent = title; sources.append(label); }
document.querySelectorAll('[data-format]').forEach(button => button.addEventListener('click', () => { format = button.dataset.format; view(); }));
document.getElementById('copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(raw); feedback.textContent = '応答をコピーしました。'; }
    catch { feedback.textContent = 'コピーできませんでした。応答を開いて取得してください。'; }
});
document.getElementById('search').addEventListener('submit', async event => {
    event.preventDefault();
    const query = document.getElementById('query').value;
    const results = document.getElementById('results'); results.textContent = '検索中…';
    try {
        const lists = await Promise.all(['works', 'notes'].map(async kind => {
            const response = await fetch(`/portfolio/api/public/${kind}?q=${encodeURIComponent(query)}`);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return { kind, ...await response.json() };
        }));
        results.replaceChildren();
        for (const list of lists) for (const result of list.items) {
            const button = document.createElement('button'); button.type = 'button'; button.className = 'source-button'; button.textContent = result.title;
            button.addEventListener('click', () => { current = { ...result, kind: list.kind }; view(); }); results.append(button);
        }
        if (!results.children.length) results.textContent = '該当する公開情報はありません。';
    } catch (error) { results.textContent = error.message; }
});
(async () => {
    try {
        const lists = await Promise.all(['works', 'notes'].map(async kind => {
            const response = await fetch(`/portfolio/api/public/${kind}`);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return { kind, ...await response.json() };
        }));
        sources.replaceChildren(); add(current);
        for (const list of lists) { group(`${list.kind.toUpperCase()} / ${list.count}`); list.items.forEach(item => add({ ...item, kind: list.kind })); }
        await view();
    } catch (error) { sources.textContent = error.message; }
})();
