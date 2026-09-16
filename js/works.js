'use strict';

document.addEventListener('DOMContentLoaded', () => {
    const grid = document.querySelector('.page-tile-container');
    if (!grid) return;
    const cards = [...grid.querySelectorAll('.page-tile-item')];
    const search = document.getElementById('works-search');
    const clear = document.getElementById('clear-search');
    const cloud = document.getElementById('tag-cloud');
    const total = document.getElementById('total-works-count');
    const visible = document.getElementById('visible-works-count');
    const tagsOf = card => (card.dataset.tags || '').split(/\s+/).filter(Boolean);
    let activeTag = null;
    const empty = document.createElement('p');
    empty.className = 'empty-list';
    empty.textContent = '該当する作品はありません。';
    empty.hidden = true;
    grid.after(empty);
    total.textContent = cards.length;

    function filter() {
        const query = search.value.trim().toLowerCase();
        let count = 0;
        for (const card of cards) {
            const matches = (!activeTag || tagsOf(card).includes(activeTag)) &&
                (!query || `${card.textContent} ${card.dataset.tags || ''}`.toLowerCase().includes(query));
            card.hidden = !matches;
            if (matches) count++;
        }
        visible.textContent = count;
        empty.hidden = count !== 0;
        clear.style.opacity = query ? '1' : '0';
        cloud.querySelectorAll('button').forEach(button => {
            const active = button.dataset.tag === activeTag;
            button.classList.toggle('active', active);
            button.setAttribute('aria-pressed', String(active));
        });
    }

    const counts = new Map();
    cards.forEach(card => new Set(tagsOf(card)).forEach(tag => counts.set(tag, (counts.get(tag) || 0) + 1)));
    for (const [tag, count] of counts) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'tag-cloud-chip';
        button.dataset.tag = tag;
        button.textContent = `${tag} (${count})`;
        button.addEventListener('click', () => {
            activeTag = activeTag === tag ? null : tag;
            search.value = '';
            filter();
        });
        cloud.append(button);
    }
    search.addEventListener('input', () => { activeTag = null; filter(); });
    clear.addEventListener('click', () => { search.value = ''; activeTag = null; filter(); search.focus(); });
    filter();
});
