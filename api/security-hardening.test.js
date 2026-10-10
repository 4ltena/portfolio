'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');

const available = (() => {
    try { require.resolve('express'); require.resolve('better-sqlite3'); return true; }
    catch { return false; }
})();

test('new installations reject a missing admin password', { skip: !available }, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'portfolio-admin-init-'));
    try {
        const result = spawnSync(process.execPath, ['-e', "require('./server')"], {
            cwd: __dirname,
            env: { ...process.env, PORTFOLIO_ROOT: root, PORTFOLIO_DATA_DIR: path.join(root, 'data'),
                PORTFOLIO_NOTES_OUT_DIR: path.join(root, 'notes'), PORTFOLIO_IMG_DIR: path.join(root, 'img'), ADMIN_PASSWORD: '' },
            encoding: 'utf8'
        });
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /ADMIN_PASSWORD .*required/);
        assert.equal(fs.existsSync(path.join(root, 'data', 'config.json')), false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('explicit Easter credentials still issue a short-lived Easter token', { skip: !available }, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'portfolio-easter-control-'));
    try {
        const script = `const {app,db}=require('./server'); const listener=app.listen(0,'127.0.0.1',async()=>{
            try { const response=await fetch('http://127.0.0.1:'+listener.address().port+'/auth/login',{
                method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'test-easter',password:'test-easter-pass'})});
                const body=await response.json(); console.log(response.status,body.type); }
            finally { listener.close(()=>db.close()); }
        });`;
        const result = spawnSync(process.execPath, ['-e', script], {
            cwd: __dirname,
            env: { ...process.env, PORTFOLIO_ROOT: root, PORTFOLIO_DATA_DIR: path.join(root, 'data'),
                PORTFOLIO_NOTES_OUT_DIR: path.join(root, 'notes'), PORTFOLIO_IMG_DIR: path.join(root, 'img'),
                ADMIN_PASSWORD: 'test-only-password-123', EASTER_USER: 'test-easter', EASTER_PASS: 'test-easter-pass' },
            encoding: 'utf8', timeout: 10000
        });
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /200 easter/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('proxy login limits, image validation, chat budget, and status preserve their boundaries', { skip: !available }, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'portfolio-security-hardening-'));
    const names = ['PORTFOLIO_ROOT', 'PORTFOLIO_DATA_DIR', 'PORTFOLIO_NOTES_OUT_DIR', 'PORTFOLIO_IMG_DIR',
        'ADMIN_PASSWORD', 'EASTER_PASS', 'GEMINI_API_KEY'];
    const old = Object.fromEntries(names.map(name => [name, process.env[name]]));
    Object.assign(process.env, {
        PORTFOLIO_ROOT: root, PORTFOLIO_DATA_DIR: path.join(root, 'data'),
        PORTFOLIO_NOTES_OUT_DIR: path.join(root, 'notes'), PORTFOLIO_IMG_DIR: path.join(root, 'img'),
        ADMIN_PASSWORD: 'test-only-password-123', EASTER_PASS: '', GEMINI_API_KEY: 'test-key'
    });
    const jwt = require('jsonwebtoken');
    const osModule = require('node:os');
    const tls = require('node:tls');
    const https = require('node:https');
    const originalTls = tls.connect;
    const originalRequest = https.request;
    const originalUptime = osModule.uptime;
    const serverPath = require.resolve('./server');
    delete require.cache[serverPath];
    const runtime = require('./server');
    const listener = await new Promise(resolve => {
        const instance = runtime.app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    const origin = `http://127.0.0.1:${listener.address().port}`;
    t.after(async () => {
        tls.connect = originalTls;
        https.request = originalRequest;
        osModule.uptime = originalUptime;
        await new Promise(resolve => listener.close(resolve));
        runtime.db.close();
        delete require.cache[serverPath];
        for (const [name, value] of Object.entries(old)) value === undefined ? delete process.env[name] : process.env[name] = value;
        fs.rmSync(root, { recursive: true, force: true });
    });

    const login = (ip, password) => fetch(`${origin}/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
        body: JSON.stringify({ username: 'admin', password })
    });
    assert.equal((await login('203.0.113.1', 'iroha')).status, 401, 'default Easter credential is disabled');
    for (let i = 0; i < 10; i++) await login('203.0.113.1', 'wrong');
    assert.equal((await login('203.0.113.1', 'test-only-password-123')).status, 429);
    const adminResponse = await login('203.0.113.2', 'test-only-password-123');
    assert.equal(adminResponse.status, 200, 'another proxied client can still sign in');
    const adminToken = (await adminResponse.json()).token;

    async function upload(name, bytes) {
        const body = new FormData();
        body.append('file', new Blob([bytes]), name);
        return fetch(`${origin}/images`, { method: 'POST', headers: { Authorization: `Bearer ${adminToken}` }, body });
    }
    const img = path.join(root, 'img');
    fs.writeFileSync(path.join(img, 'safe.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    assert.equal((await upload('unsafe.svg', '<svg onload="alert(1)"/>')).status, 400);
    assert.equal((await upload('unsafe.png', '<svg onload="alert(1)"/>')).status, 400);
    assert.equal(fs.existsSync(path.join(img, 'unsafe.png')), false);
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/xXcAAAAASUVORK5CYII=', 'base64');
    assert.equal((await upload('safe.png', png)).status, 201);
    assert.equal((await upload('safe.png', '<svg onload="alert(1)"/>')).status, 400);
    assert(fs.readFileSync(path.join(img, 'safe.png')).equals(png), 'invalid replacement preserves the existing image');
    assert.equal((await fetch(`${origin}/images/safe.png`, {
        method: 'PUT', headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'unsafe.svg' })
    })).status, 400);
    const images = await (await fetch(`${origin}/images`, { headers: { Authorization: `Bearer ${adminToken}` } })).json();
    assert(images.some(image => image.name === 'safe.svg'), 'existing trusted SVG assets stay visible');

    let tlsChecks = 0;
    osModule.uptime = () => 3600;
    tls.connect = options => {
        assert.notEqual(options.rejectUnauthorized, false, 'TLS chain and hostname verification stay enabled');
        tlsChecks++;
        const socket = new EventEmitter();
        socket.setTimeout = () => socket;
        socket.destroy = () => socket;
        socket.getPeerCertificate = () => ({ valid_to: 'Dec 31 23:59:59 2099 GMT' });
        setTimeout(() => socket.emit('secureConnect'), 150);
        return socket;
    };
    const statusRequests = [fetch(`${origin}/status`), fetch(`${origin}/status`), fetch(`${origin}/status`)];
    let statusSettled = false;
    statusRequests[0].then(() => { statusSettled = true; });
    const verify = await fetch(`${origin}/auth/verify`, { headers: { Authorization: `Bearer ${adminToken}` } });
    assert.equal(verify.status, 200, 'status refresh does not block another API request');
    assert.equal(statusSettled, false, 'unrelated API request finishes before the external TLS check');
    const statuses = await Promise.all(statusRequests);
    assert(statuses.every(response => response.status === 200), `status codes: ${statuses.map(response => response.status).join(',')}`);
    assert.equal(tlsChecks, 1, 'concurrent status requests share one TLS check');
    assert.equal((await statuses[0].json()).tls, 'valid');

    let upstreamCalls = 0;
    https.request = (options, callback) => {
        upstreamCalls++;
        const request = new EventEmitter();
        request.setTimeout = () => request;
        request.write = () => {};
        request.end = () => queueMicrotask(() => {
            const response = new EventEmitter();
            response.statusCode = 200;
            response.destroy = () => response;
            callback(response);
            const payload = options.path.includes(':generateContent')
                ? { candidates: [{ content: { parts: [{ text: 'hello' }] } }] }
                : { models: [{ name: 'models/test', supportedGenerationMethods: ['generateContent'] }] };
            response.emit('data', Buffer.from(JSON.stringify(payload)));
            response.emit('end');
        });
        return request;
    };
    const fushi = jwt.sign({ fushi: true }, runtime.config.jwtSecret, { expiresIn: '5m' });
    const chat = () => fetch(`${origin}/fushi/chat`, {
        method: 'POST', headers: { Authorization: `Bearer ${fushi}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: 'hello', systemPrompt: 'reply briefly' })
    });
    for (let i = 0; i < 50; i++) assert.equal((await chat()).status, 200);
    assert.equal((await chat()).status, 429);
    assert.equal(upstreamCalls, 100, 'rejected call does not reach the external API');
});
