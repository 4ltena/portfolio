function escHtml(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

document.addEventListener('DOMContentLoaded', async () => {

    // ── Logo animation (starts immediately) ──────────────────
    initLogoAnimation();

    // ── Dynamic section rendering (await before setting up observers) ──
    await Promise.all([renderTimeline(), renderSkills()]);

    // ── Reveal observer (now all elements are in the DOM) ────
    initRevealObserver();

    // ── Timeline filters ─────────────────────────────────────
    initFilters();

    // ── Hero background mouse tracking ───────────────────────
    const hero = document.querySelector('.hero');
    if (hero) {
        hero.addEventListener('mousemove', (e) => {
            const x = (e.clientX / window.innerWidth)  * 100;
            const y = (e.clientY / window.innerHeight) * 100;
            const placeholder = document.querySelector('.hero-placeholder');
            if (placeholder) {
                placeholder.style.background =
                    `radial-gradient(circle at ${x}% ${y}%, rgba(112,0,255,0.15), transparent 40%),` +
                    `radial-gradient(circle at ${100-x}% ${100-y}%, rgba(0,242,255,0.1), transparent 50%)`;
            }
        });
    }

    // ── Circuit lines ─────────────────────────────────────────
    setTimeout(drawCircuits, 100);
    window.addEventListener('resize', drawCircuits);

    // ── Mobile menu ───────────────────────────────────────────
    initMobileMenu();

    // ── Clickable items (event delegation for dynamic content) ─
    document.addEventListener('click', e => {
        const item = e.target.closest('.clickable-item[data-href]');
        if (item) window.location.href = item.dataset.href;
    });

});

// ─────────────────────────────────────────────────────────────
// Dynamic renderers
// ─────────────────────────────────────────────────────────────

async function renderTimeline() {
    const ul = document.getElementById('timeline-list');
    if (!ul) return;
    try {
        const r = await fetch('/portfolio/api/timeline');
        if (!r.ok) return;
        const items = await r.json();
        ul.innerHTML = items.map(item => `
            <li class="timeline-item${item.href ? ' clickable-item' : ''}"
                data-category="${escHtml(item.category)}"
                ${item.href ? `data-href="${escHtml(item.href)}"` : ''}>
              <div class="timeline-dot"></div>
              <div class="timeline-content glass">
                <span class="timeline-date">${escHtml(item.date)}</span>
                <h4>${escHtml(item.title)}</h4>
              </div>
            </li>`).join('');
    } catch {}
}

async function renderSkills() {
    const grid = document.getElementById('skills-grid');
    if (!grid) return;
    try {
        const r = await fetch('/portfolio/api/skills');
        if (!r.ok) return;
        const items = await r.json();
        grid.innerHTML = items.map(item => `
            <div class="prog-lang-tile-item glass">
              <div class="icon-box">
                <img src="img/${escHtml(item.icon)}" alt="${escHtml(item.name)} logo" class="prog-lang-img">
              </div>
              <h3>${escHtml(item.name)}</h3>
              <p>${escHtml(item.description)}</p>
            </div>`).join('');
    } catch {}
}

// ─────────────────────────────────────────────────────────────
// Logo typing animation
// ─────────────────────────────────────────────────────────────

function initLogoAnimation() {
    const logo = document.getElementById('header-logo');
    if (!logo) return;

    const slashIcon = '<span class="slash-icon">//</span>';
    logo.innerHTML = '<span class="slash-icon"></span><span class="logo-cursor"></span>';

    const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

    (async () => {
        await delay(200);
        logo.innerHTML = '<span class="slash-icon">/</span>';
        await delay(50);
        logo.innerHTML = '<span class="slash-icon">//</span>';
        await delay(50);
        logo.innerHTML = '<span class="slash-icon">///</span>';
        await delay(150);
        logo.innerHTML = slashIcon + 'Alt';
        await delay(100);
        logo.innerHTML = slashIcon + 'Alt<span class="ena">ena</span>';
    })();
}

// ─────────────────────────────────────────────────────────────
// Reveal observer
// ─────────────────────────────────────────────────────────────

function initRevealObserver() {
    const revealElements = document.querySelectorAll('.reveal');

    const observer = new IntersectionObserver((entries, obs) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add('active');

                if (entry.target.classList.contains('logo-text')) {
                    setTimeout(() => {
                        initTitleTyping().then(() => {
                            setTimeout(initSubtitleTyping, 1000);
                        });
                    }, 500);
                    obs.unobserve(entry.target);
                }
            }
        });
    }, { threshold: 0.05, rootMargin: '0px 0px 0px 0px' });

    revealElements.forEach(el => observer.observe(el));
}

// ─────────────────────────────────────────────────────────────
// Title typing (one-time)
// ─────────────────────────────────────────────────────────────

function initTitleTyping() {
    return new Promise(resolve => {
        const target = document.querySelector('.title-typing');
        if (!target) { resolve(); return; }

        const text = 'Altena Portfolio';
        let index = 0;

        const type = () => {
            if (index < text.length) {
                target.textContent += text.charAt(index++);
                setTimeout(type, 100);
            } else {
                const cursor = document.getElementById('title-cursor');
                if (cursor) cursor.style.display = 'none';
                resolve();
            }
        };
        type();
    });
}

// ─────────────────────────────────────────────────────────────
// Subtitle typing (looping)
// ─────────────────────────────────────────────────────────────

function initSubtitleTyping() {
    const prefixTarget    = document.querySelector('.prefix');
    const typingTarget    = document.querySelector('.typing-animation');
    const subtitleContainer = document.getElementById('subtitle-container');
    const subtitleCursor  = document.getElementById('subtitle-cursor');

    if (!typingTarget || !prefixTarget) return;

    const prefixText = "I'm ";
    const phrases = [
        'Unity & Blender Developer',
        'Frontend Engineer',
        'Backend Engineer',
        'Embedded Systems Tinkerer',
        'Certification Hunter',
    ];

    let prefixIndex = 0;
    let phraseIndex = 0;
    let charIndex   = 0;
    let isDeleting  = false;

    const typePrefix = () => {
        if (prefixIndex < prefixText.length) {
            prefixTarget.textContent += prefixText.charAt(prefixIndex++);
            setTimeout(typePrefix, 100);
        } else {
            typePhrases();
        }
    };

    const typePhrases = () => {
        const current = phrases[phraseIndex];
        let speed = isDeleting ? 50 : 100;

        if (isDeleting) {
            typingTarget.textContent = current.substring(0, --charIndex);
        } else {
            typingTarget.textContent = current.substring(0, ++charIndex);
        }

        if (!isDeleting && charIndex === current.length) {
            isDeleting = true; speed = 2000;
        } else if (isDeleting && charIndex === 0) {
            isDeleting = false;
            phraseIndex = (phraseIndex + 1) % phrases.length;
            speed = 500;
        }
        setTimeout(typePhrases, speed);
    };

    if (subtitleContainer) subtitleContainer.style.visibility = 'visible';
    if (subtitleCursor)    subtitleCursor.style.display = 'inline-block';
    typePrefix();
}

// ─────────────────────────────────────────────────────────────
// Timeline filters
// ─────────────────────────────────────────────────────────────

function initFilters() {
    const filterCheckboxes = document.querySelectorAll('.filter-controls input[type="checkbox"]');
    const timelineItems    = document.querySelectorAll('.timeline-item');

    if (!filterCheckboxes.length || !timelineItems.length) return;

    const updateFilters = () => {
        const active = Array.from(filterCheckboxes)
            .filter(i => i.checked)
            .map(i => i.value);

        let visible = 0;
        timelineItems.forEach(item => {
            const cat = item.getAttribute('data-category');
            if (active.includes(cat)) { item.classList.remove('hidden'); visible++; }
            else                      { item.classList.add('hidden'); }
        });

        const countEl = document.getElementById('active-count');
        const totalEl = document.getElementById('total-count');
        if (countEl) countEl.textContent = visible;
        if (totalEl) totalEl.textContent = timelineItems.length;
    };

    updateFilters();
    filterCheckboxes.forEach(cb => cb.addEventListener('change', updateFilters));
}

// ─────────────────────────────────────────────────────────────
// Circuit line generator
// ─────────────────────────────────────────────────────────────

function drawCircuits() {
    const svg     = document.getElementById('circuit-overlay');
    const wrapper = document.querySelector('.content-wrapper');
    const profile = document.getElementById('profile');
    if (!svg || !wrapper || !profile) return;

    const rect = wrapper.getBoundingClientRect();
    svg.setAttribute('width',  rect.width);
    svg.setAttribute('height', rect.height);
    svg.innerHTML = '';

    const getCoords = el => {
        const r  = el.getBoundingClientRect();
        const wr = wrapper.getBoundingClientRect();
        let tx = 0, ty = 0, cur = el;
        while (cur && cur !== wrapper) {
            const m = new DOMMatrix(window.getComputedStyle(cur).transform);
            if (!m.isIdentity) { tx += m.m41; ty += m.m42; }
            cur = cur.parentElement;
        }
        return { x: r.left - wr.left - tx, y: r.top - wr.top - ty, w: r.width, h: r.height };
    };

    const lineEnd = (el, margin) => {
        if (!el) return null;
        const c = getCoords(el);
        return { x: c.x + c.w - margin, y: c.y + c.h - 8.75 };
    };

    const p1 = lineEnd(document.querySelector('#skills .section-title'),   -60);
    const p2 = lineEnd(document.querySelector('#timeline .section-title'), -40);
    const p3 = lineEnd(document.querySelector('#works .section-title'),    -20);

    const worksMore = document.querySelector('.works-more');
    if (!worksMore) return;
    const wm = getCoords(worksMore);
    const baseY = wm.y + wm.h + 40;

    const drawPath = (pStart, bendY) => {
        if (!pStart) return;
        const d = `M ${pStart.x} ${pStart.y} L ${pStart.x} ${bendY} L 0 ${bendY + pStart.x}`;
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('class', 'circuit-path');
        path.setAttribute('d', d);
        svg.appendChild(path);
    };

    drawPath(p1, baseY);
    drawPath(p2, baseY + 30);
    drawPath(p3, baseY + 60);
}

// ─────────────────────────────────────────────────────────────
// Mobile menu
// ─────────────────────────────────────────────────────────────

function initMobileMenu() {
    const hamburger = document.getElementById('mobile-menu-toggle');
    const nav       = document.querySelector('.nav');
    const navLinks  = document.querySelectorAll('.nav a');
    if (!hamburger || !nav) return;

    hamburger.addEventListener('click', () => {
        hamburger.classList.toggle('active');
        nav.classList.toggle('active');
        document.body.style.overflow = nav.classList.contains('active') ? 'hidden' : '';
    });

    navLinks.forEach(link => {
        link.addEventListener('click', () => {
            hamburger.classList.remove('active');
            nav.classList.remove('active');
            document.body.style.overflow = '';
        });
    });
}
