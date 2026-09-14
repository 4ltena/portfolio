console.log("%c[SYSTEM] Kernel Loaded. Identity: Guest. Monitoring activity...", "color: #00f2ff; font-weight: bold; background: #111; padding: 5px 10px; border-radius: 4px;");

// escHtml / buildNoteCard は js/utils.js（main.js より前に読み込む）で定義。

const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

document.addEventListener('DOMContentLoaded', async () => {

    // ── Hero divider (最初の描画に間に合わせるため先頭で) ────
    initDivider();
    initHeaderTheme();

    // ── Logo animation (starts immediately) ──────────────────
    initLogoAnimation();

    // ── Dynamic section rendering (await before setting up observers) ──
    // renderLatestNotes も await することで、drawCircuits 実行時には
    // works セクションの高さが確定し、circuit の縦線がズレない。
    await Promise.all([renderTimeline(), renderSkills(), renderLatestNotes()]);

    // ── Reveal observer (now all elements are in the DOM) ────
    initRevealObserver();
    initHomeSectionReveal();

    // ── Timeline filters ─────────────────────────────────────
    initFilters();

    // ── System status (live clock — placeholder の "Upgrading..." が固定表示になる問題の解消) ──
    initSystemStatus();

    // ── Circuit lines ─────────────────────────────────────────
    if (document.getElementById('circuit-overlay')) {
        setTimeout(drawCircuits, 100);
        window.addEventListener('resize', drawCircuits);
    }

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
        // タイムライン本体と、資格の分類メタ（node_category）を並行取得。
        // node_category === 'info'（情報通信）を IT 系とみなし、それ以外（化学・言語・
        // 数学・デザイン）は data-category='cert-other' に振り分けて、フィルタで個別に
        // 出し分ける。cert-nodes が取れない場合は全資格を IT 系（'cert'）として表示。
        const [r, cnRes] = await Promise.all([
            fetch('/portfolio/api/timeline'),
            fetch('/portfolio/api/cert-nodes').catch(() => null),
        ]);
        if (!r.ok) return;
        const items = await r.json();

        const metaMap = {};
        if (cnRes && cnRes.ok) {
            for (const n of await cnRes.json()) metaMap[n.id] = n;
        }
        const categoryOf = item => {
            if (item.category !== 'cert') return item.category;
            const nc = metaMap[item.id]?.node_category || 'info';
            return nc === 'info' ? 'cert' : 'cert-other';
        };

        if (ul.classList.contains('timeline-summary')) {
            const dateOrder = value => {
                const parts = String(value).match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
                return parts ? Number(parts[1]) * 10000 + Number(parts[2]) * 100 + Number(parts[3]) : Infinity;
            };
            items.sort((a, b) => dateOrder(a.date) - dateOrder(b.date) || String(a.id).localeCompare(String(b.id)));
            ul.innerHTML = items.map(item => {
                const dateTime = item.date.replace(/[/.]/g, '-').replace(/-(\d)(?=-|$)/g, '-0$1');
                const content = `<time datetime="${escHtml(dateTime)}">${escHtml(item.date)}</time>
                    <span>${escHtml(item.title)}</span>`;
                return `<li class="timeline-item" data-category="${escHtml(categoryOf(item))}">
                    ${item.href ? `<a class="timeline-entry" href="${escHtml(item.href)}">${content}</a>`
                        : `<div class="timeline-entry">${content}</div>`}
                    </li>`;
            }).join('');
            return;
        }

        ul.innerHTML = items.map(item => `
            <li class="timeline-item${item.href ? ' clickable-item' : ''}"
                data-category="${escHtml(categoryOf(item))}"
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
        if (grid.classList.contains('skills-columns')) {
            const groups = [
                { title: 'Web & Development', names: ['HTML', 'CSS', 'JavaScript', 'TypeScript', 'React', 'Node.js'] },
                { title: '3D & Creative', names: ['Blender', 'Maya', 'Houdini', 'Gaea', 'Unity', 'Unreal Engine'] },
                { title: 'Systems & Tools', names: [] },
            ];
            const grouped = groups.map(() => []);
            for (const item of items) {
                const index = groups.findIndex(group => group.names.includes(item.name));
                grouped[index < 0 ? 2 : index].push(item);
            }
            grid.innerHTML = groups.map((group, index) => `
                <div class="skill-column"><h3>${escHtml(group.title)}</h3>
                    <ul>${grouped[index].map(item => `<li title="${escHtml(item.description)}">${escHtml(item.name)}</li>`).join('')}</ul>
                </div>`).join('');
            return;
        }
        // Signal Tile デザイン（採用: 2026-08-19）はロゴアイコンを持たない。
        // 必要になったら item.icon から再度 <img> を組み込める。
        grid.innerHTML = items.map(item => `
            <div class="prog-lang-tile-item">
              <h3>${escHtml(item.name)}</h3>
              <p>${escHtml(item.description)}</p>
            </div>`).join('');
    } catch {}
}

async function renderLatestNotes() {
    const grid = document.getElementById('latest-notes-grid');
    if (!grid) return;
    try {
        const r = await fetch('/portfolio/api/articles');
        if (!r.ok) return;
        // API は created_at DESC 順。先頭3件が最新。
        const items = (await r.json()).slice(0, 3);
        grid.replaceChildren(...items.map(buildNoteCard));
        if (typeof HomeBanners !== 'undefined') HomeBanners.decorateNotes(grid, items);
    } catch {}
}

// ─────────────────────────────────────────────────────────────
// System status (live JST clock)
// ─────────────────────────────────────────────────────────────

async function initSystemStatus() {
    const el = document.getElementById('sys-status');
    if (!el) return;

    // サーバーの稼働情報（nginx バージョン・uptime・TLS証明書の状態）を取得。
    // 失敗してもライブ時計だけは動かす。
    let server = '';
    try {
        const r = await fetch('/portfolio/api/status');
        if (r.ok) {
            const s = await r.json();
            const parts = [];
            if (s.nginx) parts.push(`nginx ${s.nginx}`);
            if (s.uptime) parts.push(`up ${s.uptime.days}d ${s.uptime.hours}h`);
            // js/status-beacon.js 側が \bTLS\b(valid|expired|unknown) を正規表現で
            // 拾って [TLS] 行に反映する。API は値を返しているのにここで素通りさせて
            // いたため、[TLS] が常に UNKNOWN 表示のままになるバグがあった。
            if (s.tls) parts.push(`tls ${s.tls}`);
            if (parts.length) server = ` · ${parts.join(' · ')}`;
        }
    } catch {}

    const update = () => {
        const t = new Date().toLocaleString('ja-JP', {
            timeZone: 'Asia/Tokyo', hour12: false,
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit'
        }).replace(/\//g, '-');
        el.textContent = `ONLINE${server} · ${t} JST`;
    };
    update();
    setInterval(update, 1000);
}

// ─────────────────────────────────────────────────────────────
// Hero divider (Glitch Slice)
// ─────────────────────────────────────────────────────────────

const DIVIDER_ANGLE_DEG = 18;

// 破片の散らばりを決める種。値を変えると配置が丸ごと入れ替わるので、
// 気に入らない散らばりに当たったら別の数字を試す。
const DIVIDER_SEED = 20260819;

// mulberry32。毎回同じ配置を出すために Math.random() は使わない。
function makeRng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// 破片のかたまり（＝境界の裂け目）の強さ。3 が大きく抉れるもの、1 が小さいもの。
// 強さを確率で引くと「強いものが等間隔に何個か」という並びが出やすいので、
// 内訳を固定して順番だけ入れ替える。数と比率はここを直せば変えられる。
const DIVIDER_TEARS = [3, 3, 2, 2, 1, 1, 1];

// 破片を [x%, width%, y(px), height(px), kind] の配列で組み立てる。
// y は境界からの距離。負 = 暗色側へ削り込む / 正 = 明色側へ切り離す。
//
// 位置は「前の裂け目からの間隔」を積むのではなく、0〜100% から一様に引いて
// 最小距離だけ課す。逐次的に間隔を積むとどうしても均されるが、一様乱数の点は
// 自然に固まったり大きく空いたりするので、狙わなくても粗密が出る。
function buildDividerShards(rng) {
    const shards = [];
    const push = (x, w, y, h, kind) =>
        shards.push([+x.toFixed(2), +w.toFixed(2), +y.toFixed(1), +h.toFixed(1), kind]);

    // 強さの並びをシャッフル（Fisher-Yates）
    const strengths = DIVIDER_TEARS.slice();
    for (let i = strengths.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [strengths[i], strengths[j]] = [strengths[j], strengths[i]];
    }

    // 位置を一様に引く。近すぎるものだけ捨てる。
    const MIN_GAP = 4;
    const xs = [];
    for (let tries = 0; xs.length < strengths.length && tries < 400; tries++) {
        const cx = -3 + rng() * 103;
        if (xs.every(v => Math.abs(v - cx) >= MIN_GAP)) xs.push(cx);
    }

    xs.forEach((x0, i) => {
        const s = strengths[i] ?? 1;

        // 強い裂け目ほど幅を詰めて、破片を一箇所に集める。散らすと迫力が出ない。
        const span  = s === 3 ? 3 + rng() * 2.5
                    : s === 2 ? 2.5 + rng() * 3
                    :           1.8 + rng() * 2.2;
        const place = w => x0 + rng() * Math.max(0.1, span - w);

        // 暗色側への削り込み
        const cuts = s === 3 ? 1 + (rng() < 0.6 ? 1 : 0) : 1;
        for (let c = 0; c < cuts; c++) {
            const w = 1.2 + rng() * (s === 3 ? 6.5 : s === 2 ? 4.2 : 2.6);
            const h = s === 3 ? 5 + rng() * 5.5
                    : s === 2 ? 2.75 + rng() * 2.75
                    :           1.5 + rng() * 1.5;
            const cx = place(w);
            push(cx, w, -h, h, 'cut');
            // 削り込みの縁に、面のずれ目の色収差を模したスリットを乗せる
            if (rng() < 0.55) push(cx, w, -h - 1.5, 1.5, rng() < 0.5 ? 'glow' : 'violet');
        }

        // 明色側へ切り離された破片
        // 明色側の破片は tear ごとに別の乱数列を使い、cut の座標から独立させる。
        const fragRng = makeRng((DIVIDER_SEED ^ Math.floor(rng() * 0xffffffff)) >>> 0);
        const frags = s === 3 ? 4 + Math.floor(fragRng() * 3)
                    : s === 2 ? 3 + Math.floor(fragRng() * 2)
                    :           1 + Math.floor(fragRng() * 2);
        for (let f = 0; f < frags; f++) {
            const w = 0.8 + fragRng() * (s === 3 ? 5 : s === 2 ? 3.5 : 2.2);
            const h = s === 3 ? 1.5 + fragRng() * 4.5
                    : s === 2 ? 1.5 + fragRng() * 3
                    :           1 + fragRng() * 2;
            const fy = 2 + fragRng() * fragRng() * (s === 3 ? 20 : 14);  // 境界寄りに多く、たまに遠くへ飛ぶ
            const fx = fragRng() * Math.max(0, 100 - w);
            const tone = fragRng();
            const kind = tone < 0.14 ? 'glow'
                       : tone < 0.34 ? 'violet'
                       :               'frag';
            push(fx, w, fy, h, kind);
        }

        if (s >= 2 && rng() < 0.5) {
            const w = 1.5 + rng() * 4;
            push(place(w), w, 4 + rng() * 18, 1.5, rng() < 0.6 ? 'glow' : 'violet');
        }
    });

    return shards;
}

function initDivider() {
    const group = document.getElementById('shard-group');
    if (!group) return;

    for (const [x, w, y, h, kind] of buildDividerShards(makeRng(DIVIDER_SEED))) {
        const el = document.createElement('span');
        el.className = `shard ${kind}`;
        el.style.left   = `${x}%`;
        el.style.width  = `${w}%`;
        el.style.top    = `${y}px`;
        el.style.height = `${h}px`;
        group.appendChild(el);
    }

    // 落差は「実測幅 × tan(角度)」。CSS 側の 100vw は縦スクロールバーぶん実要素幅と
    // ズレるため、そのままだと clip-path の切断角と破片レイヤーの回転角が食い違う。
    // clientWidth で測り直して両者を一致させる。
    const update = () => {
        const w    = document.documentElement.clientWidth;
        const drop = w * Math.tan(DIVIDER_ANGLE_DEG * Math.PI / 180);
        document.documentElement.style.setProperty('--divider-drop', `${drop.toFixed(1)}px`);
    };
    update();
    window.addEventListener('resize', update);
}

// ─────────────────────────────────────────────────────────────
// Header theme
// ヒーローの暗色プレートに載っている部分だけ暗色にする。一括の on/off ではなく、
// 境界と同じ角度の対角線でヘッダーを横切って連続的に切り替わる — スクロールに
// つれて ABOUT → NOTES → … と右の項目から順に反転していく。
// ─────────────────────────────────────────────────────────────

function initHeaderTheme() {
    const header = document.querySelector('.header');
    if (!header || !document.getElementById('hero-canvas')) return;

    // 暗色の帯を境界と同じ傾きで切り抜いてヘッダーに重ねる層
    let plate = header.querySelector('.header-plate');
    if (!plate) {
        plate = document.createElement('div');
        plate.className = 'header-plate';
        plate.setAttribute('aria-hidden', 'true');
        header.insertBefore(plate, header.firstChild);
    }

    const navEl = document.querySelector('.nav');
    const watched = [
        document.getElementById('header-logo'),
        document.querySelector('.hamburger'),
        ...document.querySelectorAll('.nav a'),
    ].filter(Boolean);

    // 境界の画面上の高さ（px、ヘッダーを基準に上が 0）。境界は左端で最も低く
    // （＝暗色が深い）、右端に向かって浅くなる — .hero-wrap の clip-path と同じ式。
    const boundaryY = (x, heroH, drop, viewW, scrollY) =>
        heroH - (x / viewW) * drop - scrollY;

    const update = () => {
        const viewW   = document.documentElement.clientWidth;
        const heroH   = window.innerHeight;   // .hero は 100vh
        const drop    = viewW * Math.tan(DIVIDER_ANGLE_DEG * Math.PI / 180);
        const headerH = header.offsetHeight;
        const sy      = window.scrollY;
        const clamp   = v => Math.max(0, Math.min(headerH, v));

        // header に置けば子の .header-plate が継承して使う
        header.style.setProperty('--hdr-left',  `${clamp(boundaryY(0,     heroH, drop, viewW, sy))}px`);
        header.style.setProperty('--hdr-right', `${clamp(boundaryY(viewW, heroH, drop, viewW, sy))}px`);

        // モバイルではナビが閉時オフキャンバス・開時は明色の全面オーバーレイになり、
        // どちらでも境界の対角線とは無関係になる。position:fixed になるのは
        // その切り替えが起きる幅だけなので、判定に使う。
        const navOffLayout = navEl && getComputedStyle(navEl).position === 'fixed';

        for (const el of watched) {
            if (navOffLayout && navEl.contains(el)) {
                el.classList.remove('over-dark');
                continue;
            }
            const r = el.getBoundingClientRect();
            const cx = r.left + r.width / 2;
            el.classList.toggle('over-dark', boundaryY(cx, heroH, drop, viewW, sy) > headerH / 2);
        }
    };

    let ticking = false;
    const onFrame = () => { ticking = false; update(); };
    const request = () => {
        if (ticking) return;
        ticking = true;
        requestAnimationFrame(onFrame);
    };

    update();
    window.addEventListener('scroll', request, { passive: true });
    window.addEventListener('resize', request);
}

// ─────────────────────────────────────────────────────────────
// Logo typing animation
// ─────────────────────────────────────────────────────────────

function initLogoAnimation() {
    const logo = document.getElementById('header-logo');
    if (!logo) return;

    logo.setAttribute('aria-label', 'Altena — Home');
    logo.innerHTML = '<span class="slash-icon" aria-hidden="true"></span><span class="logo-wordmark" aria-hidden="true">Alt<span class="ena">ena</span></span>';
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    logo.querySelector('.logo-wordmark').animate([
        { clipPath: 'inset(0 100% 0 0)' },
        { clipPath: 'inset(0 0 0 0)' },
    ], { duration: 360, delay: 100, easing: 'steps(6, end)', fill: 'backwards' });
}

function initHomeSectionReveal() {
    const sections = document.querySelectorAll('.home-section');
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (!sections.length || reducedMotion.matches) return;

    const observer = new IntersectionObserver(entries => {
        for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            entry.target.classList.remove('section-pending');
            observer.unobserve(entry.target);
        }
    }, { threshold: 0.05, rootMargin: '0px 0px -24px 0px' });
    for (const section of sections) {
        // 既に表示中の内容は隠し直さず、次に入ってくるセクションだけを演出する。
        const bounds = section.getBoundingClientRect();
        if (bounds.top < window.innerHeight && bounds.bottom > 0) {
            continue;
        }
        section.classList.add('section-reveal', 'section-pending');
        observer.observe(section);
    }
    reducedMotion.addEventListener('change', () => {
        sections.forEach(section => section.classList.remove('section-pending'));
        observer.disconnect();
    }, { once: true });
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
// Title typing (one-time, 2 行)
// ─────────────────────────────────────────────────────────────

const TITLE_LINES = ['Altena', 'Works'];

async function typeInto(el, text, speed) {
    for (const char of text) {
        el.textContent += char;
        await delay(speed);
    }
}

async function initTitleTyping() {
    const line1 = document.querySelector('.title-line-1');
    const line2 = document.querySelector('.title-line-2');
    if (!line1 || !line2) return;

    const cursor1 = document.getElementById('title-cursor-1');
    const cursor2 = document.getElementById('title-cursor-2');

    if (REDUCED_MOTION) {
        line1.textContent = TITLE_LINES[0];
        line2.textContent = TITLE_LINES[1];
        if (cursor1) cursor1.hidden = true;
        return;
    }

    // カーソルは打っている行にだけ出す（行末追従）
    await typeInto(line1, TITLE_LINES[0], 105);
    if (cursor1) cursor1.hidden = true;
    if (cursor2) cursor2.hidden = false;

    await delay(260);
    await typeInto(line2, TITLE_LINES[1], 105);
    if (cursor2) cursor2.hidden = true;
}

// ─────────────────────────────────────────────────────────────
// Subtitle typing (looping)
// ─────────────────────────────────────────────────────────────

function initSubtitleTyping() {
    const prefixTarget   = document.querySelector('.prefix');
    const typingTarget   = document.querySelector('.typing-animation');
    const subtitleCursor = document.getElementById('subtitle-cursor');

    if (!typingTarget || !prefixTarget) return;

    const prefixText = "I'm";
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

    if (REDUCED_MOTION) {
        prefixTarget.textContent = prefixText;
        typingTarget.textContent = phrases[1];
        return;
    }

    if (subtitleCursor) subtitleCursor.hidden = false;
    typePrefix();
}

// ─────────────────────────────────────────────────────────────
// Timeline filters
// ─────────────────────────────────────────────────────────────

function initFilters() {
    const filterCheckboxes = document.querySelectorAll('.filter-controls input[type="checkbox"]');
    const timelineItems    = document.querySelectorAll('.timeline-item');

    if (!filterCheckboxes.length || !timelineItems.length) return;

    const toggle = document.getElementById('timeline-expand');
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const transitions = new WeakMap();
    const setVisibility = (item, show, animate) => {
        const previous = transitions.get(item);
        if (animate && previous?.show === show) return;

        // 連続操作では現在の高さから再開し、古い完了処理が表示状態を戻さないようにする。
        const fromHeight = item.getBoundingClientRect().height;
        const fromOpacity = item.hidden ? 0 : Number(getComputedStyle(item).opacity);
        previous?.animation?.cancel();
        const state = { show, animation: null };
        transitions.set(item, state);
        item.inert = !show;
        item.setAttribute('aria-hidden', String(!show));
        const settle = () => {
            item.hidden = !show;
            item.classList.toggle('hidden', !show);
        };
        if (!animate || reducedMotion.matches) { settle(); return; }

        item.hidden = false;
        item.classList.remove('hidden');
        const toHeight = show ? item.getBoundingClientRect().height : 0;
        const animation = item.animate([
            { height: `${fromHeight}px`, opacity: fromOpacity, overflow: 'clip' },
            { height: `${toHeight}px`, opacity: show ? 1 : 0, overflow: 'clip' },
        ], { duration: 220, easing: 'cubic-bezier(.2, 0, .2, 1)', fill: 'both' });
        state.animation = animation;
        animation.finished.then(() => {
            if (transitions.get(item) !== state) return;
            settle();
            animation.cancel();
            state.animation = null;
        }).catch(() => {});
    };
    let expanded = false;
    const updateFilters = (animate = false) => {
        const active = Array.from(filterCheckboxes)
            .filter(i => i.checked)
            .map(i => i.value);

        const matchingItems = [...timelineItems].filter(item => active.includes(item.dataset.category));
        // 過去→現在の順序を保ち、折りたたみ時だけ末尾の直近4件を表示する。
        const shownItems = new Set(toggle && !expanded ? matchingItems.slice(-4) : matchingItems);
        let visible = 0;
        const matching = matchingItems.length;
        timelineItems.forEach(item => {
            const show = shownItems.has(item);
            if (toggle) setVisibility(item, show, animate);
            else item.classList.toggle('hidden', !show);
            if (show) visible++;
        });

        const countEl = document.getElementById('active-count');
        const totalEl = document.getElementById('total-count');
        if (countEl) countEl.textContent = visible;
        if (totalEl) totalEl.textContent = timelineItems.length;
        if (toggle) {
            toggle.hidden = matching <= 4;
            toggle.setAttribute('aria-expanded', String(expanded));
            toggle.textContent = expanded ? '最新4件に戻す' : `すべての経歴を表示（${matching}件）`;
        }
    };

    updateFilters();
    filterCheckboxes.forEach(cb => cb.addEventListener('change', () => updateFilters(true)));
    if (toggle) toggle.addEventListener('click', () => {
        expanded = !expanded;
        updateFilters(true);
        const heading = document.getElementById('timeline-heading');
        if (heading) {
            heading.focus({ preventScroll: true });
            heading.scrollIntoView({ behavior: reducedMotion.matches ? 'instant' : 'smooth', block: 'start' });
        }
    });
    reducedMotion.addEventListener('change', () => updateFilters(false));
}

// ─────────────────────────────────────────────────────────────
// Circuit line generator
// ─────────────────────────────────────────────────────────────

function drawCircuits() {
    const svg     = document.getElementById('circuit-overlay');
    const wrapper = document.querySelector('.content-wrapper');
    const profile = document.getElementById('profile');
    const footer  = document.querySelector('footer.glass-top');
    if (!svg || !wrapper || !profile || !footer) return;

    const wrapperRect = wrapper.getBoundingClientRect();

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

    // footer は .content-wrapper の外（main の外側の兄弟要素）にあるため、
    // その y 座標は wrapper 自身の高さより大きい。SVG の描画範囲を wrapper の
    // 高さのままにしていると、斜線が footer まで届く前に切れてしまう。
    // svg の高さ（属性・インラインスタイル双方）を footer の位置まで広げる。
    // .content-wrapper 側に overflow は掛かっていないので、こう伸ばしても
    // 見た目上そのまま footer の手前まで描画される。
    const targetY = getCoords(footer).y;
    const svgHeight = Math.max(wrapperRect.height, targetY);
    svg.setAttribute('width',  wrapperRect.width);
    svg.setAttribute('height', svgHeight);
    svg.style.height = `${svgHeight}px`;
    svg.innerHTML = '';

    const lineEnd = (el, margin) => {
        if (!el) return null;
        const c = getCoords(el);
        return { x: c.x + c.w - margin, y: c.y + c.h - 8.75 };
    };

    const p1 = lineEnd(document.querySelector('#skills .section-title'),   -60);
    const p2 = lineEnd(document.querySelector('#timeline .section-title'), -40);
    const p3 = lineEnd(document.querySelector('#works .section-title'),    -20);

    // 斜め区間は常に 45° 固定（水平に進んだ分だけ垂直にも進む）なので、
    // x=0 での到達点は "bendY + pStart.x" になる。3 本とも footer の上端
    // （targetY）にちょうど届くよう、staggerY（0/30/60px）だけずらした点に
    // 着地するよう bendY を逆算する。
    // ただし works（Latest Notes）のように着地点までの縦距離が横距離
    // （pStart.x）より短いと、逆算した bendY が pStart.y より上に出てしまい、
    // 「垂直区間」が上向きに描かれて折り返って見えるバグがあった
    // （目視デスクトップ幅 ~1100px 以上で再現）。bendY が pStart.y を
    // 下回るときは 45° 二段構成をやめ、start から着地点まで一直線で結ぶ
    // （常に単調に下へ・左へ進むことを保証する）。
    const drawPath = (pStart, staggerY) => {
        if (!pStart) return;
        const landY = targetY - staggerY;
        const bendY = landY - pStart.x;
        const d = bendY >= pStart.y
            ? `M ${pStart.x} ${pStart.y} L ${pStart.x} ${bendY} L 0 ${landY}`
            : `M ${pStart.x} ${pStart.y} L 0 ${landY}`;
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('class', 'circuit-path');
        path.setAttribute('d', d);
        svg.appendChild(path);
    };

    drawPath(p1, 0);
    drawPath(p2, 30);
    drawPath(p3, 60);
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
