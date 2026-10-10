'use strict';

const fs = require('node:fs');
const path = require('node:path');

// 記事と構図を同時に保存し、HTMLの書き込み失敗時には今回の作成分だけを戻す。
function publishArticle(db, covers, article, directory, html, io = fs) {
    let createdDirectory = false;
    const filename = path.join(directory, 'index.html');
    try {
        io.mkdirSync(directory);
        createdDirectory = true;
        return db.transaction(() => {
            db.prepare(`INSERT INTO articles (id,title,date,tags,excerpt,content,created_at)
                VALUES (?,?,?,?,?,?,?)`).run(article.id, article.title, article.date,
                JSON.stringify(article.tags), article.excerpt, article.content, article.createdAt);
            const coverPattern = covers.assign(article.id);
            io.writeFileSync(filename, html, { flag: 'wx' });
            return coverPattern;
        })();
    } catch (error) {
        if (createdDirectory) {
            try { io.unlinkSync(filename); } catch (cleanup) {
                if (cleanup.code !== 'ENOENT') console.error('Article file cleanup failed:', cleanup.code);
            }
            try { io.rmdirSync(directory); } catch (cleanup) {
                console.error('Article directory cleanup failed:', cleanup.code);
            }
        }
        throw error;
    }
}

module.exports = { publishArticle };
