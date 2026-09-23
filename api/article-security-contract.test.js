'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dependenciesAvailable = (() => {
    try {
        require.resolve('express');
        require.resolve('jsonwebtoken');
        require.resolve('better-sqlite3');
        return true;
    } catch {
        return false;
    }
})();

test('share links and admin claims enforce the HTTP security boundary', { skip: !dependenciesAvailable }, async t => {
    const jwt = require('jsonwebtoken');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'portfolio-api-security-'));
    const data = path.join(root, 'data');
    const notes = path.join(root, 'notes');
    const img = path.join(root, 'img');
    fs.mkdirSync(data, { recursive: true });
    fs.mkdirSync(notes, { recursive: true });
    fs.mkdirSync(img, { recursive: true });

    const names = ['PORTFOLIO_ROOT', 'PORTFOLIO_DATA_DIR', 'PORTFOLIO_NOTES_OUT_DIR', 'PORTFOLIO_IMG_DIR', 'ADMIN_PASSWORD', 'NODE_ENV'];
    const old = Object.fromEntries(names.map(name => [name, process.env[name]]));
    Object.assign(process.env, {
        PORTFOLIO_ROOT: root,
        PORTFOLIO_DATA_DIR: data,
        PORTFOLIO_NOTES_OUT_DIR: notes,
        PORTFOLIO_IMG_DIR: img,
        ADMIN_PASSWORD: 'test-only-password',
        NODE_ENV: 'test'
    });

    const serverPath = require.resolve('./server');
    delete require.cache[serverPath];
    const runtime = require('./server');
    const listener = await new Promise((resolve, reject) => {
        const instance = runtime.app.listen(0, '127.0.0.1', () => resolve(instance));
        instance.on('error', reject);
    });
    const address = listener.address();
    const origin = `http://127.0.0.1:${address.port}`;
    const adminToken = jwt.sign({ admin: true }, runtime.config.jwtSecret, { expiresIn: '5m' });
    const nonAdminToken = jwt.sign({ easter: true }, runtime.config.jwtSecret, { expiresIn: '5m' });

    t.after(async () => {
        await new Promise(resolve => listener.close(resolve));
        runtime.db.close();
        delete require.cache[serverPath];
        for (const [name, value] of Object.entries(old)) value === undefined ? delete process.env[name] : process.env[name] = value;
        fs.rmSync(root, { recursive: true, force: true });
    });

    async function request(url, { method = 'GET', token, body, share } = {}) {
        const headers = {};
        if (token) headers.Authorization = `Bearer ${token}`;
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        if (share) headers['X-Note-Share'] = share;
        return fetch(`${origin}${url}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    }

    const payload = visibility => ({
        title: 'Shared note', date: '2026/09/22', tags: ['test'], excerpt: 'excerpt', content: '<p>body</p>', visibility
    });
    const createdResponse = await request('/admin/articles', { method: 'POST', token: adminToken, body: payload('unlisted') });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json();

    const publicList = await (await request('/articles')).json();
    assert.equal(publicList.some(article => article.id === created.id), false);
    assert.equal((await request(`/articles/${created.id}`)).status, 404);

    const linkResponse = await request(`/admin/articles/${created.id}/share-link`, { token: adminToken });
    assert.equal(linkResponse.status, 200);
    const firstToken = (await linkResponse.json()).url.split('#')[1];
    const [id, firstSignature] = firstToken.split('.');
    assert.equal(id, created.id);

    const shared = await request(`/shared-articles/${id}`, { share: firstSignature });
    assert.equal(shared.status, 200);
    assert.equal(shared.headers.get('cache-control'), 'private, no-store');
    assert.equal(shared.headers.get('referrer-policy'), 'no-referrer');
    assert.equal((await request(`/shared-articles/${id}`, { share: `${firstSignature}, ${firstSignature}` })).status, 404);
    assert.equal((await request(`/shared-articles/${id}`, { share: 'invalid' })).status, 404);

    const rotatedResponse = await request(`/admin/articles/${id}/share/rotate`, { method: 'POST', token: adminToken });
    assert.equal(rotatedResponse.status, 200);
    const secondSignature = (await rotatedResponse.json()).url.split('#')[1].split('.')[1];
    assert.notEqual(secondSignature, firstSignature);
    assert.equal((await request(`/shared-articles/${id}`, { share: firstSignature })).status, 404);
    assert.equal((await request(`/shared-articles/${id}`, { share: secondSignature })).status, 200);

    assert.equal((await request(`/admin/articles/${id}`, { method: 'PUT', token: adminToken, body: payload('draft') })).status, 200);
    assert.equal((await request(`/shared-articles/${id}`, { share: secondSignature })).status, 404);
    assert.equal((await request(`/admin/articles/${id}`, { method: 'PUT', token: adminToken, body: payload('public') })).status, 200);
    assert.equal((await request(`/shared-articles/${id}`, { share: secondSignature })).status, 404);

    const protectedRequests = [
        ['/admin/articles', { token: nonAdminToken }],
        ['/timeline', { method: 'POST', token: nonAdminToken, body: {} }],
        ['/skills', { method: 'POST', token: nonAdminToken, body: {} }],
        ['/images', { token: nonAdminToken }],
        ['/cert-nodes/example', { method: 'PUT', token: nonAdminToken, body: {} }],
        ['/system/status', { token: nonAdminToken }]
    ];
    for (const [url, options] of protectedRequests) {
        assert.equal((await request(url, options)).status, 403, url);
    }
});
