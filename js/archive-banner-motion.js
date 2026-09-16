(() => {
    'use strict';
    if (!Element.prototype.animate) return;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    const navigation = performance.getEntriesByType('navigation')[0];
    if (reduced.matches || navigation?.type === 'back_forward') return;
    // Run in the head: hold the artwork before the browser can paint it.
    const pendingClass = 'archive-motion-pending';
    document.documentElement.classList.add(pendingClass);
    const fallback = setTimeout(release, 2500);
    function release() {
        clearTimeout(fallback);
        document.documentElement.classList.remove(pendingClass);
    }
    function initialize() {
        if (!document.documentElement.classList.contains(pendingClass)) return;
        const banner = document.querySelector('[data-banner-motion]');
        if (!banner) { release(); return; }
        const svg = banner.querySelector('svg');
        const title = banner.querySelector('h1');
        if (!svg || !title) { release(); return; }
        const shapes = [...svg.children].slice(1);
        const animations = [], outlines = [], wrappers = [];
        let played = false;
        let observer;
        function finish() {
            release();
            animations.splice(0).forEach(animation => animation.cancel());
            outlines.splice(0).forEach(outline => outline.remove());
            wrappers.splice(0).forEach(group => group.replaceWith(...group.childNodes));
        }
        function animate(element, keyframes, delay, duration) {
            const animation = element.animate(keyframes, {
                delay, duration, fill: 'both', easing: 'cubic-bezier(.22,.7,.2,1)'
            });
            animations.push(animation);
            return animation;
        }
        function play() {
            if (played) return;
            played = true;
            observer?.disconnect();
            if (reduced.matches || !document.documentElement.classList.contains(pendingClass)) { finish(); return; }
            try {
                shapes.forEach((shape, i) => {
                    if (banner.dataset.bannerMotion === 'notes-stack') {
                        // Move the wrapper so the original SVG rotation stays intact.
                        const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
                        shape.before(group); group.append(shape); wrappers.push(group);
                        animate(group, [
                            { opacity: 0, transform: 'translate(-36px,10px)' },
                            { opacity: 1, transform: 'translate(0,0)' }
                        ], i * 65, 520);
                    } else if (shape.getAttribute('fill') === 'none' || !shape.getAttribute('fill')) {
                        const length = shape.getTotalLength();
                        animate(shape, [
                            { strokeDasharray: length, strokeDashoffset: length },
                            { strokeDasharray: length, strokeDashoffset: 0 }
                        ], i * 36, 670);
                    } else {
                        const outline = shape.cloneNode(true);
                        outline.removeAttribute('id');
                        outline.setAttribute('fill', 'none');
                        outline.setAttribute('stroke', '#273850');
                        outline.setAttribute('stroke-width', '1.3');
                        shape.after(outline); outlines.push(outline);
                        const length = outline.getTotalLength();
                        animate(outline, [
                            { strokeDasharray: length, strokeDashoffset: length, opacity: .65 },
                            { strokeDasharray: length, strokeDashoffset: 0, opacity: .65, offset: .75 },
                            { strokeDasharray: length, strokeDashoffset: 0, opacity: 0 }
                        ], i * 38, 1000);
                        animate(shape, [{ opacity: 0 }, { opacity: 1 }], 440 + i * 40, 500);
                    }
                });
                const duration = banner.dataset.bannerMotion === 'notes-stack' ? 1100 : 1500;
                animate(title, [{ opacity: 0 }, { opacity: 1 }], duration - 370, 370);
                release();
                Promise.all(animations.map(animation => animation.finished)).then(finish, finish);
            } catch (_) { finish(); }
        }
        if (!window.IntersectionObserver) { play(); return; }
        observer = new IntersectionObserver(entries => {
            if (entries.some(entry => entry.isIntersecting)) play();
        }, { threshold: .25 });
        observer.observe(banner);
        // Do not reveal the finished artwork in the outgoing page's last frame.
        addEventListener('pagehide', () => {
            played = true;
            observer.disconnect();
            clearTimeout(fallback);
            animations.forEach(animation => animation.pause());
        }, { once: true });
        addEventListener('pageshow', event => { if (event.persisted) finish(); });
        reduced.addEventListener('change', () => {
            if (reduced.matches) { played = true; observer.disconnect(); finish(); }
        });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
    else initialize();
})();
