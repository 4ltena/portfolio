const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'hero-light.css'), 'utf8');
const transition = fs.readFileSync(path.join(root, 'js/ideas-transition-light.js'), 'utf8');

test('production home no longer loads Three.js or either transition canvas', () => {
  assert.doesNotMatch(html, /three(?:\.module|\/addons|\.js)|type="importmap"|hero-canvas|bridge-canvas/i);
  assert.doesNotMatch(html, /js\/hero\.js|js\/divider-intro\.js|js\/ideas-transition\.js/);
  assert.match(html, /hero-light\.css\?v=20260923-light-hero-4/);
  assert.match(html, /js\/ideas-transition-light\.js\?v=20260923-no-stripes/);
  assert.match(html, /class="pastel-home light-hero-home"/);
});

test('typing, no-script title and live log contracts are preserved', () => {
  assert.match(html, /class="title-line-1"><\/span>/);
  assert.match(html, /class="title-line-2"><\/span>/);
  assert.match(html, /id="title-cursor-1"/);
  assert.match(html, /id="title-cursor-2" hidden/);
  assert.match(html, /<noscript>.*Altena.*Portfolio.*<\/noscript>/s);
  assert.match(html, /aria-label="Altena Portfolio"/);

  const requiredIds = [
    'divider-status-value',
    'divider-status-tls',
    'divider-status-server',
    'divider-status-uptime',
    'divider-status-detail',
  ];
  requiredIds.forEach(id => {
    assert.equal((html.match(new RegExp(`id="${id}"`, 'g')) || []).length, 1, `${id} is unique`);
  });
  assert.match(html, /href="lite\.html" class="divider-status-line divider-status-textmode"/);
  assert.match(html, /\[RENDER\]<\/span><span>DOM \/ CSS \/ SVG/);
});

test('light hero is crisp, responsive and motion-aware', () => {
  assert.match(css, /--air:\s*#fafdfe/i);
  assert.match(css, /\.light-hero-home \.hero-title\s*\{[^}]*text-shadow:\s*none/s);
  assert.match(css, /\.light-hero-home \.hero-title\s*\{[^}]*font-weight:\s*480/s);
  assert.match(css, /@media\s*\(max-width:\s*700px\)/);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  assert.doesNotMatch(css, /\.divider-lines/);
});

test('Ideas handoff is DOM-only and keeps bidirectional hold controls', () => {
  assert.doesNotThrow(() => new vm.Script(transition));
  assert.doesNotMatch(transition, /getContext\(|fillStyle|polygon\(|bridge-canvas/);
  assert.doesNotMatch(transition, /\['#90d7e2','#b7bee5','#bfd8ca','#e8baa6'\]/);
  assert.match(transition, /IDEAS_HOLD_VH\s*=\s*60/);
  assert.match(transition, /direction\s*>\s*0/);
  assert.match(transition, /direction\s*<\s*0/);
  assert.match(transition, /document\.documentElement\.classList\.toggle\('bridge-enhanced', enabled\)/);
  assert.match(transition, /enabled\s*=\s*!reduced\.matches/);
});
