'use strict';

const { randomInt } = require('node:crypto');

const PATTERN_COUNT = 10;

function createArticleCovers(db, randomIndex = randomInt) {
    // 削除済み記事の割り当ても、直近3回の履歴として保持する。
    db.exec(`CREATE TABLE IF NOT EXISTS article_covers (
        assignment_order INTEGER PRIMARY KEY AUTOINCREMENT,
        article_id TEXT NOT NULL UNIQUE,
        cover_pattern INTEGER NOT NULL
            CHECK (cover_pattern BETWEEN 0 AND 9 AND typeof(cover_pattern) = 'integer')
    )`);
    const find = db.prepare('SELECT cover_pattern FROM article_covers WHERE article_id = ?');
    const recent = db.prepare('SELECT cover_pattern FROM article_covers ORDER BY assignment_order DESC LIMIT 3');
    const latest = db.prepare(`SELECT c.cover_pattern FROM articles a
        JOIN article_covers c ON c.article_id = a.id
        ORDER BY a.created_at DESC, a.id DESC LIMIT 3`);
    const insert = db.prepare('INSERT INTO article_covers (article_id, cover_pattern) VALUES (?, ?)');

    function assign(id) {
        const existing = find.get(id);
        if (existing) return existing.cover_pattern;
        const excluded = new Set([...recent.all(), ...latest.all()].map(row => row.cover_pattern));
        const choices = Array.from({ length: PATTERN_COUNT }, (_, i) => i).filter(i => !excluded.has(i));
        const pattern = choices[randomIndex(choices.length)];
        insert.run(id, pattern);
        return pattern;
    }

    db.transaction(() => {
        for (const article of db.prepare('SELECT id FROM articles ORDER BY created_at ASC, id ASC').all()) {
            assign(article.id);
        }
    })();
    return { assign };
}

module.exports = { createArticleCovers, PATTERN_COUNT };
