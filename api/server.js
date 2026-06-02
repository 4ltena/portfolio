'use strict';
const express      = require('express');
const bcrypt       = require('bcryptjs');
const jwt          = require('jsonwebtoken');
const fs           = require('fs');
const path         = require('path');
const crypto       = require('crypto');
const https        = require('https');
const { execSync } = require('child_process');
const Database     = require('better-sqlite3');
const multer       = require('multer');

const app = express();
app.use(express.json({ limit: '4mb' }));

const ts  = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const log = (...args) => console.log(`[${ts()}]`, ...args);
const err = (...args) => console.error(`[${ts()}]`, ...args);

// ─── Paths ────────────────────────────────────────────────────────────────────
const PORTFOLIO_ROOT = path.resolve(__dirname, '..');
const DATA_DIR       = path.join(__dirname, 'data');
const NOTES_OUT_DIR  = path.join(PORTFOLIO_ROOT, 'notes');
const IMG_DIR        = path.join(PORTFOLIO_ROOT, 'img');
const CONFIG_FILE    = path.join(DATA_DIR, 'config.json');
const DB_FILE        = path.join(DATA_DIR, 'portfolio.db');
const EASTER_FILE    = path.join(DATA_DIR, 'easter.html');

// Legacy JSON paths (read-only, migration source)
const ARTICLES_DIR  = path.join(DATA_DIR, 'articles');
const TIMELINE_FILE = path.join(DATA_DIR, 'timeline.json');
const SKILLS_FILE   = path.join(DATA_DIR, 'skills.json');

[DATA_DIR, NOTES_OUT_DIR, IMG_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

// ─── SQLite ───────────────────────────────────────────────────────────────────
const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS cert_nodes (
    id            TEXT PRIMARY KEY,
    node_category TEXT NOT NULL DEFAULT 'info',
    parent_id     TEXT
  );
  CREATE TABLE IF NOT EXISTS cert_plans (
    id            TEXT PRIMARY KEY,
    title         TEXT NOT NULL,
    node_category TEXT NOT NULL DEFAULT 'info',
    parent_id     TEXT,
    extra_label   TEXT NOT NULL DEFAULT '',
    extra_value   TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS articles (
    id         TEXT PRIMARY KEY,
    title      TEXT NOT NULL,
    date       TEXT NOT NULL,
    tags       TEXT NOT NULL DEFAULT '[]',
    excerpt    TEXT DEFAULT '',
    content    TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS timeline (
    id       TEXT PRIMARY KEY,
    date     TEXT NOT NULL,
    title    TEXT NOT NULL,
    category TEXT NOT NULL,
    href     TEXT
  );
  CREATE TABLE IF NOT EXISTS skills (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    description TEXT DEFAULT '',
    icon        TEXT DEFAULT '',
    sort_order  INTEGER NOT NULL DEFAULT 0
  );
`);

// ─── Seed / migration ─────────────────────────────────────────────────────────
const DEFAULT_TIMELINE = [
    { id: 'tl-s1',  date: '2022/04/07', title: '入学',                                          category: 'school',  href: null },
    { id: 'tl-s2',  date: '2023/04/01', title: '第二学年進学',                                  category: 'school',  href: null },
    { id: 'tl-c1',  date: '2023/05/11', title: '日本漢字能力検定 2級',                           category: 'cert',    href: 'certifications.html' },
    { id: 'tl-c2',  date: '2023/05/17', title: 'ITパスポート',                                   category: 'cert',    href: 'certifications.html' },
    { id: 'tl-c3',  date: '2023/09/14', title: '基本情報技術者',                                 category: 'cert',    href: 'certifications.html' },
    { id: 'tl-c4',  date: '2023/11/10', title: '実用数学技能検定 準2級',                         category: 'cert',    href: 'certifications.html' },
    { id: 'tl-c5',  date: '2023/12/24', title: '統計検定 3級',                                   category: 'cert',    href: 'certifications.html' },
    { id: 'tl-c6',  date: '2024/03/09', title: 'G検定',                                         category: 'cert',    href: 'certifications.html' },
    { id: 'tl-c7',  date: '2024/05/16', title: '情報セキュリティマネジメント',                   category: 'cert',    href: 'certifications.html' },
    { id: 'tl-c8',  date: '2024/10/20', title: '危険物取扱者 乙種第4類',                         category: 'cert',    href: 'certifications.html' },
    { id: 'tl-c9',  date: '2025/03/27', title: 'タイピング技能検定 特級',                        category: 'cert',    href: 'certifications.html' },
    { id: 'tl-s3',  date: '2025/04/01', title: '第三学年進学',                                   category: 'school',  href: null },
    { id: 'tl-c10', date: '2025/04/05', title: 'Python3 エンジニア認定基礎試験',                 category: 'cert',    href: 'certifications.html' },
    { id: 'tl-c11', date: '2025/04/20', title: '応用情報技術者',                                 category: 'cert',    href: 'certifications.html' },
    { id: 'tl-c12', date: '2025/07/06', title: 'カラーコーディネーター スタンダード',            category: 'cert',    href: 'certifications.html' },
    { id: 'tl-c13', date: '2026/03/01', title: '危険物取扱者 乙種第2類',                         category: 'cert',    href: 'certifications.html' },
    { id: 'tl-c14', date: '2026/03/01', title: '危険物取扱者 乙種第3類',                         category: 'cert',    href: 'certifications.html' },
    { id: 'tl-x1',  date: '2026/03/28', title: '第2回 さくらのAIハッカソン with Kloud 最優秀賞', category: 'contest', href: 'notes.html?search=AIハッカソン' },
    { id: 'tl-s4',  date: '2026/04/01', title: '第四学年進学',                                   category: 'school',  href: null },
];

const DEFAULT_SKILLS = [
    { id: 'sk-01', name: 'Python',        description: 'Data Processing & Scripting',   icon: 'python-logo.svg',        order: 0  },
    { id: 'sk-02', name: 'C',             description: 'Low-level Systems Programming', icon: 'c-logo.svg',             order: 1  },
    { id: 'sk-03', name: 'HTML',          description: 'Semantic Core Structures',       icon: 'HTML5-logo.svg',         order: 2  },
    { id: 'sk-04', name: 'CSS',           description: 'Modern Layouts & FX',            icon: 'CSS3-logo.svg',          order: 3  },
    { id: 'sk-05', name: 'JavaScript',    description: 'ES6+ & Web Logic',               icon: 'js-logo.png',            order: 4  },
    { id: 'sk-06', name: 'TypeScript',    description: 'Static Typing & Scale',          icon: 'typescript-logo.svg',    order: 5  },
    { id: 'sk-07', name: 'React',         description: 'Component Architecture',         icon: 'react-logo.svg',         order: 6  },
    { id: 'sk-08', name: 'Node.js',       description: 'Runtime & Server-side JS',       icon: 'nodejs-logo.svg',        order: 7  },
    { id: 'sk-09', name: 'Raspberry Pi',  description: 'IoT & Hardware Prototyping',     icon: 'raspi-logo.svg',         order: 8  },
    { id: 'sk-10', name: 'Blender',       description: '3D Modeling & Rendering',        icon: 'blender-logo.svg',       order: 9  },
    { id: 'sk-11', name: 'Maya',          description: '3D Animation & Modeling',        icon: 'Autodesk_Maya_logo.svg', order: 10 },
    { id: 'sk-12', name: 'Houdini',       description: 'Procedural VFX & Simulation',   icon: 'Houdini3D.png',          order: 11 },
    { id: 'sk-13', name: 'Gaea',          description: 'Terrain & World Generation',     icon: 'Gaea_Logo2_Yellow.svg',  order: 12 },
    { id: 'sk-14', name: 'Unity',         description: 'Game & Asset Development',       icon: 'unity-logo.svg',         order: 13 },
    { id: 'sk-15', name: 'Unreal Engine', description: 'Game & Asset Development',       icon: 'unreal-engine-logo.svg', order: 14 },
];

(function migrate() {
    const tlCount  = db.prepare('SELECT COUNT(*) AS n FROM timeline').get().n;
    if (tlCount === 0) {
        const src = fs.existsSync(TIMELINE_FILE)
            ? JSON.parse(fs.readFileSync(TIMELINE_FILE, 'utf-8'))
            : DEFAULT_TIMELINE;
        const ins = db.prepare('INSERT OR IGNORE INTO timeline (id,date,title,category,href) VALUES (?,?,?,?,?)');
        db.transaction(() => { for (const i of src) ins.run(i.id, i.date, i.title, i.category, i.href ?? null); })();
    }

    const skCount = db.prepare('SELECT COUNT(*) AS n FROM skills').get().n;
    if (skCount === 0) {
        const src = fs.existsSync(SKILLS_FILE)
            ? JSON.parse(fs.readFileSync(SKILLS_FILE, 'utf-8'))
            : DEFAULT_SKILLS;
        const ins = db.prepare('INSERT OR IGNORE INTO skills (id,name,description,icon,sort_order) VALUES (?,?,?,?,?)');
        db.transaction(() => { for (const i of src) ins.run(i.id, i.name, i.description ?? '', i.icon ?? '', i.order ?? 0); })();
    }

    const CERT_NODES_SEED = [
        { id: 'tl-c2',  node_category: 'info',   parent_id: null     },
        { id: 'tl-c3',  node_category: 'info',   parent_id: 'tl-c2'  },
        { id: 'tl-c11', node_category: 'info',   parent_id: 'tl-c3'  },
        { id: 'tl-c6',  node_category: 'info',   parent_id: 'tl-c2'  },
        { id: 'tl-c7',  node_category: 'info',   parent_id: 'tl-c2'  },
        { id: 'tl-c1',  node_category: 'lang',   parent_id: null     },
        { id: 'tl-c4',  node_category: 'math',   parent_id: null     },
        { id: 'tl-c5',  node_category: 'math',   parent_id: null     },
        { id: 'tl-c8',  node_category: 'chem',   parent_id: null     },
        { id: 'tl-c13', node_category: 'chem',   parent_id: null     },
        { id: 'tl-c14', node_category: 'chem',   parent_id: null     },
        { id: 'tl-c9',  node_category: 'info',   parent_id: null     },
        { id: 'tl-c10', node_category: 'info',   parent_id: null     },
        { id: 'tl-c12', node_category: 'design', parent_id: null     },
    ];
    const cnIns = db.prepare('INSERT OR IGNORE INTO cert_nodes (id, node_category, parent_id) VALUES (?, ?, ?)');
    db.transaction(() => { for (const n of CERT_NODES_SEED) cnIns.run(n.id, n.node_category, n.parent_id); })();
    try { db.exec("ALTER TABLE cert_nodes ADD COLUMN extra_label TEXT NOT NULL DEFAULT ''"); } catch {}
    try { db.exec("ALTER TABLE cert_nodes ADD COLUMN extra_value TEXT NOT NULL DEFAULT ''"); } catch {}

    const artCount = db.prepare('SELECT COUNT(*) AS n FROM articles').get().n;
    if (artCount === 0 && fs.existsSync(ARTICLES_DIR)) {
        const files = fs.readdirSync(ARTICLES_DIR).filter(f => f.endsWith('.json'));
        if (files.length > 0) {
            const ins = db.prepare('INSERT OR IGNORE INTO articles (id,title,date,tags,excerpt,content,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)');
            const arts = files.map(f => {
                try { return JSON.parse(fs.readFileSync(path.join(ARTICLES_DIR, f), 'utf-8')); }
                catch { return null; }
            }).filter(Boolean);
            db.transaction(() => {
                for (const a of arts) {
                    ins.run(a.id, a.title, a.date, JSON.stringify(a.tags || []), a.excerpt || '', a.content, a.createdAt || Date.now(), a.updatedAt ?? null);
                }
            })();
        }
    }
})();

// ─── Config ───────────────────────────────────────────────────────────────────
function loadConfig() {
    if (fs.existsSync(CONFIG_FILE)) return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    const pw  = process.env.ADMIN_PASSWORD || 'changeme';
    const cfg = { passwordHash: bcrypt.hashSync(pw, 12), jwtSecret: crypto.randomBytes(48).toString('hex') };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
    log('[INIT] Config created. Set ADMIN_PASSWORD env var to change password.');
    return cfg;
}
const config = loadConfig();

// ─── Rate limiter ─────────────────────────────────────────────────────────────
const loginAttempts = new Map();
function checkRateLimit(ip) {
    const now = Date.now();
    const e   = loginAttempts.get(ip) || { n: 0, reset: now + 15 * 60 * 1000 };
    if (now > e.reset) { e.n = 0; e.reset = now + 15 * 60 * 1000; }
    e.n++;
    loginAttempts.set(ip, e);
    return e.n <= 10;
}

// ─── Auth middleware ──────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
    const h = req.headers.authorization || '';
    if (!h.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
    try { req.user = jwt.verify(h.slice(7), config.jwtSecret); next(); }
    catch { res.status(401).json({ error: 'Invalid token' }); }
}

// ─── Image upload (multer) ────────────────────────────────────────────────────
const ALLOWED_IMG = /\.(svg|png|jpg|jpeg|gif|webp|ico)$/i;

const imgStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, IMG_DIR),
    filename:    (req, file, cb) => {
        const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
        cb(null, safe);
    }
});
const upload = multer({
    storage:    imgStorage,
    limits:     { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => cb(null, ALLOWED_IMG.test(file.originalname))
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
function makeId(title) {
    const a = title.replace(/[^\x00-\x7F]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return (a || 'post') + '-' + Date.now().toString(36);
}

function todayStr() {
    const d = new Date();
    return `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}`;
}

function esc(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function generateHtml(a) {
    const tagsHtml = a.tags.map(t => `<span class="tag-link">#${esc(t)}</span>`).join('\n                  ');
    return `<!doctype html>
<html lang="ja">

<head>
  <meta charset="utf-8">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(a.title)} | Altena Portfolio</title>
  <meta name="description" content="${esc(a.excerpt)}">
  <link rel="icon" href="../../img/favicon.ico">

  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@100..900&family=JetBrains+Mono:ital,wght@0,100..800;1,100..800&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="https://unpkg.com/ress/dist/ress.min.css">
  <link rel="stylesheet" href="../../style.css">
  <script src="../../js/main.js"></script>
</head>

<body>
  <header class="header glass">
    <div class="header-container">
      <a href="../../index.html" class="logo" id="header-logo">
        <span class="slash-icon">//</span>Alt<span class="ena">ena</span>
      </a>
      <button class="hamburger" id="mobile-menu-toggle" aria-label="Toggle navigation">
        <span class="bar"></span>
        <span class="bar"></span>
        <span class="bar"></span>
      </button>
      <nav class="nav">
        <ul>
          <li><a href="../../index.html#skills">Skills</a></li>
          <li><a href="../../index.html#timeline">Timeline</a></li>
          <li><a href="../../myworks.html">Works</a></li>
          <li><a href="../../notes.html">Notes</a></li>
          <li><a href="../../index.html#profile">About</a></li>
        </ul>
      </nav>
    </div>
  </header>

  <main>
    <section class="hero small-hero">
      <div class="hero-content">
        <div class="hero-placeholder"></div>
        <div class="hero-text">
          <h1 class="reveal">${esc(a.title)}</h1>
          <p class="reveal delay-1">${esc(a.date)}</p>
        </div>
      </div>
    </section>

    <div class="content-wrapper">
      <article class="note-detail reveal">
        <div class="note-header-info">
          <div class="note-meta">
            <span class="note-date mono">${esc(a.date)}</span>
            <div class="hashtags">
              ${tagsHtml}
            </div>
          </div>
        </div>

        <div class="note-body glass">
          ${a.content}
        </div>

        <div class="back-home reveal">
          <a href="../../notes.html" class="btn-outline">Back to Notes</a>
        </div>
      </article>
    </div>
  </main>

  <footer class="glass-top">
    <div class="footer-content">
      <p class="mono">© 2026 <a href="/portfolio/admin/login.html" style="color:inherit;text-decoration:none;">Altena</a>. All rights reserved.</p>
    </div>
  </footer>
</body>

</html>`;
}

// ─── Articles ─────────────────────────────────────────────────────────────────
app.get('/articles', (req, res) => {
    const rows = db.prepare('SELECT id,title,date,tags,excerpt,created_at FROM articles ORDER BY created_at DESC').all();
    res.json(rows.map(r => ({ id: r.id, title: r.title, date: r.date, tags: JSON.parse(r.tags), excerpt: r.excerpt, createdAt: r.created_at })));
});

app.get('/articles/:id', (req, res) => {
    const id  = req.params.id.replace(/[^a-zA-Z0-9\-_]/g, '');
    const row = db.prepare('SELECT * FROM articles WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json({ ...row, tags: JSON.parse(row.tags), createdAt: row.created_at, updatedAt: row.updated_at });
});

app.post('/articles', requireAuth, (req, res) => {
    const { title, date, tags, excerpt, content } = req.body;
    if (!title?.trim() || !content?.trim()) return res.status(400).json({ error: 'title and content are required' });
    const id      = makeId(title);
    const tagJson = JSON.stringify(Array.isArray(tags) ? tags.map(t => t.trim()).filter(Boolean) : []);
    const now     = Date.now();
    db.prepare('INSERT INTO articles (id,title,date,tags,excerpt,content,created_at) VALUES (?,?,?,?,?,?,?)').run(
        id, title.trim(), date?.trim() || todayStr(), tagJson, excerpt?.trim() || '', content.trim(), now
    );
    const article = { id, title: title.trim(), date: date?.trim() || todayStr(), tags: JSON.parse(tagJson), excerpt: excerpt?.trim() || '', content: content.trim() };
    const dir = path.join(NOTES_OUT_DIR, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.html'), generateHtml(article));
    res.status(201).json({ id, url: `/portfolio/notes/${id}/` });
});

app.put('/articles/:id', requireAuth, (req, res) => {
    const id  = req.params.id.replace(/[^a-zA-Z0-9\-_]/g, '');
    const row = db.prepare('SELECT * FROM articles WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    const { title, date, tags, excerpt, content } = req.body;
    const tagJson = Array.isArray(tags) ? JSON.stringify(tags.map(t => t.trim()).filter(Boolean)) : row.tags;
    db.prepare('UPDATE articles SET title=?,date=?,tags=?,excerpt=?,content=?,updated_at=? WHERE id=?').run(
        title?.trim()   || row.title,
        date?.trim()    || row.date,
        tagJson,
        excerpt != null ? excerpt.trim() : row.excerpt,
        content?.trim() || row.content,
        Date.now(), id
    );
    const updated = db.prepare('SELECT * FROM articles WHERE id = ?').get(id);
    const article = { ...updated, tags: JSON.parse(updated.tags) };
    const dir = path.join(NOTES_OUT_DIR, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.html'), generateHtml(article));
    res.json({ id, url: `/portfolio/notes/${id}/` });
});

app.delete('/articles/:id', requireAuth, (req, res) => {
    const id  = req.params.id.replace(/[^a-zA-Z0-9\-_]/g, '');
    const row = db.prepare('SELECT id FROM articles WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    db.prepare('DELETE FROM articles WHERE id = ?').run(id);
    const dir = path.join(NOTES_OUT_DIR, id);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true });
    res.json({ ok: true });
});

// ─── Auth ─────────────────────────────────────────────────────────────────────
const EASTER_USER    = process.env.EASTER_USER    || 'lunami';
const EASTER_PASS    = process.env.EASTER_PASS    || 'iroha';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

app.post('/auth/login', (req, res) => {
    const ip = req.ip || req.socket.remoteAddress || '';
    if (!checkRateLimit(ip)) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
    const { username, password } = req.body || {};
    if (!password) return res.status(400).json({ error: 'Password required' });

    if ((username || '').toLowerCase() === EASTER_USER && password === EASTER_PASS) {
        const token = jwt.sign({ easter: true }, config.jwtSecret, { expiresIn: '5m' });
        return res.json({ type: 'easter', token });
    }

    if (!bcrypt.compareSync(password, config.passwordHash)) return res.status(401).json({ error: 'Invalid password' });
    const token = jwt.sign({ admin: true }, config.jwtSecret, { expiresIn: '24h' });
    res.json({ token });
});

app.get('/auth/verify', requireAuth, (req, res) => res.json({ valid: true }));

app.get('/easter', (req, res) => {
    const raw = req.query.token;
    if (!raw) return res.status(401).send('<p>Unauthorized</p>');
    try {
        const payload = jwt.verify(raw, config.jwtSecret);
        if (!payload.easter) return res.status(403).send('<p>Forbidden</p>');
    } catch { return res.status(401).send('<p>Token expired or invalid</p>'); }
    if (!fs.existsSync(EASTER_FILE)) return res.status(404).send('<p>Not found</p>');
    // Inject a session token so easter.html can call /fushi/chat
    const sessionToken = jwt.sign({ fushi: true }, config.jwtSecret, { expiresIn: '2h' });
    const html = fs.readFileSync(EASTER_FILE, 'utf-8');
    const injected = html.replace('<!-- __FUSHI_TOKEN__ -->', `<script>window.__FUSHI_TOKEN__='${sessionToken}';</script>`);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(injected);
});

// ─── Gemini proxy helpers ─────────────────────────────────────────────────────
function httpsReq(url, opts, body) {
    return new Promise((resolve, reject) => {
        const u   = new URL(url);
        const req = https.request(
            { hostname: u.hostname, path: u.pathname + u.search, method: opts.method || 'GET',
              headers: opts.headers || {} },
            res => {
                let buf = '';
                res.on('data', c => buf += c);
                res.on('end', () => {
                    try { resolve({ status: res.statusCode, json: JSON.parse(buf) }); }
                    catch { resolve({ status: res.statusCode, json: null }); }
                });
            }
        );
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

function geminiExtract(text) {
    const markers = /User input:|Character:|Admin:|Context:|Style:|Emotional tone:|Calm\?|Understated\?|Lowercase\?|Address/i;
    if (!markers.test(text)) return text.trim();
    const quotes = [...text.matchAll(/"([^"]{4,})"/g)];
    if (quotes.length) return quotes[quotes.length - 1][1].trim();
    const afterEval = text.match(/(?:Yes\.\s*)+(.+)$/s);
    if (afterEval) return afterEval[1].trim().replace(/^"|"$/g, '');
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
        if (!markers.test(lines[i]) && lines[i].length > 4) return lines[i].replace(/^"|"$/g, '');
    }
    return text.trim();
}

async function callGemini(input, sysPrompt) {
    const key = GEMINI_API_KEY;
    if (!key) return null;
    const modelsRes = await httpsReq(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`, {});
    if (modelsRes.status !== 200 || !modelsRes.json) return null;
    const models = (modelsRes.json.models || [])
        .filter(m => Array.isArray(m.supportedGenerationMethods) &&
                     m.supportedGenerationMethods.includes('generateContent') &&
                     !m.name.includes('thinking') && !m.name.includes('embedding') && !m.name.includes('aqa'))
        .map(m => m.name);
    for (const model of models) {
        try {
            const body = JSON.stringify({
                system_instruction: { parts: [{ text: sysPrompt }] },
                contents: [{ role: 'user', parts: [{ text: input }] }],
                generationConfig: { maxOutputTokens: 1024 }
            });
            const r = await httpsReq(
                `https://generativelanguage.googleapis.com/v1beta/${model}:generateContent?key=${key}`,
                { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
                body
            );
            if (r.status === 429 || r.status === 503 || !r.json) continue;
            const raw = r.json.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
            if (!raw) continue;
            const cleaned = raw.replace(/\*\*(.+?)\*\*/g, '$1').replace(/^\s*[\*\-]\s+/gm, '').trim();
            return geminiExtract(cleaned);
        } catch { continue; }
    }
    return null;
}

// ─── Fushi chat proxy ─────────────────────────────────────────────────────────
app.post('/fushi/chat', async (req, res) => {
    const h = req.headers.authorization || '';
    if (!h.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const payload = jwt.verify(h.slice(7), config.jwtSecret);
        if (!payload.fushi) return res.status(403).json({ error: 'Forbidden' });
    } catch { return res.status(401).json({ error: 'Token expired' }); }
    if (!GEMINI_API_KEY) return res.status(503).json({ error: 'API not configured' });
    const { input, systemPrompt } = req.body || {};
    if (!input || !systemPrompt) return res.status(400).json({ error: 'Missing fields' });
    if (input.length > 2000 || systemPrompt.length > 30000) return res.status(400).json({ error: 'Too long' });
    try {
        const text = await callGemini(String(input), String(systemPrompt));
        res.json({ text: text || null });
    } catch (e) {
        err('[fushi/chat]', e.message);
        res.status(500).json({ error: 'Upstream error' });
    }
});

// ─── System monitoring ────────────────────────────────────────────────────────
const SYS_CMDS = { free: 'free -h', df: 'df -h', uptime: 'uptime', top: 'ps aux --sort=-%cpu | head -16', ps: 'ps aux --sort=-%mem | head -16', date: 'date', uname: 'uname -a', whoami: null };

app.get('/system/:cmd', requireAuth, (req, res) => {
    const cmd = req.params.cmd.toLowerCase().replace(/[^a-z]/g, '');
    if (cmd === 'whoami') return res.json({ output: 'admin\n' });
    if (!SYS_CMDS[cmd]) return res.status(404).json({ error: `${cmd}: command not found` });
    try {
        const out = execSync(SYS_CMDS[cmd], { encoding: 'utf-8', timeout: 5000 });
        res.json({ output: out });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Timeline ─────────────────────────────────────────────────────────────────
app.get('/timeline', (req, res) => {
    res.json(db.prepare('SELECT * FROM timeline ORDER BY date ASC').all());
});

app.post('/timeline', requireAuth, (req, res) => {
    const { date, title, category, href } = req.body;
    if (!date?.trim() || !title?.trim() || !category?.trim()) return res.status(400).json({ error: 'date, title, category are required' });
    const id   = 'tl-' + Date.now().toString(36);
    const item = { id, date: date.trim(), title: title.trim(), category: category.trim(), href: href?.trim() || null };
    db.prepare('INSERT INTO timeline (id,date,title,category,href) VALUES (?,?,?,?,?)').run(item.id, item.date, item.title, item.category, item.href);
    res.status(201).json(item);
});

app.put('/timeline/:id', requireAuth, (req, res) => {
    const row = db.prepare('SELECT * FROM timeline WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    const { date, title, category, href } = req.body;
    const updated = {
        date:     date?.trim()     || row.date,
        title:    title?.trim()    || row.title,
        category: category?.trim() || row.category,
        href:     href !== undefined ? (href?.trim() || null) : row.href,
    };
    db.prepare('UPDATE timeline SET date=?,title=?,category=?,href=? WHERE id=?').run(updated.date, updated.title, updated.category, updated.href, req.params.id);
    res.json({ id: req.params.id, ...updated });
});

app.delete('/timeline/:id', requireAuth, (req, res) => {
    const row = db.prepare('SELECT id FROM timeline WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    db.prepare('DELETE FROM timeline WHERE id = ?').run(req.params.id);
    db.prepare('DELETE FROM cert_nodes WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
});

// ─── Skills ───────────────────────────────────────────────────────────────────
app.get('/skills', (req, res) => {
    res.json(db.prepare('SELECT * FROM skills ORDER BY sort_order ASC').all());
});

app.post('/skills', requireAuth, (req, res) => {
    const { name, description, icon, order } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
    const maxOrder = db.prepare('SELECT MAX(sort_order) AS m FROM skills').get().m ?? -1;
    const id   = 'sk-' + Date.now().toString(36);
    const item = { id, name: name.trim(), description: description?.trim() || '', icon: icon?.trim() || '', sort_order: typeof order === 'number' ? order : maxOrder + 1 };
    db.prepare('INSERT INTO skills (id,name,description,icon,sort_order) VALUES (?,?,?,?,?)').run(item.id, item.name, item.description, item.icon, item.sort_order);
    res.status(201).json(item);
});

app.put('/skills/:id', requireAuth, (req, res) => {
    const row = db.prepare('SELECT * FROM skills WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    const { name, description, icon, order } = req.body;
    const updated = {
        name:        name?.trim()        || row.name,
        description: description !== undefined ? (description?.trim() ?? '') : row.description,
        icon:        icon !== undefined  ? (icon?.trim() ?? '')        : row.icon,
        sort_order:  typeof order === 'number' ? order : row.sort_order,
    };
    db.prepare('UPDATE skills SET name=?,description=?,icon=?,sort_order=? WHERE id=?').run(updated.name, updated.description, updated.icon, updated.sort_order, req.params.id);
    res.json({ id: req.params.id, ...updated });
});

app.delete('/skills/:id', requireAuth, (req, res) => {
    const row = db.prepare('SELECT id FROM skills WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    db.prepare('DELETE FROM skills WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
});

// ─── Images ───────────────────────────────────────────────────────────────────
app.get('/images', requireAuth, (req, res) => {
    if (!fs.existsSync(IMG_DIR)) return res.json([]);
    const files = fs.readdirSync(IMG_DIR)
        .filter(f => ALLOWED_IMG.test(f))
        .sort()
        .map(f => ({ name: f, url: `/portfolio/img/${f}` }));
    res.json(files);
});

app.post('/images', requireAuth, upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file or type not allowed' });
    res.status(201).json({ name: req.file.filename, url: `/portfolio/img/${req.file.filename}` });
});

app.put('/images/:name', requireAuth, (req, res) => {
    const oldName = req.params.name.replace(/[^a-zA-Z0-9._-]/g, '');
    const newName = String(req.body.name || '').replace(/[^a-zA-Z0-9._-]/g, '');
    if (!oldName || !newName) return res.status(400).json({ error: 'Invalid filename' });
    if (!ALLOWED_IMG.test(newName)) return res.status(400).json({ error: 'Extension not allowed' });
    const oldPath = path.join(IMG_DIR, oldName);
    const newPath = path.join(IMG_DIR, newName);
    if (!fs.existsSync(oldPath)) return res.status(404).json({ error: 'Not found' });
    if (fs.existsSync(newPath) && oldName !== newName) return res.status(409).json({ error: 'File already exists' });
    fs.renameSync(oldPath, newPath);
    res.json({ name: newName, url: `/portfolio/img/${newName}` });
});

app.delete('/images/:name', requireAuth, (req, res) => {
    const name     = req.params.name.replace(/[^a-zA-Z0-9._-]/g, '');
    const filePath = path.join(IMG_DIR, name);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
    fs.unlinkSync(filePath);
    res.json({ ok: true });
});

// ─── Cert Nodes ───────────────────────────────────────────────────────────────
app.get('/cert-nodes', (req, res) => {
    res.json(db.prepare('SELECT * FROM cert_nodes').all());
});

app.put('/cert-nodes/:id', requireAuth, (req, res) => {
    const { id } = req.params;
    const { node_category, parent_id, extra_label, extra_value } = req.body;
    if (!node_category?.trim()) return res.status(400).json({ error: 'node_category is required' });
    db.prepare(`
        INSERT INTO cert_nodes (id, node_category, parent_id, extra_label, extra_value) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          node_category = excluded.node_category,
          parent_id     = excluded.parent_id,
          extra_label   = excluded.extra_label,
          extra_value   = excluded.extra_value
    `).run(id, node_category.trim(), parent_id?.trim() || null, extra_label?.trim() || '', extra_value?.trim() || '');
    res.json(db.prepare('SELECT * FROM cert_nodes WHERE id = ?').get(id));
});

// ─── Cert Plans ───────────────────────────────────────────────────────────────
app.get('/cert-plans', (req, res) => {
    res.json(db.prepare('SELECT * FROM cert_plans ORDER BY rowid ASC').all());
});

app.post('/cert-plans', requireAuth, (req, res) => {
    const { title, node_category, parent_id, extra_label, extra_value } = req.body;
    if (!title?.trim()) return res.status(400).json({ error: 'title is required' });
    const id = 'plan-' + Date.now().toString(36);
    db.prepare('INSERT INTO cert_plans (id,title,node_category,parent_id,extra_label,extra_value) VALUES (?,?,?,?,?,?)')
        .run(id, title.trim(), node_category?.trim() || 'info', parent_id?.trim() || null, extra_label?.trim() || '', extra_value?.trim() || '');
    res.status(201).json(db.prepare('SELECT * FROM cert_plans WHERE id = ?').get(id));
});

app.put('/cert-plans/:id', requireAuth, (req, res) => {
    const { id } = req.params;
    if (!db.prepare('SELECT id FROM cert_plans WHERE id = ?').get(id)) return res.status(404).json({ error: 'Not found' });
    const { title, node_category, parent_id, extra_label, extra_value } = req.body;
    if (!title?.trim()) return res.status(400).json({ error: 'title is required' });
    db.prepare('UPDATE cert_plans SET title=?,node_category=?,parent_id=?,extra_label=?,extra_value=? WHERE id=?')
        .run(title.trim(), node_category?.trim() || 'info', parent_id?.trim() || null, extra_label?.trim() || '', extra_value?.trim() || '', id);
    res.json(db.prepare('SELECT * FROM cert_plans WHERE id = ?').get(id));
});

app.delete('/cert-plans/:id', requireAuth, (req, res) => {
    const { id } = req.params;
    if (!db.prepare('SELECT id FROM cert_plans WHERE id = ?').get(id)) return res.status(404).json({ error: 'Not found' });
    db.prepare('DELETE FROM cert_plans WHERE id = ?').run(id);
    res.json({ ok: true });
});

// ─── System Status (public) ───────────────────────────────────────────────────
app.get('/status', (req, res) => {
    try {
        const uptimeSec = parseFloat(fs.readFileSync('/proc/uptime', 'utf8').split(' ')[0]);
        const days  = Math.floor(uptimeSec / 86400);
        const hours = Math.floor((uptimeSec % 86400) / 3600);

        const nginxRaw = execSync('nginx -v 2>&1').toString();
        const nginx = nginxRaw.match(/nginx\/([\d.]+)/)?.[1] ?? 'unknown';

        let tls = 'unknown';
        try {
            const enddate = execSync(
                "echo | openssl s_client -connect altena.me:443 -servername altena.me 2>/dev/null | openssl x509 -noout -enddate",
                { timeout: 8000 }
            ).toString();
            const m = enddate.match(/notAfter=(.+)/);
            if (m) tls = new Date(m[1]) > new Date() ? 'valid' : 'expired';
        } catch { /* tls check failed */ }

        res.json({ status: 'ONLINE', uptime: { days, hours }, nginx, tls });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ─── Catch-all ────────────────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '127.0.0.1', () => log(`[BOOT] Portfolio API listening on 127.0.0.1:${PORT}`));
