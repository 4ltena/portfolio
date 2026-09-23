'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const sanitizeHtmlLibrary = require('sanitize-html');

const MIGRATION_ID = '20260922_notes_visibility_v1';
const VISIBILITIES = new Set(['public', 'unlisted', 'draft']);
const ARTICLE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_TITLE = 160;
const MAX_EXCERPT = 500;
const MAX_TAGS = 12;
const MAX_TAG = 40;
const MAX_CONTENT_BYTES = 200 * 1024;

function sanitizeHtml(input) {
    return sanitizeHtmlLibrary(String(input || ''), {
        allowedTags: ['p', 'br', 'strong', 'em', 'b', 'i', 'u', 's', 'ul', 'ol', 'li', 'h2', 'h3', 'h4', 'blockquote', 'pre', 'code', 'hr', 'a', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'img'],
        allowedAttributes: {
            a: ['href', 'title', 'rel'],
            img: ['src', 'alt', 'title', 'width', 'height'],
            th: ['colspan', 'rowspan'],
            td: ['colspan', 'rowspan']
        },
        allowedSchemes: ['http', 'https', 'mailto'],
        allowedSchemesByTag: { img: ['http', 'https'] },
        allowProtocolRelative: false,
        exclusiveFilter(frame) {
            if (frame.tag !== 'img') return false;
            const src = frame.attribs.src || '';
            return !(/^\/portfolio\/img\/[A-Za-z0-9._/-]+$/i.test(src) || /^https?:\/\/[^\s]+$/i.test(src));
        },
        transformTags: {
            a(tagName, attribs) {
                if (/^https?:\/\//i.test(attribs.href || '')) attribs.rel = 'noopener noreferrer';
                return { tagName, attribs };
            }
        }
    });
}

function assertArticleId(id) {
    if (typeof id !== 'string' || !ARTICLE_ID.test(id)) throw new Error('Invalid article id');
    return id;
}

function normalizeArticlePayload(payload, previous = null) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Invalid article payload');
    const allowed = new Set(['title', 'date', 'tags', 'excerpt', 'content', 'visibility']);
    for (const key of Object.keys(payload)) if (!allowed.has(key)) throw new Error(`Unknown article field: ${key}`);
    const value = (key, fallback) => Object.prototype.hasOwnProperty.call(payload, key) ? payload[key] : fallback;
    const title = value('title', previous?.title);
    const date = value('date', previous?.date);
    const tags = value('tags', previous?.tags);
    const excerpt = value('excerpt', previous?.excerpt);
    const rawContent = value('content', previous?.content);
    const visibility = value('visibility', previous?.visibility || 'draft');
    if (typeof title !== 'string' || !title.trim() || title.trim().length > MAX_TITLE) throw new Error('Invalid title');
    if (typeof date !== 'string' || !/^\d{4}\/\d{2}\/\d{2}$/.test(date)) throw new Error('Invalid date');
    const [year, month, day] = date.split('/').map(Number);
    const parsedDate = new Date(Date.UTC(year, month - 1, day));
    if (year < 1 || parsedDate.getUTCFullYear() !== year || parsedDate.getUTCMonth() !== month - 1 || parsedDate.getUTCDate() !== day) {
        throw new Error('Invalid date');
    }
    if (!Array.isArray(tags) || tags.length > MAX_TAGS || tags.some(tag => typeof tag !== 'string' || !tag.trim() || tag.trim().length > MAX_TAG)) throw new Error('Invalid tags');
    if (typeof excerpt !== 'string' || excerpt.length > MAX_EXCERPT) throw new Error('Invalid excerpt');
    if (typeof rawContent !== 'string' || Buffer.byteLength(rawContent, 'utf8') < 1 || Buffer.byteLength(rawContent, 'utf8') > MAX_CONTENT_BYTES) throw new Error('Invalid content');
    if (!VISIBILITIES.has(visibility)) throw new Error('Invalid visibility');
    const content = sanitizeHtml(rawContent);
    if (!content.trim()) throw new Error('Content is empty after sanitization');
    return { title: title.trim(), date, tags: [...new Set(tags.map(tag => tag.trim()))], excerpt: excerpt.trim(), content, visibility };
}

function contentHash(content) {
    return crypto.createHash('sha256').update(String(content), 'utf8').digest('hex');
}

function nextPublishedAt(previous, targetVisibility, now) {
    if (!VISIBILITIES.has(targetVisibility)) throw new Error('Invalid visibility');
    if (!previous) return targetVisibility === 'public' ? now : null;
    if (previous.visibility === 'public') return previous.published_at ?? previous.publishedAt ?? now;
    if (targetVisibility === 'public') return now;
    return previous.published_at ?? previous.publishedAt ?? null;
}

function articleView(row, includeContent = false) {
    const visibility = row.visibility;
    const base = {
        id: row.id,
        title: row.title,
        date: row.date,
        tags: typeof row.tags === 'string' ? JSON.parse(row.tags) : row.tags,
        excerpt: row.excerpt,
        visibility,
        coverPattern: row.cover_pattern ?? row.coverPattern ?? null,
        createdAt: row.created_at ?? row.createdAt,
        updatedAt: row.updated_at ?? row.updatedAt ?? null,
        publishedAt: row.published_at ?? row.publishedAt ?? null,
        // 共有URLは管理操作でのみ署名付きで発行する。限定公開・下書きへ一般URLを渡さない。
        url: visibility === 'public' ? `/portfolio/notes/${row.id}/` : null
    };
    return includeContent ? { ...base, content: sanitizeHtml(row.content) } : base;
}

const MANAGED_MARKER = '.portfolio-note-managed-v1';

function targetDirectory(outputRoot, id) { return path.join(outputRoot, assertArticleId(id)); }
function markerPath(directory) { return path.join(directory, MANAGED_MARKER); }
function isManagedDirectory(directory, id, io = fs) {
    try { return io.readFileSync(markerPath(directory), 'utf8').trim() === `article:${id}`; }
    catch { return false; }
}
function assertPublishTargetManagedOrAbsent(outputRoot, id, io = fs) {
    const target = targetDirectory(outputRoot, id);
    if (io.existsSync(target) && !isManagedDirectory(target, id, io)) {
        throw new Error('Refusing to replace unmanaged article output');
    }
}
function temporaryDirectory(outputRoot, id, kind) {
    return path.join(outputRoot, `.${id}.${kind}-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
}
function syncPath(filename, io = fs) {
    const fd = io.openSync(filename, 'r');
    try { io.fsyncSync(fd); } finally { io.closeSync(fd); }
}
function writeStagedArticle(outputRoot, id, html, io = fs) {
    const directory = temporaryDirectory(outputRoot, id, 'pending');
    io.mkdirSync(directory, { recursive: false });
    try {
        io.writeFileSync(markerPath(directory), `article:${id}\n`, { mode: 0o600, flag: 'wx' });
        syncPath(markerPath(directory), io);
        io.writeFileSync(path.join(directory, 'index.html'), html, { mode: 0o644, flag: 'wx' });
        syncPath(path.join(directory, 'index.html'), io);
        syncPath(directory, io);
        syncPath(outputRoot, io);
        return directory;
    } catch (error) {
        if (isManagedDirectory(directory, id, io)) io.rmSync(directory, { recursive: true, force: true });
        throw error;
    }
}
function quarantineManagedDirectory(outputRoot, id, io = fs) {
    const current = targetDirectory(outputRoot, id);
    if (!io.existsSync(current)) return null;
    if (!isManagedDirectory(current, id, io)) throw new Error('Refusing to move unmanaged article output');
    const quarantine = temporaryDirectory(outputRoot, id, 'quarantine');
    io.renameSync(current, quarantine);
    syncPath(outputRoot, io);
    return quarantine;
}
function removeManagedDirectory(directory, id, io = fs) {
    if (!directory || !io.existsSync(directory)) return false;
    if (!isManagedDirectory(directory, id, io)) throw new Error('Refusing to remove unmanaged article output');
    io.rmSync(directory, { recursive: true, force: false });
    return true;
}
function activateStagedArticle(outputRoot, id, staged, io = fs) {
    const target = targetDirectory(outputRoot, id);
    let backup = null;
    try {
        if (io.existsSync(target)) {
            if (!isManagedDirectory(target, id, io)) throw new Error('Refusing to replace unmanaged article output');
            backup = temporaryDirectory(outputRoot, id, 'previous');
            io.renameSync(target, backup);
            syncPath(outputRoot, io);
        }
        io.renameSync(staged, target);
        syncPath(outputRoot, io);
        return { target, backup };
    } catch (error) {
        if (io.existsSync(target) && isManagedDirectory(target, id, io)) {
            io.rmSync(target, { recursive: true, force: false });
        }
        if (backup && io.existsSync(backup) && !io.existsSync(target)) {
            io.renameSync(backup, target);
            syncPath(outputRoot, io);
        }
        throw error;
    }
}

function rollbackActivatedArticle(outputRoot, id, activation, io = fs) {
    if (!activation) return;
    const target = targetDirectory(outputRoot, id);
    if (io.existsSync(target)) removeManagedDirectory(target, id, io);
    if (activation.backup && io.existsSync(activation.backup)) {
        if (io.existsSync(target)) throw new Error('Cannot restore previous article output');
        io.renameSync(activation.backup, target);
        syncPath(outputRoot, io);
    }
}

function commitActivatedArticle(id, activation, io = fs) {
    if (activation?.backup) removeManagedDirectory(activation.backup, id, io);
}

function restoreQuarantinedDirectory(outputRoot, id, quarantine, io = fs) {
    if (!quarantine || !io.existsSync(quarantine)) return;
    const target = targetDirectory(outputRoot, id);
    if (io.existsSync(target)) throw new Error('Cannot restore quarantined article output');
    io.renameSync(quarantine, target);
    syncPath(outputRoot, io);
}

// Compatibility helper for the legacy publisher. New publication code keeps the backup
// until its database transaction and all fallible cleanup steps have completed.
function promoteStagedArticle(outputRoot, id, staged, io = fs) {
    const activation = activateStagedArticle(outputRoot, id, staged, io);
    commitActivatedArticle(id, activation, io);
}

function migrateNotesSchema(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at INTEGER NOT NULL
    )`);
    const applied = db.prepare('SELECT id FROM schema_migrations WHERE id = ?').get(MIGRATION_ID);
    const columns = new Map(db.prepare('PRAGMA table_info(articles)').all().map(column => [column.name, column]));
    const required = ['visibility', 'published_at', 'share_version'];
    if (applied && required.some(name => !columns.has(name))) throw new Error('Notes migration record does not match articles schema');
    if (applied) return false;
    db.transaction(() => {
        const current = new Set(db.prepare('PRAGMA table_info(articles)').all().map(column => column.name));
        if (!current.has('visibility')) db.exec("ALTER TABLE articles ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','unlisted','draft'))");
        if (!current.has('published_at')) db.exec('ALTER TABLE articles ADD COLUMN published_at INTEGER');
        if (!current.has('share_version')) db.exec('ALTER TABLE articles ADD COLUMN share_version INTEGER NOT NULL DEFAULT 0');
        const verified = new Set(db.prepare('PRAGMA table_info(articles)').all().map(column => column.name));
        for (const name of required) if (!verified.has(name)) throw new Error(`Notes migration missing ${name}`);
        db.exec(`CREATE TABLE IF NOT EXISTS article_publication_jobs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            article_id TEXT NOT NULL,
            operation TEXT NOT NULL CHECK (operation IN ('publish','unpublish','delete')),
            target_visibility TEXT NOT NULL CHECK (target_visibility IN ('public','unlisted','draft')),
            stage TEXT NOT NULL CHECK (stage IN ('pending','database_committed','complete')),
            expected_updated_at INTEGER NOT NULL,
            content_hash TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        )`);
        db.prepare("UPDATE articles SET visibility = 'public', published_at = COALESCE(published_at, created_at), share_version = COALESCE(share_version, 0)").run();
        db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run(MIGRATION_ID, Date.now());
    })();
    return true;
}

function makeShareSignature(secret, id, shareVersion) {
    assertArticleId(id);
    if (!Number.isSafeInteger(shareVersion) || shareVersion < 0) throw new Error('Invalid share version');
    return crypto.createHmac('sha256', secret).update(`note-share-v1:${id}:${shareVersion}`).digest('base64url');
}

function hasValidShareSignature(secret, id, shareVersion, candidate) {
    if (typeof candidate !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(candidate)) return false;
    const expected = makeShareSignature(secret, id, shareVersion);
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(candidate));
}

function makePublicationJob(db, article, operation, targetVisibility, now = Date.now()) {
    const result = db.prepare(`INSERT INTO article_publication_jobs
        (article_id, operation, target_visibility, stage, expected_updated_at, content_hash, created_at, updated_at)
        VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)`).run(
        article.id, operation, targetVisibility, article.updated_at, contentHash(article.content), now, now);
    return Number(result.lastInsertRowid);
}

module.exports = {
    MIGRATION_ID, VISIBILITIES, sanitizeHtml, normalizeArticlePayload, contentHash,
    migrateNotesSchema, makeShareSignature, hasValidShareSignature, makePublicationJob, nextPublishedAt,
    assertArticleId, articleView, MANAGED_MARKER, targetDirectory, isManagedDirectory, assertPublishTargetManagedOrAbsent,
    writeStagedArticle, quarantineManagedDirectory, removeManagedDirectory, promoteStagedArticle,
    activateStagedArticle, rollbackActivatedArticle, commitActivatedArticle, restoreQuarantinedDirectory, syncPath
};
