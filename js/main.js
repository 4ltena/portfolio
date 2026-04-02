document.addEventListener('DOMContentLoaded', () => {
    /**
     * Logo Typing Animation
     * Sequence: / -> // -> /// -> //A -> //Altena
     */
    const initLogoAnimation = () => {
        const logo = document.getElementById('header-logo');
        if (!logo) return;

        const fullText = "Altena";
        const slashIcon = '<span class="slash-icon">//</span>';
        const enaPart = '<span class="ena">ena</span>';
        
        // Initial state: empty
        logo.innerHTML = '<span class="slash-icon"></span><span class="logo-cursor"></span>';
        
        const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

        const animate = async () => {
            // Fast sequence: / -> // -> ///
            await delay(200);
            logo.innerHTML = '<span class="slash-icon">/</span>';
            await delay(50);
            logo.innerHTML = '<span class="slash-icon">//</span>';
            await delay(50);
            logo.innerHTML = '<span class="slash-icon">///</span>';
            await delay(150); 

            // Final: /// becomes //Alt then //Altena
            logo.innerHTML = '<span class="slash-icon">//</span>Alt';
            await delay(100);
            logo.innerHTML = slashIcon + 'Alt<span class="ena">ena</span>';
        };

        animate();
    };

    initLogoAnimation();
    /**
     * Typing Animation for Title (One-time)
     */
    const initTitleTyping = () => {
        return new Promise((resolve) => {
            const target = document.querySelector('.title-typing');
            if (!target) {
                resolve();
                return;
            }

            const text = "Altena Portfolio";
            let index = 0;

            const type = () => {
                if (index < text.length) {
                    target.textContent += text.charAt(index);
                    index++;
                    setTimeout(type, 100); 
                } else {
                    const titleCursor = document.getElementById('title-cursor');
                    if (titleCursor) titleCursor.style.display = 'none';
                    resolve();
                }
            };
            type();
        });
    };

    /**
     * Typing Animation for Subtitles (Looping)
     */
    const initTyping = () => {
        const prefixTarget = document.querySelector('.prefix');
        const typingTarget = document.querySelector('.typing-animation');
        const subtitleContainer = document.getElementById('subtitle-container');
        const subtitleCursor = document.getElementById('subtitle-cursor');

        if (!typingTarget || !prefixTarget) return;

        const prefixText = "I'm ";
        const phrases = [
            "Unity & Blender Developer",
            "Frontend Engineer",
            "Backend Engineer",
            "Embedded Systems Tinkerer",
            "Certification Hunter"
        ];

        let prefixIndex = 0;
        let phraseIndex = 0;
        let charIndex = 0;
        let isDeleting = false;

        const typePrefix = () => {
            if (prefixIndex < prefixText.length) {
                prefixTarget.textContent += prefixText.charAt(prefixIndex);
                prefixIndex++;
                setTimeout(typePrefix, 100);
            } else {
                typePhrases();
            }
        };

        const typePhrases = () => {
            const currentPhrase = phrases[phraseIndex];
            let typeSpeed = isDeleting ? 50 : 100;

            if (isDeleting) {
                typingTarget.textContent = currentPhrase.substring(0, charIndex - 1);
                charIndex--;
            } else {
                typingTarget.textContent = currentPhrase.substring(0, charIndex + 1);
                charIndex++;
            }

            if (!isDeleting && charIndex === currentPhrase.length) {
                isDeleting = true;
                typeSpeed = 2000; // Pause at end
            } else if (isDeleting && charIndex === 0) {
                isDeleting = false;
                phraseIndex = (phraseIndex + 1) % phrases.length;
                typeSpeed = 500; // Pause before next
            }

            setTimeout(typePhrases, typeSpeed);
        };

        // Reveal container then start
        if (subtitleContainer) subtitleContainer.style.visibility = 'visible';
        if (subtitleCursor) subtitleCursor.style.display = 'inline-block';
        typePrefix();
    };

    /**
     * Scroll Reveal Animation
     */
    const revealElements = document.querySelectorAll('.reveal');
    
    const revealObserver = new IntersectionObserver((entries, observer) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add('active');

                // Special trigger for title typing on logo-text reveal
                if (entry.target.classList.contains('logo-text')) {
                    setTimeout(() => {
                        initTitleTyping().then(() => {
                            setTimeout(initTyping, 1000); // 1s delay before subtitle
                        });
                    }, 500); 
                    observer.unobserve(entry.target);
                }
            }
        });
    }, {
        threshold: 0.1,
        rootMargin: "0px 0px -50px 0px"
    });

    revealElements.forEach(el => revealObserver.observe(el));

    /**
     * Timeline Filtering
     */
    const filterCheckboxes = document.querySelectorAll('.filter-controls input[type="checkbox"]');
    const timelineItems = document.querySelectorAll('.timeline-item');

    const updateFilters = () => {
        const activeCategories = Array.from(filterCheckboxes)
            .filter(i => i.checked)
            .map(i => i.value);

        let visibleCount = 0;
        timelineItems.forEach(item => {
            const category = item.getAttribute('data-category');
            if (activeCategories.includes(category)) {
                item.classList.remove('hidden');
                visibleCount++;
            } else {
                item.classList.add('hidden');
            }
        });

        // Update counts
        const activeCountEl = document.getElementById('active-count');
        const totalCountEl = document.getElementById('total-count');
        if (activeCountEl) activeCountEl.textContent = visibleCount;
        if (totalCountEl && timelineItems.length > 0) totalCountEl.textContent = timelineItems.length;
    };

    // Initial count and filter setup
    if (timelineItems.length > 0) {
        updateFilters();
    }

    filterCheckboxes.forEach(checkbox => {
        checkbox.addEventListener('change', updateFilters);
    });

    // Hero Background Mouse Tracking
    const hero = document.querySelector('.hero');
    if (hero) {
        hero.addEventListener('mousemove', (e) => {
            const { clientX, clientY } = e;
            const x = (clientX / window.innerWidth) * 100;
            const y = (clientY / window.innerHeight) * 100;
            const placeholder = document.querySelector('.hero-placeholder');
            if (placeholder) {
                placeholder.style.background = ` radial-gradient(circle at ${x}% ${y}%, rgba(112, 0, 255, 0.15), transparent 40%), radial-gradient(circle at ${100-x}% ${100-y}%, rgba(0, 242, 255, 0.1), transparent 50%) `;
            }
        });
    }

    // Circuit Line Generator
    const drawCircuits = () => {
        const svg = document.getElementById('circuit-overlay');
        const wrapper = document.querySelector('.content-wrapper');
        const profile = document.getElementById('profile');
        if (!svg || !wrapper || !profile) return;

        const rect = wrapper.getBoundingClientRect();
        svg.setAttribute('width', rect.width);
        svg.setAttribute('height', rect.height);
        svg.innerHTML = '';

        const getCoords = (element) => {
            const rect = element.getBoundingClientRect();
            const wrapperRect = wrapper.getBoundingClientRect();
            
            // Recursively subtract transforms of all ancestors up to wrapper
            let tx = 0;
            let ty = 0;
            let current = element;
            while (current && current !== wrapper) {
                const style = window.getComputedStyle(current);
                const matrix = new DOMMatrix(style.transform);
                if (!matrix.isIdentity) {
                    tx += matrix.m41;
                    ty += matrix.m42;
                }
                current = current.parentElement;
            }

            return {
                x: rect.left - wrapperRect.left - tx,
                y: rect.top - wrapperRect.top - ty,
                w: rect.width,
                h: rect.height
            };
        };

        const getLineEndCoords = (el, margin) => {
            if (!el) return null;
            const coords = getCoords(el);
            return {
                x: coords.x + coords.w - margin,
                y: coords.y + coords.h - 8.75 // 0.5rem(8px) horizontal line margin + half line thickness
            };
        };

        const p1 = getLineEndCoords(document.querySelector('#skills .section-title'), -60);
        const p2 = getLineEndCoords(document.querySelector('#timeline .section-title'), -40);
        const p3 = getLineEndCoords(document.querySelector('#works .section-title'), -20);

        const worksMore = document.querySelector('.works-more');
        if (!worksMore) return;
        const worksMoreCoords = getCoords(worksMore);
        const baseY = worksMoreCoords.y + worksMoreCoords.h + 40; // Turn after "and more"

        const drawCircuitPath = (pStart, bendY) => {
            if (!pStart) return;
            const x1 = pStart.x;
            const y1 = pStart.y;
            
            // Path: Vertical down -> 45-deg bend -> Diagonal to x=0
            const xFinal = 0;
            const yFinal = bendY + x1; // since it's 45 degrees left (dx = x1, so dy = x1)

            let d = `M ${x1} ${y1} `;
            d += `L ${x1} ${bendY} `;
            d += `L ${xFinal} ${yFinal}`;

            const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
            path.setAttribute("class", "circuit-path");
            path.setAttribute("d", d);
            svg.appendChild(path);
        };

        drawCircuitPath(p1, baseY);
        drawCircuitPath(p2, baseY + 30); // staggered vertical
        drawCircuitPath(p3, baseY + 60);
    };

    // Initialize circuits and redraw on resize
    setTimeout(drawCircuits, 100);
    window.addEventListener('resize', drawCircuits);
});