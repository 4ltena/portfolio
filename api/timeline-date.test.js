'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { formatCompactDate } = require('../js/calendar-date');

test('shared calendar helper preserves Notes formats and strictly normalizes full Timeline dates', () => {
    for (const value of ['20260811', '2026/08/11', '2026-08-11', ' 20260811 ']) assert.equal(formatCompactDate(value, true), '2026/08/11');
    assert.equal(formatCompactDate('20240229', true), '2024/02/29');
    assert.equal(formatCompactDate('20000229', true), '2000/02/29');
    for (const value of ['', '2026', '2026/08', '202608', '2026081', '2026/8/11', '2026/08-11', '20260230', '20260229', '19000229', '20261301', '00000101', 20260811, null, [], {}]) assert.equal(formatCompactDate(value, true), null, String(value));
    assert.equal(formatCompactDate('20260811'), '2026/08/11');
    assert.equal(formatCompactDate('2026/08/11'), '2026/08/11');
    assert.equal(formatCompactDate('2026-08-11'), null, 'Notes retain their prior accepted input formats');
});

test('actual editor handlers normalize blur, change, IME, editing and saved Timeline payloads', async () => {
    const source = fs.readFileSync(path.join(__dirname, '../admin/editor.html'), 'utf8');
    assert.match(source, /<script src="\.\.\/js\/calendar-date\.js\?[^"\n]+"><\/script>/);
    const fields = new Map();
    for (const id of ['date-input', 'tl-date', 'tl-form', 'tl-category', 'tl-title', 'tl-href']) {
        fields.set(id, { id, value: '', validity: '', reports: 0, handlers: {}, setCustomValidity(message) { this.validity = message; }, reportValidity() { this.reports++; }, addEventListener(event, handler) { this.handlers[event] = handler; } });
    }
    const requests = [];
    const context = vm.createContext({
        document: { getElementById: id => fields.get(id) },
        tlEditId: { value: '' }, tlCancel: { style: {} }, tlSubmit: { disabled: false }, tlStatus: {},
        window: { scrollTo() {} }, verifyAuth: async () => true, authHeader: () => ({}), showItemStatus() {}, tlClearForm() {}, loadTimeline() {},
        fetch: async (url, options) => { requests.push({ url, ...options, body: JSON.parse(options.body) }); return { ok: true, json: async () => ({}) }; }
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/calendar-date.js'), 'utf8'), context);
    const dateStart = source.indexOf('    // Notesの入力形式を保ち');
    const dateEnd = source.indexOf('    // Today default', dateStart);
    assert.ok(dateStart >= 0 && dateEnd > dateStart);
    vm.runInContext(source.slice(dateStart, dateEnd), context);
    const handlersStart = source.indexOf('    function tlStartEdit(item)');
    const handlersEnd = source.indexOf('    async function loadTimeline()', handlersStart);
    assert.ok(handlersStart >= 0 && handlersEnd > handlersStart);
    vm.runInContext(source.slice(handlersStart, handlersEnd), context);

    const date = fields.get('tl-date');
    date.value = '20260811'; date.handlers.change(); assert.equal(date.value, '2026/08/11'); assert.equal(date.validity, '');
    date.value = '20240229'; date.handlers.blur(); assert.equal(date.value, '2024/02/29');
    date.value = '20260811'; date.handlers.input({ isComposing: true }); assert.equal(date.value, '20260811');
    date.handlers.compositionend(); assert.equal(date.value, '2026/08/11');
    vm.runInContext("tlStartEdit({id:'legacy',date:'20260811',category:'school',title:'Legacy',href:null})", context);
    assert.equal(date.value, '2026/08/11');

    date.value = '20260811'; fields.get('tl-category').value = 'school'; fields.get('tl-title').value = 'Event'; fields.get('tl-href').value = '';
    await fields.get('tl-form').handlers.submit({ preventDefault() {} });
    assert.equal(requests.length, 1); assert.equal(requests[0].body.date, '2026/08/11');
    assert.equal(requests[0].method, 'PUT');
    for (const invalid of ['20260230', '2026/08', '']) {
        date.value = invalid; date.handlers.change(); assert.notEqual(date.validity, '');
        await fields.get('tl-form').handlers.submit({ preventDefault() {} });
    }
    assert.equal(requests.length, 1, 'invalid or partial dates cannot reach save');
    assert.ok(date.reports >= 3);
});

test('Timeline POST and PUT normalize direct API writes and reject invalid calendars without changing records', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'portfolio-timeline-write-'));
    const names = ['PORTFOLIO_ROOT', 'PORTFOLIO_DATA_DIR', 'PORTFOLIO_NOTES_OUT_DIR', 'PORTFOLIO_IMG_DIR', 'ADMIN_PASSWORD', 'NODE_ENV'];
    const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
    Object.assign(process.env, { PORTFOLIO_ROOT: root, PORTFOLIO_DATA_DIR: path.join(root, 'data'), PORTFOLIO_NOTES_OUT_DIR: path.join(root, 'notes'), PORTFOLIO_IMG_DIR: path.join(root, 'img'), ADMIN_PASSWORD: 'timeline-test-only-password', NODE_ENV: 'test' });
    fs.mkdirSync(process.env.PORTFOLIO_DATA_DIR, { recursive: true });
    fs.writeFileSync(path.join(process.env.PORTFOLIO_DATA_DIR, 'config.json'), JSON.stringify({ passwordHash: 'unused', jwtSecret: 'timeline-test-only-secret', shareSecret: 'timeline-test-only-share-secret' }), { mode: 0o600 });
    const serverPath = require.resolve('./server');
    delete require.cache[serverPath];
    const runtime = require('./server');
    const originalCount = runtime.db.prepare('SELECT count(*) AS count FROM timeline').get().count;
    const listener = runtime.app.listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => { listener.once('listening', resolve); listener.once('error', reject); });
    t.after(async () => {
        await new Promise(resolve => listener.close(resolve)); runtime.db.close(); delete require.cache[serverPath];
        for (const [name, value] of Object.entries(previous)) value === undefined ? delete process.env[name] : process.env[name] = value;
        fs.rmSync(root, { recursive: true, force: true });
    });
    const token = require('jsonwebtoken').sign({ admin: true }, runtime.config.jwtSecret, { expiresIn: '5m' });
    const origin = `http://127.0.0.1:${listener.address().port}`;
    const request = (url, method, body) => fetch(origin + url, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const createdResponse = await request('/timeline', 'POST', { date: '20260811', title: 'Timeline date', category: 'school' });
    assert.equal(createdResponse.status, 201);
    const item = await createdResponse.json();
    assert.equal(item.date, '2026/08/11');
    const stored = () => runtime.db.prepare('SELECT * FROM timeline WHERE id=?').get(item.id);
    assert.equal(stored().date, '2026/08/11');
    for (const [date, expected] of [['2026-08-12', '2026/08/12'], ['2024/02/29', '2024/02/29'], ['20260811', '2026/08/11']]) {
        const response = await request(`/timeline/${item.id}`, 'PUT', { date });
        assert.equal(response.status, 200); assert.equal((await response.json()).date, expected); assert.equal(stored().date, expected);
    }
    for (const body of [{}, { date: '' }, { date: '   ' }, { date: null }]) {
        const response = await request(`/timeline/${item.id}`, 'PUT', body);
        assert.equal(response.status, 200); assert.equal((await response.json()).date, '2026/08/11');
    }
    runtime.db.prepare("INSERT INTO timeline (id,date,title,category,href) VALUES ('legacy-compact','20260810','Legacy','school',NULL)").run();
    const legacy = await request('/timeline/legacy-compact', 'PUT', { title: 'Edited legacy' });
    assert.equal(legacy.status, 200); assert.equal((await legacy.json()).date, '2026/08/10');
    const before = stored();
    for (const invalid of ['20260230', '20260229', '2026', '2026/08', '2026081', '20261301', 20260811, [], {}]) {
        const post = await request('/timeline', 'POST', { date: invalid, title: 'Invalid', category: 'school' });
        assert.equal(post.status, 400, String(invalid));
        const put = await request(`/timeline/${item.id}`, 'PUT', { date: invalid, title: 'Must not save' });
        assert.equal(put.status, 400, String(invalid)); assert.deepEqual(stored(), before);
    }
    assert.equal((await request('/timeline', 'POST', { date: '', title: 'Empty', category: 'school' })).status, 400);
    assert.equal(runtime.db.prepare('SELECT count(*) AS count FROM timeline').get().count, originalCount + 2);
});
