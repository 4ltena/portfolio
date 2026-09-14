// トップページだけを装飾する。構図の割り当ては記事と一緒にサーバーへ保存する。
const HomeBanners = (() => {
    const covers = new WeakMap();
    const observer = new ResizeObserver(entries => {
        for (const { target } of entries) paint(target);
    });

    function paint(element) {
        const { id, pattern } = covers.get(element);
        const { width, height } = element.getBoundingClientRect();
        if (!width || !height) return;
        element.innerHTML = PastelCover.render(id, width / height, 0, pattern);
    }

    function decorateNotes(grid, articles) {
        observer.disconnect();
        grid.dataset.noteCount = articles.length;
        [...grid.children].forEach((card, index) => {
            const article = articles[index];
            const pattern = article.coverPattern;
            // 段階的な配備中に旧APIが応答した場合は、本文カードをそのまま表示する。
            if (!Number.isInteger(pattern) || pattern < 0 || pattern >= PastelCover.patterns.length) return;
            const copy = document.createElement('div');
            copy.className = 'pastel-note-copy';
            copy.append(...card.childNodes);
            const cover = document.createElement('div');
            cover.className = 'pastel-note-art';
            cover.setAttribute('aria-hidden', 'true');
            card.classList.add('pastel-note');
            card.append(cover, copy);
            covers.set(cover, { id: article.id, pattern });
            paint(cover);
            observer.observe(cover);
        });
    }

    return Object.freeze({ decorateNotes });
})();
