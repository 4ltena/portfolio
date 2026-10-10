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
  vm.runInContext(fragment(' const STRIPE_SPEED=', ' let w=') + snapSource + drawSource + eventSource, state);
  function runSnap() { state.queueSettle(); timers.splice(0).forEach(fn => fn()); }
  function finishSnap() { frames.splice(0).forEach(fn => fn(1460)); }
  return { state, timers, frames, calls, events, runSnap, finishSnap };
}
for (const [name, y, direction, armed] of [
  ['above', 800, 1, false], ['forward overshoot', 1080, 1, false],
  ['below', 1250, -1, true], ['reverse overshoot', 930, -1, true]
]) test('snap from ' + name + ' and release on next gesture', () => {
  const h = harness(y, direction); h.state.returnArmed = armed; h.runSnap();
  assert.equal(h.frames.length, 1); h.finishSnap(); assert.equal(h.state.scrollY, h.state.scrollGeometry().target);
  assert.equal(h.calls[0].behavior, 'instant');
  h.state.scrollY += direction * 60; h.runSnap(); assert.equal(h.frames.length, 0);
});
test('outside, reduced motion, active pointer and top return do not snap', () => {
  for (const changes of [{ scrollY: 400 }, { enabled: false }, { holding: true }, { returningToTop: true }]) {
    const h = harness(800); Object.assign(h.state, changes); h.runSnap(); assert.equal(h.frames.length, 0);
  }
});
test('invisible logs defer rebuilding; completed canvas is not redrawn', () => {
  const h = harness(2200); h.state.draw(); assert.equal(h.state.clears, 1);
  h.state.logDirty = true; h.state.scrollY = 2400; h.state.draw();
  assert.equal(h.state.clears, 1); assert.equal(h.state.rebuilds, 0);
  h.state.scrollY = 0; h.state.draw(); assert.equal(h.state.rebuilds, 1);
  assert.equal(h.state.textMode.inert, false);
});
test('mobile logs stay hidden; arrow still updates with reduced motion', () => {
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
test('scrollend only clears top return after reaching the top', () => {
  const h = harness(5000); click(h);
  h.state.scrollY = 800; h.events.scrollend();
  assert.equal(h.state.returningToTop, true);
  h.state.performance.now = () => 10000;
  h.events.scroll(); h.runSnap();
  assert.equal(h.frames.length, 0);
  h.state.scrollY = 0; h.events.scrollend();
  assert.equal(h.state.returningToTop, false);
  assert.notEqual(h.state.suppressUntil, Infinity);
});
test('reduced motion returns instantly; modified links retain browser behavior', () => {
  const h = harness(5000); h.state.reduced.matches = true; click(h);
  assert.equal(h.calls.at(-1).behavior, 'instant'); assert.equal(h.state.returningToTop, false);
  const modified = harness(5000); assert.equal(click(modified, { ctrlKey: true }), false);
  assert.equal(modified.calls.length, 0);
});

test('wide approach windows catch both directions', () => {
  for(const d of [1,-1]) {
    const h=harness(0,d),g=h.state.scrollGeometry();
    h.state.scrollY=d>0?g.complete-50:g.end+50;h.state.returnArmed=d<0;h.runSnap();
    assert.equal(h.frames.length,1);h.finishSnap();assert.equal(h.state.scrollY,h.state.scrollGeometry().target);
  }
});
test('a fast scroll crossing the target is caught outside the proximity window', () => {
  for(const [from,to,d] of [[200,2200,1],[2200,200,-1]]) {
    const h=harness(from,d);h.state.returnArmed=d<0;h.state.scrollY=to;
    h.events.scroll();h.timers.splice(0).forEach(fn=>fn());
    assert.equal(h.frames.length,1);h.finishSnap();assert.equal(h.state.scrollY,h.state.scrollGeometry().target);
    h.state.scrollY+=d*60;h.runSnap();assert.equal(h.frames.length,0);
  }
});
test('Ideas completes after the bands pass; Lite remains operable during character erasure', () => {
  const h=harness(2080);h.state.draw();assert.equal(h.state.copy.style.opacity,1);
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

test('divider displacement uses the selected 3.5x speed', () => {
 const h=harness(100);const values={};h.state.hero.style.setProperty=(key,value)=>values[key]=value;h.state.draw();assert.equal(values['--bridge-rise'],'350px');
 h.state.scrollY=400;h.state.draw();assert.equal(values['--bridge-rise'],'1400px');
});

test('the selected geometry has no gap and holds the completed Ideas view for 60vh',()=>{
 const h=harness();const g=h.state.scrollGeometry();
 assert.equal(g.stripeEnd,g.travel/3.5);
 assert.equal(g.revealStart,g.stripeEnd);
 assert.ok(Math.abs(g.end-g.complete-600)<1e-9);
 for(const y of [g.complete,g.target,g.end]){
  h.state.scrollY=y;h.state.draw();
  assert.equal(h.state.copy.style.opacity,1);assert.equal(h.state.prose.style.opacity,1);
 }
});
test('the hold distance scales with the viewport, including compact screens',()=>{
 const h=harness();h.state.h=640;h.state.w=390;h.state.slope=127;
 const g=h.state.scrollGeometry();
 assert.ok(Math.abs(g.end-g.complete-384)<1e-9);
 h.state.scrollY=g.target;h.state.draw();assert.equal(h.state.copy.style.opacity,1);
});
test('Ideas stays hidden until the final stripe clears',()=>{
 const h=harness();h.state.scrollY=h.state.scrollGeometry().stripeEnd-1;h.state.draw();
 assert.equal(h.state.copy.style.opacity,0);assert.equal(h.state.art.style.opacity,0);
});
