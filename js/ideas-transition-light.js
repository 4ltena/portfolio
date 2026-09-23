(() => {
  'use strict';

  const section = document.getElementById('scroll-bridge');
  if (!section) return;

  const stage = section.querySelector('.bridge-stage');
  const hero = stage?.querySelector('.hero-wrap');
  const copy = stage?.querySelector('.bridge-copy');
  const art = stage?.querySelector('.idea-art');
  const prose = stage?.querySelector('.idea-prose');
  if (!stage || !hero || !copy || !art || !prose) return;

  const heroContent = hero.querySelector('.hero-content');
  const heroLog = hero.querySelector('.hero-log');
  const heroDrawing = hero.querySelector('.hero-drawing');
  const heroFoot = hero.querySelector('.hero-foot');
  const logSource = hero.querySelector('.divider-status-beacon');
  const textMode = logSource?.querySelector('.divider-status-textmode');
  const backToTop = document.querySelector('.back-to-top');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');

  const clamp = value => Math.max(0, Math.min(1, value));
  const smooth = (start, end, progress) => {
    const value = clamp((progress - start) / (end - start));
    return value * value * (3 - 2 * value);
  };
  const lerp = (start, end, progress) => start + (end - start) * progress;
  const IDEAS_HOLD_VH = 60;

  let height = 1;
  let pending = false;
  let enabled = false;
  let lastProgress = -1;
  let logCharacters = [];
  let logOrder = [];
  let logStep = -1;
  let logVisual = null;
  let logDirty = true;
  let logIgnited = false;

  const scrollGeometry = () => {
    const revealStart = height * .12;
    const complete = height * .45;
    const end = complete + height * IDEAS_HOLD_VH / 100;
    return { revealStart, complete, end, target: (complete + end) / 2 };
  };

  function prepareLog() {
    if (!logSource) return;
    logSource.querySelectorAll('.divider-status-line').forEach(line => {
      line.style.removeProperty('font-size');
    });

    const replacement = logSource.cloneNode(true);
    replacement.classList.remove('bridge-log-source');
    replacement.classList.add('bridge-log-fragments');
    replacement.setAttribute('aria-hidden', 'true');
    replacement.setAttribute('inert', '');
    replacement.removeAttribute('id');
    replacement.querySelectorAll('[id],[aria-live],[role]').forEach(element => {
      element.removeAttribute('id');
      element.removeAttribute('aria-live');
      element.removeAttribute('role');
    });

    const walker = document.createTreeWalker(replacement, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);

    logCharacters = [];
    nodes.forEach(node => {
      if (!node.textContent.trim()) return;
      const fragment = document.createDocumentFragment();
      for (const character of node.textContent) {
        const span = document.createElement('span');
        span.className = 'log-char';
        span.textContent = character;
        fragment.append(span);
        if (character.trim()) logCharacters.push(span);
      }
      node.replaceWith(fragment);
    });

    if (logVisual) logVisual.replaceChildren(...replacement.childNodes);
    else {
      logSource.after(replacement);
      logVisual = replacement;
    }

    logOrder = logCharacters.map((_, index) => index);
    let seed = 731;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    for (let index = logOrder.length - 1; index > 0; index -= 1) {
      const target = Math.floor(random() * (index + 1));
      [logOrder[index], logOrder[target]] = [logOrder[target], logOrder[index]];
    }

    logStep = -1;
    logDirty = false;
  }

  function eraseLog(progress) {
    if (!logVisual) return;
    const amount = clamp((progress - .012) / .18);
    const cut = Math.min(
      logOrder.length,
      Math.floor(amount * logOrder.length / 4) * 4 + (amount === 1 ? 4 : 0),
    );
    if (cut === logStep) return;
    logStep = cut;

    logOrder.forEach((index, rank) => {
      const span = logCharacters[index];
      const next = amount > 0 && amount < 1 && rank >= cut && rank < cut + 4;
      span.style.visibility = rank < cut ? 'hidden' : 'visible';
      span.style.transform = next ? `translate(${index % 2 ? 3 : -3}px,${index % 3 - 1}px)` : 'none';
      span.style.textShadow = next ? '2px 0 #39cfe3, -1px 0 #b7bee5' : 'none';
    });
    logVisual.dataset.missing = String(cut);
    logVisual.dataset.total = String(logCharacters.length);
  }

  function powerLog() {
    if (logIgnited || !logVisual) return;
    logIgnited = true;
    if (reduced.matches || scrollY > 2 || performance.getEntriesByType('navigation')[0]?.type === 'back_forward') return;
    const split = 'drop-shadow(1px 0 #00e5ff) drop-shadow(-1px 0 #8a3ffc)';
    logVisual.animate([
      { opacity: .06, translate: '0 0', filter: 'none', offset: 0 },
      { opacity: .72, translate: '1px 0', filter: split, offset: .15 },
      { opacity: .12, translate: '-1px 0', filter: 'none', offset: .3 },
      { opacity: .72, translate: '-1px 0', filter: split, offset: .5 },
      { opacity: .3, translate: '1px 0', filter: 'none', offset: .62 },
      { opacity: .72, translate: '0 0', filter: 'none', offset: 1 },
    ].map(frame => ({ ...frame, easing: 'steps(1,end)' })), { duration: 300 });
  }

  function resetHeroStyles() {
    [heroContent, heroLog, heroDrawing, heroFoot].filter(Boolean).forEach(element => {
      element.style.removeProperty('opacity');
      element.style.removeProperty('transform');
    });
  }

  function fitIdeasTail() {
    section.style.setProperty('--ideas-tail-space', `${Math.max(0, height - prose.offsetTop - prose.offsetHeight)}px`);
  }

  function draw() {
    pending = false;
    if (backToTop) backToTop.classList.toggle('is-visible', scrollY > Math.min(innerHeight * .35, 240));
    if (!enabled) return;

    const rect = section.getBoundingClientRect();
    const geometry = scrollGeometry();
    const distance = Math.min(geometry.end, Math.max(0, -rect.top));
    const phase = distance / height;
    const refreshLog = logDirty && phase < .08;
    if (phase === lastProgress && !refreshLog) return;
    lastProgress = phase;
    if (refreshLog) prepareLog();

    const heroExit = smooth(.02, .34, phase);
    const logProgress = clamp(phase / .38);
    if (heroContent) {
      heroContent.style.opacity = String(1 - heroExit);
      heroContent.style.transform = `translateY(${lerp(0, -28, heroExit)}px)`;
    }
    if (heroDrawing) heroDrawing.style.opacity = String(1 - smooth(.06, .38, phase));
    if (heroFoot) heroFoot.style.opacity = String(1 - smooth(.02, .22, phase));
    if (heroLog) heroLog.style.opacity = String(1 - smooth(.2, .4, phase));
    eraseLog(logProgress);

    if (textMode) {
      textMode.style.visibility = phase < .28 ? 'visible' : 'hidden';
      textMode.inert = phase >= .28;
    }

    const contentProgress = clamp((distance - geometry.revealStart) / (geometry.complete - geometry.revealStart));
    const shown = smooth(0, .72, contentProgress);
    copy.style.opacity = String(shown);
    copy.style.visibility = shown > 0 ? 'visible' : 'hidden';
    copy.style.transform = `translateY(${lerp(12, 0, shown)}px)`;
    art.style.opacity = String(smooth(.12, .84, contentProgress));
    prose.style.opacity = String(smooth(.42, 1, contentProgress));
    prose.style.visibility = contentProgress > .38 ? 'visible' : 'hidden';
    if (contentProgress > .22) art.classList.add('is-drawn');
  }

  function schedule() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(draw);
  }

  let settleTimer = 0;
  let settleFrame = 0;
  let settling = false;
  let lastY = scrollY;
  let direction = 0;
  let holding = false;
  let suppressUntil = 0;
  let returnArmed = false;
  let forwardArmed = true;
  let returningToTop = false;
  let crossedTarget = false;

  function cancelSettle() {
    clearTimeout(settleTimer);
    cancelAnimationFrame(settleFrame);
    settling = false;
  }

  function queueSettle(previousY = scrollY) {
    clearTimeout(settleTimer);
    if (performance.now() < suppressUntil) {
      crossedTarget = false;
      return;
    }
    const start = section.getBoundingClientRect().top + scrollY;
    const geometry = scrollGeometry();
    const target = start + geometry.target;
    const lower = start + geometry.complete - height * .06;
    const upper = start + geometry.end + height * .06;
    if (scrollY > upper + height * .15) returnArmed = true;
    else if (scrollY < lower - height * .15) forwardArmed = true;
    if (direction > 0 && forwardArmed && previousY < target && scrollY >= target) crossedTarget = true;
    if (direction < 0 && returnArmed && previousY > target && scrollY <= target) crossedTarget = true;
    if (!enabled || returningToTop || holding || direction === 0 || performance.now() < suppressUntil) return;

    settleTimer = setTimeout(() => {
      if (!enabled || returningToTop || holding || performance.now() < suppressUntil) return;
      const forward = direction > 0 && forwardArmed && (crossedTarget || (scrollY >= lower && scrollY <= upper));
      const returning = direction < 0 && returnArmed && (crossedTarget || (scrollY >= lower && scrollY <= upper));
      if (!forward && !returning) return;
      returnArmed = false;
      forwardArmed = false;
      crossedTarget = false;
      if (Math.abs(scrollY - target) < 2) return;

      const from = scrollY;
      const startedAt = performance.now();
      settling = true;
      const advance = now => {
        const progress = clamp((now - startedAt) / 460);
        scrollTo({ top: lerp(from, target, progress * progress * (3 - 2 * progress)), behavior: 'instant' });
        lastY = scrollY;
        if (progress < 1) settleFrame = requestAnimationFrame(advance);
        else settling = false;
      };
      settleFrame = requestAnimationFrame(advance);
    }, 180);
  }

  function resize() {
    cancelSettle();
    crossedTarget = false;
    lastProgress = -1;
    logDirty = true;
    enabled = !reduced.matches;
    document.documentElement.classList.toggle('bridge-enhanced', enabled);
    document.body.classList.toggle('bridge-light', enabled);

    if (!enabled) {
      if (logVisual) {
        logVisual.remove();
        logVisual = null;
      }
      section.style.removeProperty('height');
      section.style.removeProperty('--ideas-tail-space');
      if (textMode) {
        textMode.style.removeProperty('visibility');
        textMode.inert = false;
      }
      resetHeroStyles();
      [copy, art, prose].forEach(element => {
        element.style.removeProperty('opacity');
        element.style.removeProperty('transform');
        element.style.removeProperty('visibility');
      });
      return;
    }

    height = stage.clientHeight;
    section.style.height = `${height + scrollGeometry().end}px`;
    draw();
    fitIdeasTail();
  }

  if (logSource) {
    logSource.classList.add('bridge-log-source');
    new MutationObserver(() => {
      logDirty = true;
      schedule();
    }).observe(logSource, { childList: true, subtree: true, characterData: true });
  }

  addEventListener('portfolio:section-navigation', event => {
    cancelSettle();
    crossedTarget = false;
    direction = 0;
    lastY = scrollY;
    suppressUntil = event.detail.active ? Infinity : performance.now() + 1400;
  });

  addEventListener('scroll', () => {
    schedule();
    const previousY = lastY;
    const delta = scrollY - lastY;
    lastY = scrollY;
    if (returningToTop) {
      if (scrollY <= 1) {
        returningToTop = false;
        suppressUntil = performance.now() + 300;
      }
      return;
    }
    if (settling) return;
    if (Math.abs(delta) > .1) direction = Math.sign(delta);
    queueSettle(previousY);
  }, { passive: true });

  addEventListener('pointerdown', () => { holding = true; cancelSettle(); }, { passive: true });
  addEventListener('pointerup', () => { holding = false; }, { passive: true });
  addEventListener('touchcancel', () => { holding = false; }, { passive: true });
  addEventListener('wheel', () => { if (settling) cancelSettle(); }, { passive: true });
  addEventListener('keydown', event => {
    if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key) && settling) cancelSettle();
  });

  document.addEventListener('click', event => {
    const target = event.target.closest('a[href="#top"],.back-to-top');
    if (!target) return;
    cancelSettle();
    returningToTop = !reduced.matches && scrollY > 1;
    if (returningToTop) suppressUntil = Infinity;
    document.getElementById('top').focus({ preventScroll: true });
    scrollTo({ top: 0, left: 0, behavior: reduced.matches ? 'instant' : 'smooth' });
  }, true);

  document.documentElement.classList.add('has-scroll-controls');
  addEventListener('load', powerLog, { once: true });
  document.fonts.ready.then(() => {
    logDirty = true;
    if (enabled) fitIdeasTail();
    schedule();
  });
  addEventListener('resize', resize);
  reduced.addEventListener('change', resize);
  resize();
})();
