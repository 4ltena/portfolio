'use strict';

const { randomInt } = require('node:crypto');

const PATTERN_COUNT = 10;

function createArticleCovers(db, randomIndex = randomInt) {
    // 公開中の直近3件だけでは同じ構図を使わない。下書きと限定公開は一覧の連続性に影響しない。
    db.exec(`CREATE TABLE IF NOT EXISTS article_covers (
        assignment_order INTEGER PRIMARY KEY AUTOINCREMENT,
        article_id TEXT NOT NULL UNIQUE,
        cover_pattern INTEGER NOT NULL
            CHECK (cover_pattern BETWEEN 0 AND 9 AND typeof(cover_pattern) = 'integer')
    )`);
    const find = db.prepare('SELECT cover_pattern FROM article_covers WHERE article_id = ?');
    const latestPublic = db.prepare(`SELECT c.cover_pattern FROM articles a
        JOIN article_covers c ON c.article_id = a.id
        WHERE a.visibility = 'public'
        ORDER BY a.published_at DESC, a.id DESC LIMIT 3`);
    const latestOtherPublic = db.prepare(`SELECT c.cover_pattern FROM articles a
        JOIN article_covers c ON c.article_id = a.id
        WHERE a.visibility = 'public' AND a.id != ?
        ORDER BY a.published_at DESC, a.id DESC LIMIT 3`);
    const insert = db.prepare('INSERT INTO article_covers (article_id, cover_pattern) VALUES (?, ?)');
    const update = db.prepare('UPDATE article_covers SET cover_pattern = ? WHERE article_id = ?');

    function available(exceptId = null) {
        const recent = exceptId ? latestOtherPublic.all(exceptId) : latestPublic.all();
        const excluded = new Set(recent.map(row => row.cover_pattern));
        return Array.from({ length: PATTERN_COUNT }, (_, i) => i).filter(i => !excluded.has(i));
    }

    function assign(id) {
        const existing = find.get(id);
        if (existing) return existing.cover_pattern;
        const choices = available();
        const pattern = choices[randomIndex(choices.length)];
        insert.run(id, pattern);
        return pattern;
    }

    function reroll(id) {
        if (!find.get(id)) throw new Error('Unknown article cover');
        const choices = available(id);
        const pattern = choices[randomIndex(choices.length)];
        update.run(pattern, id);
        return pattern;
    }

    db.transaction(() => {
        for (const article of db.prepare('SELECT id FROM articles ORDER BY created_at ASC, id ASC').all()) {
            assign(article.id);
        }
    })();
    return { assign, reroll };
}

module.exports = { createArticleCovers, PATTERN_COUNT };
