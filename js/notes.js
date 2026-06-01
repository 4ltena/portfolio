'use strict';

document.addEventListener('DOMContentLoaded', async () => {
    const grid         = document.getElementById('note-grid');
    const searchInput  = document.getElementById('notes-search');
    const clearBtn     = document.getElementById('clear-search');
    const tagCloud     = document.getElementById('tag-cloud');
    const visibleCount = document.getElementById('visible-notes-count');
    const totalCount   = document.getElementById('total-notes-count');
    const adminBar     = document.getElementById('admin-bar');

    let allArticles = [];
    let activeTag   = null;

    // --- Admin bar visibility ---
    const token = localStorage.getItem('admin_token');
    if (token) {
        fetch('/portfolio/api/auth/verify', {
            headers: { Authorization: `Bearer ${token}` }
        }).then(r => {
            if (r.ok && adminBar) adminBar.style.display = 'flex';
        }).catch(() => {});
    }

    // --- Fetch articles ---
    try {
        const r = await fetch('/portfolio/api/articles');
        if (!r.ok) throw new Error('API error');
        allArticles = await r.json();
    } catch {
        grid.innerHTML = '<p class="empty-list" style="padding:2rem 0;color:var(--text-secondary);font-family:var(--font-mono);font-size:.85rem;opacity:.5">Failed to load articles.</p>';
        return;
    }

    if (totalCount) totalCount.textContent = allArticles.length;

    buildTagCloud(allArticles);
    renderCards(allArticles);

    // --- Search ---
    searchInput?.addEventListener('input', () => {
        const q = searchInput.value.trim();
        clearBtn.style.opacity = q ? '1' : '0';
        activeTag = null;
        document.querySelectorAll('.tag-cloud-chip').forEach(c => c.classList.remove('active'));
        applyFilters();
    });

    clearBtn?.addEventListener('click', () => {
        searchInput.value = '';
        clearBtn.style.opacity = '0';
        activeTag = null;
        document.querySelectorAll('.tag-cloud-chip').forEach(c => c.classList.remove('active'));
        applyFilters();
    });

    function applyFilters() {
        const q = (searchInput?.value || '').toLowerCase().trim();
        const filtered = allArticles.filter(a => {
            const matchTag = !activeTag || (a.tags || []).some(t => t.toLowerCase() === activeTag);
            if (!matchTag) return false;
            if (!q) return true;
            return (
                a.title.toLowerCase().includes(q) ||
                (a.excerpt || '').toLowerCase().includes(q) ||
                (a.tags || []).some(t => t.toLowerCase().includes(q))
            );
        });
        renderCards(filtered);
    }

    function buildTagCloud(articles) {
        if (!tagCloud) return;
        const counts = {};
        articles.forEach(a => (a.tags || []).forEach(t => { counts[t] = (counts[t] || 0) + 1; }));
        const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
        tagCloud.innerHTML = '';
        sorted.forEach(([tag, count]) => {
            const chip = document.createElement('span');
            chip.className = 'tag-cloud-chip';
            chip.textContent = `#${tag} (${count})`;
            chip.addEventListener('click', () => {
                const isActive = chip.classList.contains('active');
                document.querySelectorAll('.tag-cloud-chip').forEach(c => c.classList.remove('active'));
                if (searchInput) searchInput.value = '';
                if (clearBtn)    clearBtn.style.opacity = '0';
                if (isActive) {
                    activeTag = null;
                } else {
                    chip.classList.add('active');
                    activeTag = tag.toLowerCase();
                }
                applyFilters();
            });
            tagCloud.appendChild(chip);
        });
    }

    function renderCards(articles) {
        if (visibleCount) visibleCount.textContent = articles.length;

        if (!articles.length) {
            grid.innerHTML = '<p class="empty-list" style="grid-column:1/-1;padding:3rem 0;text-align:center;color:var(--text-secondary);font-family:var(--font-mono);font-size:.85rem;opacity:.5">No entries found.</p>';
            return;
        }

        grid.innerHTML = '';
        articles.forEach(a => {
            const tagsHtml = (a.tags || [])
                .map(t => `<span class="tag-link">#${escHtml(t)}</span>`)
                .join('');

            const card = document.createElement('a');
            card.href      = `/portfolio/notes/${a.id}/`;
            card.className = 'note-card glass';
            card.innerHTML = `
                <div class="note-meta">
                    <span class="note-date">${escHtml(a.date)}</span>
                    <div class="hashtags">${tagsHtml}</div>
                </div>
                <h3>${escHtml(a.title)}</h3>
                <p class="note-excerpt">${escHtml(a.excerpt || '')}</p>`;
            grid.appendChild(card);
        });
    }

    function escHtml(s) {
        return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }
});
