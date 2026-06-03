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
function buildNoteCard(article) {
    const tagsHtml = (article.tags || [])
        .map(t => `<span class="tag-link">#${escHtml(t)}</span>`)
        .join('');
    const a = document.createElement('a');
    a.href      = `/portfolio/notes/${escHtml(article.id)}/`;
    a.className = 'note-card glass';
    a.innerHTML = `
        <div class="note-meta">
            <span class="note-date">${escHtml(article.date)}</span>
            <div class="hashtags">${tagsHtml}</div>
        </div>
        <h3>${escHtml(article.title)}</h3>
        <p class="note-excerpt">${escHtml(article.excerpt || '')}</p>`;
    return a;
}
