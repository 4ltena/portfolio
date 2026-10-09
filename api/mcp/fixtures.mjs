import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import publicService from '../agent-public-service.js';
import { openLocalPublicService } from './runtime.mjs';

const require = createRequire(new URL('../package.json', import.meta.url));
export const Database = require('better-sqlite3');
export function createFixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'portfolio-mcp-test-'));
    const write = (name, value) => { const target = path.join(root, name); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, value); };
    write('index.html', '<section id="profile"><span class="brand">Altena</span><p class="philosophy">公開プロフィール</p><div class="bio"><p>公開自己紹介。</p></div><nav class="profile-social"><a href="https://github.com/4ltena">GitHub</a></nav></section>');
    write('terminal/profile.txt', ' / / /|   Role    Software Engineer\n');
    write('myworks.html', '<a class="page-tile-item" href="works/public-work/index.html" data-tags="#Linux"><span class="note-date">2026/04/11</span><h3>Linux制作物</h3><p>公開作品</p></a>');
    write('works/public-work/index.html', '<div class="project-desc"><h3>About</h3><p>公開作品本文。</p></div>');
    write('works/hidden/index.html', 'HIDDEN_WORK_SECRET');
    const dbPath = path.join(root, 'portfolio.db');
    const writer = new Database(dbPath);
    writer.exec(`CREATE TABLE articles (id TEXT PRIMARY KEY,title TEXT,date TEXT,tags TEXT,excerpt TEXT,content TEXT,created_at INTEGER,updated_at INTEGER,published_at INTEGER,visibility TEXT,share_version INTEGER);
        CREATE TABLE skills (id TEXT,name TEXT,description TEXT,sort_order INTEGER);
        CREATE TABLE timeline (id TEXT,date TEXT,title TEXT,category TEXT,href TEXT);`);
    const insert = writer.prepare('INSERT INTO articles VALUES (?,?,?,?,?,?,?,?,?,?,?)');
    for (const [id, visibility, published] of [['public', 'public', 3000], ['second', 'public', 2000], ['third', 'public', 1000], ['draft', 'draft', null], ['unlisted', 'unlisted', null]]) {
        insert.run(id, visibility === 'public' ? `Linux公開${id}` : `${visibility}_SECRET`, '2026/10/09', '["Linux"]',
            visibility === 'public' ? '公開概要' : 'HIDDEN_SUMMARY_SECRET', visibility === 'public' ? `<h2>公開見出し</h2><p>${id}本文</p>` : 'HIDDEN_BODY_SECRET',
            1000, 4000, published, visibility, 77);
    }
    writer.prepare('INSERT INTO skills VALUES (?,?,?,?)').run('linux', 'Linux', '運用', 0);
    writer.prepare('INSERT INTO timeline VALUES (?,?,?,?,?)').run('event', '2026/10/09', '制作開始', 'school', null);
    const source = openLocalPublicService({ root, dbPath });
    const service = publicService.createPublicService({ root, db: source.db, now: () => new Date('2026-10-09T00:00:00.000Z') });
    const hash = () => crypto.createHash('sha256').update(fs.readFileSync(dbPath)).digest('hex');
    t.after(() => { source.close(); writer.close(); fs.rmSync(root, { recursive: true, force: true }); });
    return { root, dbPath, writer, source, service, hash };
}
