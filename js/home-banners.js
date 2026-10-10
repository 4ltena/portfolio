// トップページだけを装飾する。構図の割り当ては記事と一緒にサーバーへ保存する。
const HomeBanners = (() => {
    // 大カードの8:3を共通原画にし、小カードはSVGのsliceで上下を切り取る。
    const posterAspect = 8 / 3;

    function decorateNotes(grid, articles) {
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
            cover.innerHTML = PastelCover.render(article.id, posterAspect, 0, pattern);
            card.classList.add('pastel-note');
            card.append(cover, copy);
        });
    }

    return Object.freeze({ decorateNotes });
})();
