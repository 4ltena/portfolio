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
        grid.innerHTML = '<p class="empty-list">Failed to load articles.</p>';
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
            grid.innerHTML = '<p class="empty-list">No entries found.</p>';
            return;
        }

        // buildNoteCard / escHtml は js/utils.js（notes.js より前に読み込む）で定義。
        grid.replaceChildren(...articles.map(buildNoteCard));
    }
});
