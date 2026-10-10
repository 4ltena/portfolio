'use strict';

const express = require('express');
const { createContentReader, documentMarkdown, escapeMarkdown, SITE } = require('./agent-content');
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const PAGE_SIZE = 20;
const line = value => escapeMarkdown(String(value ?? '').replace(/\s+/g, ' ').trim());
const entry = (title, file, description = '') => `- [${line(title)}](${SITE}${file})${description ? ': ' + line(description) : ''}`;
const links = () => [
    entry('Profile', 'profile.md', '公開プロフィールと活動分野'),
    entry('Skills', 'skills.md', '登録済みの技術一覧'),
    entry('Timeline', 'timeline.md', '時系列の経歴'),
    entry('Works', 'works.md', '公開作品の一覧'),
    entry('Notes', 'notes.md', '公開記事の一覧')
];

function siteLlms() {
    return `# Altena\n\n> Altenaの公開サイトへの入口。\n\n## Portfolio\n${entry('Portfolio', 'llms.txt', 'プロフィール・制作物・公開記事の取得先')}\n`;
}

function portfolioLlms(reader) {
    const works = reader.works().slice(0, 5);
    const notes = reader.noteSummaries({ limit: 5 });
    return ['# Altena Portfolio', '', '> 活動分野、経歴、制作物、公開記事を紹介するポートフォリオ。', '',
        '## Overview', entry('Overview', 'index.md', 'サイト全体の概要'), ...links(), '',
        '## Works', ...works.map(item => entry(item.title, `works/${item.id}.md`, item.excerpt)), '',
        '## Latest Notes', ...notes.map(item => entry(item.title, `notes/${item.id}.md`, item.excerpt)), '',
        '限定公開と下書きはこの索引の対象に含まれません。', ''].join('\n');
}

function indexMarkdown(reader) {
    const profile = reader.profile();
    return ['# Altena Portfolio', '', `取得元: ${SITE}index.html`, '',
        '## Profile', `### ${line(profile.name)}`, ...profile.roles.map(line), '',
        line(profile.description), '', line(profile.bio), '',
        '## 活動分野', ...profile.focus.map(value => `- ${line(value)}`), '',
        '## コンテンツ', ...links(), '',
        '## Works', ...reader.works().slice(0, 5).map(item => entry(item.title, `works/${item.id}.md`, item.excerpt)), '',
        '## Latest Notes', ...reader.noteSummaries({ limit: 5 }).map(item => entry(item.title, `notes/${item.id}.md`, item.excerpt)), '',
        '## 公開連絡先', ...profile.links.map(url => `- <${url}>`), ''].join('\n');
}

function createMarkdownRouter({ root, db, reader = createContentReader({ root, db }) }) {
    const router = express.Router();
    function headers(res) {
        res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
            'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'", 'Referrer-Policy': 'no-referrer' });
    }
    function send(res, value, canonical, plain = false) {
        headers(res);
        res.set('Link', `<${canonical}>; rel="canonical", <${SITE}llms.txt>; rel="describedby"`);
        // Public/private transitions must not be answered by Express's automatic ETag freshness shortcut.
        return res.type(plain ? 'text/plain' : 'text/markdown').set('Content-Length', String(Buffer.byteLength(value))).end(value);
    }
    const notFound = res => { headers(res); return res.status(404).type('text/plain').end('Not found\n'); };
    function page(req, res) {
        const value = req.query.page;
        if (value === undefined) return 1;
        if (typeof value !== 'string' || !/^[1-9][0-9]{0,3}$/.test(value)) {
            headers(res);
            res.status(400).type('text/plain').end('Invalid page\n'); return null;
        }
        return Number(value);
    }
    router.get('/site-llms.txt', (req, res) => send(res, siteLlms(), 'https://altena.me/llms.txt', true));
    router.get('/llms.txt', (req, res) => send(res, portfolioLlms(reader), SITE + 'index.html', true));
    router.get('/index.md', (req, res) => send(res, indexMarkdown(reader), SITE + 'index.html'));
    router.get('/profile.md', (req, res) => send(res, documentMarkdown(reader.profile()), SITE + 'index.html#profile'));
    for (const kind of ['skills', 'timeline']) router.get(`/${kind}.md`, (req, res) => {
        const canonical = SITE + `index.html#${kind === 'skills' ? 'skills' : 'timeline'}`;
        const items = reader[kind]();
        const rows = items.map(item => kind === 'skills' ? `- **${line(item.name)}**: ${line(item.description)}`
            : `- ${line(item.date)} — ${line(item.title)} (${line(item.category)})`);
        send(res, `# ${kind === 'skills' ? 'Skills' : 'Timeline'}\n\n取得元: ${canonical}\n更新日時: 未記録\n\n${rows.join('\n')}\n`, canonical);
    });
    for (const kind of ['works', 'notes']) {
        router.get(`/${kind}.md`, (req, res) => {
            const current = page(req, res); if (current === null) return;
            const offset = (current - 1) * PAGE_SIZE;
            const items = kind === 'notes' ? reader.noteSummaries({ limit: PAGE_SIZE + 1, offset }) : reader.works().slice(offset, offset + PAGE_SIZE + 1);
            if (current > 1 && items.length === 0) return notFound(res);
            const canonical = SITE + (kind === 'notes' ? 'notes.html' : 'myworks.html');
            const rows = items.slice(0, PAGE_SIZE).map(item => entry(`${item.date} ${item.title}`, `${kind}/${item.id}.md`, item.excerpt));
            if (current > 1) rows.push('', entry('前のページ', `${kind}.md?page=${current - 1}`));
            if (items.length > PAGE_SIZE) rows.push('', entry('次のページ', `${kind}.md?page=${current + 1}`));
            send(res, `# ${kind === 'notes' ? 'Notes' : 'Works'}\n\n取得元: ${canonical}\nページ: ${current}\n\n${rows.join('\n')}\n`, canonical);
        });
        router.get(`/${kind}/:id.md`, (req, res) => {
            if (!ID.test(req.params.id)) return notFound(res);
            const item = kind === 'notes' ? reader.notes(req.params.id)[0] : reader.works().find(value => value.id === req.params.id);
            return item ? send(res, documentMarkdown(item), item.source_url) : notFound(res);
        });
    }
    router.use((error, req, res, next) => {
        // Do not expose file paths, SQL, or hidden source content in read failures.
        headers(res);
        res.status(500).type('text/plain').end('Source could not be read\n');
    });
    return router;
}

module.exports = { createMarkdownRouter, siteLlms, portfolioLlms, indexMarkdown };
