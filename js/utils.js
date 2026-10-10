// ─────────────────────────────────────────────────────────────
// Shared utilities — loaded before main.js / notes.js
// ─────────────────────────────────────────────────────────────

function escHtml(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// Renders a single note card <a> element and returns it.
// index は呼び出し側の Array.prototype.map が自動で渡す並び順（0始まり）。
// カード右上の参照タブ（LOG-001 等）はこの表示順から振るだけの連番で、
// 記事の恒久 ID ではない — フィルタや検索で表示順が変われば番号も変わる。
function buildNoteCard(article, index = 0) {
    const tagsHtml = (article.tags || [])
        .map(t => `<span class="tag-link">#${escHtml(t)}</span>`)
        .join('');
    const ref = `LOG-${String(index + 1).padStart(3, '0')}`;
    const a = document.createElement('a');
    // URL is a server-authoritative publication capability. Never reconstruct it from id.
    a.href      = typeof article.url === 'string' && article.url ? article.url : '#';
    if (a.href.endsWith('#')) {
        a.setAttribute('aria-disabled', 'true');
        a.addEventListener('click', event => event.preventDefault());
    }
    a.className = 'note-card';
    a.dataset.ref = ref;
    a.innerHTML = `
        <span class="note-date">${escHtml(article.date)}</span>
        <h3>${escHtml(article.title)}</h3>
        <p class="note-excerpt">${escHtml(article.excerpt || '')}</p>
        <div class="hashtags">${tagsHtml}</div>`;
    return a;
}
