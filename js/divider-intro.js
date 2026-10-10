(() => {
    'use strict';
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    const atTop = () => scrollY <= 2 && (!location.hash || location.hash === '#top');
    const clamp = value => Math.max(0, Math.min(1, value));
    const smooth = value => value * value * (3 - 2 * value);

    function start() {
        const hero = document.querySelector('.bridge-stage .hero-wrap');
        if (!hero || reduced.matches || !atTop() || performance.getEntriesByType('navigation')[0]?.type === 'back_forward') return;
        const canvas = hero.querySelector('#hero-canvas');
        const divider = hero.querySelector('.divider-lines');
        if (!canvas || !divider) return;
        const height = hero.clientHeight, width = hero.clientWidth, style = getComputedStyle(hero);
        const bleed = parseFloat(style.getPropertyValue('--divider-bleed') || '72');
        const slope = width * Math.tan((parseFloat(style.getPropertyValue('--divider-angle')) || 18) * Math.PI / 180);
        const heroLeft = hero.getBoundingClientRect().left;
        const previousClip = canvas.style.clipPath, previousZ = divider.style.zIndex;
        const pieces = [...divider.querySelectorAll('.shard')].map((element, index) => ({
            element, index, edge: clamp((element.getBoundingClientRect().right - heroLeft) / width),
            opacity: element.style.opacity, translate: element.style.translate, born: null
        }));
        const rules = [...divider.querySelectorAll('.divider-rule')].map(element => ({ element, opacity: element.style.opacity }));
        pieces.forEach(({ element }) => { element.style.opacity = '0'; });
        rules.forEach(({ element }) => { element.style.opacity = '0'; });
        canvas.style.clipPath = 'none';
        divider.style.zIndex = '7';
        hero.classList.add('divider-intro-running');

        const cover = document.createElement('div');
        cover.setAttribute('aria-hidden', 'true');
        cover.className = 'divider-intro-cover';
        Object.assign(cover.style, { position: 'absolute', inset: '0', zIndex: '6', pointerEvents: 'none', overflow: 'hidden', clipPath: 'polygon(0 '+(height-bleed)+'px,100% '+(height-bleed-slope)+'px,100% 100%,0 100%)' });
        const paint = document.createElement('div');
        Object.assign(paint.style, { position: 'absolute', inset: '0', background: 'var(--bg-color, #fafdfe)', clipPath: 'inset(0 100% 0 0)' });
        cover.append(paint);
        hero.append(cover);

        const ns = 'http://www.w3.org/2000/svg';
        const wire = document.createElementNS(ns, 'svg');
        wire.setAttribute('viewBox', '0 0 '+width+' '+height);
        wire.setAttribute('aria-hidden', 'true');
        wire.classList.add('divider-intro-wire');
        Object.assign(wire.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', zIndex: '8', pointerEvents: 'none' });
        const path = document.createElementNS(ns, 'path');
        path.setAttribute('d', 'M0 '+(height-bleed)+' L'+width+' '+(height-bleed-slope));
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke', style.getPropertyValue('--accent-glow').trim() || '#00f2ff');
        path.setAttribute('stroke-width', '1.5');
        path.setAttribute('pathLength', '1');
        path.style.strokeDasharray = '1';
        path.style.strokeDashoffset = '1';
        wire.append(path);
        hero.append(wire);

        let frame = 0, finished = false;
        const began = performance.now(), wireDuration = 700, fillDuration = 700, settleDuration = 220;
        function restore(element, property, value) {
            if (value) element.style.setProperty(property, value);
            else element.style.removeProperty(property);
        }
        function finish() {
            if (finished) return;
            finished = true;
            cancelAnimationFrame(frame);
            cover.remove(); wire.remove();
            restore(canvas, 'clip-path', previousClip);
            restore(divider, 'z-index', previousZ);
            pieces.forEach(({ element, opacity, translate }) => { restore(element, 'opacity', opacity); restore(element, 'translate', translate); });
            rules.forEach(({ element, opacity }) => restore(element, 'opacity', opacity));
            hero.classList.remove('divider-intro-running');
            delete hero.dataset.dividerIntroPhase;
            if (performance.now() - began >= wireDuration + fillDuration + settleDuration && atTop())
                dispatchEvent(new Event('portfolio:divider-ready'));
            removeEventListener('scroll', onScroll);
            removeEventListener('resize', finish);
            removeEventListener('pagehide', finish);
            reduced.removeEventListener('change', finish);
        }
        function onScroll() { if (!atTop()) finish(); }
        function draw(now) {
            const elapsed = now - began;
            const fill = smooth(clamp((elapsed - wireDuration) / fillDuration));
            hero.dataset.dividerIntroPhase = elapsed < wireDuration ? 'wire' : 'fill';
            path.style.strokeDashoffset = String(1 - smooth(clamp(elapsed / wireDuration)));
            paint.style.clipPath = 'inset(0 '+((1-fill)*100)+'% 0 0)';
            wire.style.opacity = String(1 - clamp((elapsed-wireDuration-fillDuration)/settleDuration));
            // Reveal the actual boundary fragments only after white reaches them.
            pieces.forEach(piece => {
                if (elapsed < wireDuration || fill < piece.edge) return;
                if (piece.born === null) piece.born = now;
                const age = now - piece.born;
                const beat = Math.floor(age / 35) + piece.index;
                piece.element.style.opacity = age < 180 && beat % 4 === 1 ? '0' : '1';
                piece.element.style.translate = age < 180 ? ((beat % 3 - 1)*6)+'px '+(beat % 2 ? 1 : -1)+'px' : '0 0';
            });
            if (elapsed >= wireDuration + fillDuration + settleDuration) finish();
            else frame = requestAnimationFrame(draw);
        }
        addEventListener('scroll', onScroll, { passive: true });
        addEventListener('resize', finish);
        addEventListener('pagehide', finish);
        reduced.addEventListener('change', finish);
        draw(began);
    }
    if (document.readyState !== 'complete') document.addEventListener('DOMContentLoaded', start, { once: true });
    else start();
})();
