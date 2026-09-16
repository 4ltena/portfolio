const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../js/ideas-transition.js'), 'utf8');
function fragment(start, end) {
  const from = source.indexOf(start), to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, 'production function exists');
  return source.slice(from, to);
}
const snapSource = fragment(' function queueSettle(', ' if(logSource){');
const drawSource = fragment(' function draw(){', ' function schedule(){');
const eventSource = fragment(" addEventListener('portfolio:section-navigation',", " document.documentElement.classList");
function harness(y = 0, direction = 1) {
  const timers = [], frames = [], calls = [], events = {};
  const state = {
    h: 1000, w: 1200, dpr: 1, slope: 390, bleed: 72, pending: false,
    scrollY: y, scrollX: 0, innerHeight: 1000, direction, lastY: y,
    enabled: true, holding: false, settling: false, returningToTop: false,
    returnArmed: false, forwardArmed: true, crossedTarget: false, suppressUntil: 0,
    settleTimer: 0, settleFrame: 0, lastProgress: -1, logDirty: true,
    clamp: v => Math.max(0, Math.min(1, v)), lerp: (a, b, t) => a + (b - a) * t,
    smooth(a, b, p) { const t = state.clamp((p - a) / (b - a)); return t * t * (3 - 2 * t); },
    performance: { now: () => 1000 },
    section: { offsetHeight: 2000, getBoundingClientRect: () => ({ top: -state.scrollY }) },
    stage: { offsetHeight: 1000 },
    clearTimeout() { timers.length = 0; }, cancelAnimationFrame() { frames.length = 0; },
    setTimeout(fn) { timers.push(fn); return 1; }, requestAnimationFrame(fn) { frames.push(fn); return 1; },
    scrollTo(options) { calls.push(options); if (options.behavior === 'instant') state.scrollY = options.top; },
    addEventListener(name, fn) { events[name] = fn; },
    reduced: { matches: false },
    document: {
      body: { classList: { toggle() {} } },
      addEventListener(name, fn) { events[name] = fn; },
      getElementById() { return { focus(options) { state.focusOptions = options; } }; }
    },
    hero: { style: { setProperty() {} } }, heroContent: { style: {} },
    copy: { style: {} }, prose: { style: {} }, art: { style: {}, classList: { add() {} } },
    textMode: { style: {}, inert: false },
    backToTop: { classList: { toggle(_, value) { state.controlVisible = value; } } },
    ctx: { setTransform() {}, clearRect() { state.clears++; } }, clears: 0,
    polygon() {}, eraseLog() {},
    prepareLog() { state.rebuilds++; state.logDirty = false; }, rebuilds: 0,
    schedule() {},
    cancelSettle() { timers.length = 0; frames.length = 0; state.settling = false; }
  };
  vm.createContext(state);
  vm.runInContext(snapSource + drawSource + eventSource, state);
  function runSnap() { state.queueSettle(); timers.splice(0).forEach(fn => fn()); }
  function finishSnap() { frames.splice(0).forEach(fn => fn(1460)); }
  return { state, timers, frames, calls, events, runSnap, finishSnap };
}
for (const [name, y, direction, armed] of [
  ['above', 800, 1, false], ['forward overshoot', 1080, 1, false],
  ['below', 1350, -1, true], ['reverse overshoot', 930, -1, true]
]) test('snap from ' + name + ' and release on next gesture', () => {
  const h = harness(y, direction); h.state.returnArmed = armed; h.runSnap();
  assert.equal(h.frames.length, 1); h.finishSnap(); assert.equal(h.state.scrollY, 1000);
  assert.equal(h.calls[0].behavior, 'instant');
  h.state.scrollY += direction * 60; h.runSnap(); assert.equal(h.frames.length, 0);
});
test('outside, reduced motion, active pointer and top return do not snap', () => {
  for (const changes of [{ scrollY: 400 }, { enabled: false }, { holding: true }, { returningToTop: true }]) {
    const h = harness(800); Object.assign(h.state, changes); h.runSnap(); assert.equal(h.frames.length, 0);
  }
});
test('invisible logs defer rebuilding; completed canvas is not redrawn', () => {
  const h = harness(2000); h.state.draw(); assert.equal(h.state.clears, 1);
  h.state.logDirty = true; h.state.scrollY = 2400; h.state.draw();
  assert.equal(h.state.clears, 1); assert.equal(h.state.rebuilds, 0);
  h.state.scrollY = 0; h.state.draw(); assert.equal(h.state.rebuilds, 1);
  assert.equal(h.state.textMode.inert, false);
});
test('mobile hidden logs are not built; arrow still updates with reduced motion', () => {
  const h = harness(0); h.state.w = 390; h.state.draw(); assert.equal(h.state.rebuilds, 0);
  h.state.enabled = false; h.state.scrollY = 600; h.state.draw(); assert.equal(h.state.controlVisible, true);
  h.state.scrollY = 0; h.state.draw(); assert.equal(h.state.controlVisible, false);
});
function click(h, extra = {}) {
  const anchor = {}; let prevented = false;
  h.events.click({ target: { closest: () => anchor }, button: 0, preventDefault() { prevented = true; }, ...extra });
  return prevented;
}
test('top return uses native smooth motion and focus without a jump', () => {
  const h = harness(5000); assert.equal(click(h), true);
  assert.equal(h.calls.at(-1).behavior, 'smooth'); assert.equal(h.state.returningToTop, true);
  assert.equal(h.state.focusOptions.preventScroll, true);
  h.state.scrollY = 1200; h.events.scroll(); assert.equal(h.timers.length, 0);
  h.state.scrollY = 0; h.events.scroll(); assert.equal(h.state.returningToTop, false);
});
test('wheel interrupts native return and restores normal scrolling', () => {
  const h = harness(5000); click(h); h.state.scrollY = 2400; h.events.wheel({ deltaY: -20 });
  assert.equal(h.state.returningToTop, false); assert.equal(h.calls.at(-1).behavior, 'instant');
  assert.equal(h.calls.at(-1).top, 2400);
});
test('scrollend clears return state', () => {
  const h = harness(5000); click(h); h.events.scrollend(); assert.equal(h.state.returningToTop, false);
});
test('reduced motion returns instantly; modified links retain browser behavior', () => {
  const h = harness(5000); h.state.reduced.matches = true; click(h);
  assert.equal(h.calls.at(-1).behavior, 'instant'); assert.equal(h.state.returningToTop, false);
  const modified = harness(5000); assert.equal(click(modified, { ctrlKey: true }), false);
  assert.equal(modified.calls.length, 0);
});

test('wide approach windows catch both directions', () => {
  for(const [y,d] of [[600,1],[1500,-1]]) {
    const h=harness(y,d);h.state.returnArmed=d<0;h.runSnap();
    assert.equal(h.frames.length,1);h.finishSnap();assert.equal(h.state.scrollY,1000);
  }
});
test('a fast scroll crossing the target is caught outside the proximity window', () => {
  for(const [from,to,d] of [[200,2200,1],[2200,200,-1]]) {
    const h=harness(from,d);h.state.returnArmed=d<0;h.state.scrollY=to;
    h.events.scroll();h.timers.splice(0).forEach(fn=>fn());
    assert.equal(h.frames.length,1);h.finishSnap();assert.equal(h.state.scrollY,1000);
    h.state.scrollY+=d*60;h.runSnap();assert.equal(h.frames.length,0);
  }
});
test('Ideas completes earlier and Lite remains operable during character erasure', () => {
  const h=harness(720);h.state.draw();assert.equal(h.state.copy.style.opacity,1);
  h.state.scrollY=150;h.state.draw();assert.equal(h.state.textMode.inert,false);
});

test('pending crossing is discarded by pointer interruption or wheel reversal', () => {
  for(const interrupt of ['pointer','wheel','key']) {
    const h=harness(200);h.state.scrollY=2200;h.events.scroll();assert.equal(h.state.crossedTarget,true);
    if(interrupt==='pointer'){h.events.pointerdown();h.events.pointerup();}
    if(interrupt==='wheel'){h.events.wheel({deltaY:-10});h.state.queueSettle();}
    if(interrupt==='key')h.events.keydown();
    h.timers.splice(0).forEach(fn=>fn());assert.equal(h.state.crossedTarget,false);assert.equal(h.frames.length,0);
  }
});

test('section links bypass snapping without leaving a pending crossing', () => {
 const h = harness(2200, 1);
 h.events['portfolio:section-navigation']({ detail: { active: true } });
 h.state.queueSettle(200);
 assert.equal(h.state.crossedTarget, false);
 h.events['portfolio:section-navigation']({ detail: { active: false } });
 h.state.queueSettle(200);
 assert.equal(h.state.crossedTarget, false);
});
