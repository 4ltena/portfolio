import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createFixture } from './fixtures.mjs';
import { startLocalMcpHttp } from './http.mjs';

async function runtimeFor(t, service, options = {}) {
    const runtime = await startLocalMcpHttp({ service, port: 0, ...options });
    t.after(() => runtime.close());
    return runtime;
}
function post(url, body, headers = {}) {
    // fetch can rewrite Host; use a real Node request to test hostile wire headers.
    return new Promise((resolve, reject) => {
        const request = http.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers } }, response => {
            let value = ''; response.setEncoding('utf8'); response.on('data', chunk => { value += chunk; });
            response.on('end', () => resolve({ status: response.statusCode, headers: { get: name => response.headers[name] ?? null }, text: async () => value, json: async () => JSON.parse(value) }));
        });
        request.on('error', reject); request.end(JSON.stringify(body));
    });
}
const list = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_public_content', arguments: { kind: 'notes' } } };
const resource = { jsonrpc: '2.0', id: 2, method: 'resources/read', params: { uri: 'portfolio://altena/notes/public' } };

test('strict Host/Origin and body size reject before any public reader; forwarded hosts confer no authority', async t => {
    const fixture = createFixture(t); let reads = 0;
    const service = Object.fromEntries(['list', 'get', 'markdown'].map(method => [method, args => { reads++; return fixture.service[method](args); }]));
    const runtime = await runtimeFor(t, service, { allowedOrigins: ['http://localhost:4321'] });
    const port = runtime.server.address().port;
    const badHeaders = [{ Host: 'evil.example' }, { Host: `127.0.0.1:${port + 1}` }, { Host: `127.0.0.1:${port}@evil.example` },
        { Origin: 'null' }, { Origin: 'http://evil.example' }, { Origin: 'https://localhost:4321' }, { Origin: 'http://localhost:4322' },
        { Origin: 'http://localhost:4321/' }, { Origin: 'http://user@localhost:4321' }, { Host: 'evil.example', 'X-Forwarded-Host': `127.0.0.1:${port}` }];
    for (const headers of badHeaders) {
        const response = await post(runtime.url, list, headers); assert.equal(response.status, 403, JSON.stringify(headers));
        assert.equal(response.headers.get('cache-control'), 'no-store');
    }
    const huge = await post(runtime.url, { ...list, padding: 'x'.repeat(65536) }); assert.equal(huge.status, 413);
    assert.equal(reads, 0);
    for (const headers of [{}, { Origin: 'http://localhost:4321' }, { 'X-Forwarded-Host': 'evil.example' }]) {
        const response = await post(runtime.url, list, headers); assert.equal(response.status, 200);
        assert.equal(response.headers.get('cache-control'), 'no-store'); await response.text();
    }
    assert.equal(reads, 3);
});

test('SDK validates modern protocol/Mcp-Method/Mcp-Name headers against the body', async t => {
    const fixture = createFixture(t); let reads = 0;
    const service = { ...fixture.service, list(args) { reads++; return fixture.service.list(args); } };
    const runtime = await runtimeFor(t, service);
    const captured = [];
    const client = new Client({ name: 'http-header-tests', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
    const transport = new StreamableHTTPClientTransport(new URL(runtime.url), { fetch: async (input, init) => {
        const request = new Request(input, init); captured.push({ body: await request.clone().text(), headers: Object.fromEntries(request.headers) });
        return fetch(request);
    } });
    t.after(() => client.close()); await client.connect(transport);
    await client.callTool({ name: 'list_public_content', arguments: { kind: 'notes' } });
    const sample = captured.find(entry => JSON.parse(entry.body || '{}').method === 'tools/call'); assert.ok(sample);
    const count = reads;
    for (const changes of [{ 'mcp-method': 'resources/read' }, { 'mcp-name': 'unknown' }, { 'mcp-protocol-version': '2025-06-18' }, { 'mcp-protocol-version': '2099-01-01' }]) {
        const response = await fetch(runtime.url, { method: 'POST', headers: { ...sample.headers, ...changes }, body: sample.body });
        assert.ok(response.status >= 400); await response.text();
    }
    assert.equal(reads, count);
    assert.equal((await fetch(runtime.url, { headers: { 'MCP-Protocol-Version': '2026-07-28' } })).status, 405);
    assert.equal((await fetch(runtime.url)).status, 405);
    assert.equal((await fetch(runtime.url, { method: 'DELETE' })).status, 405);
});

test('HTTP request and per-category rate limits stop reader calls and recover next window', async t => {
    const fixture = createFixture(t); let now = 0; let reads = 0;
    const service = Object.fromEntries(['list', 'get', 'markdown'].map(method => [method, args => { reads++; return fixture.service[method](args); }]));
    const runtime = await runtimeFor(t, service, { now: () => now, requestsPerWindow: 10, toolsPerWindow: 1, resourcesPerWindow: 1 });
    assert.equal((await post(runtime.url, list)).status, 200); assert.equal(reads, 1);
    const deniedTool = await post(runtime.url, list); assert.match(await deniedTool.text(), /rate_limited/); assert.equal(reads, 1);
    assert.equal((await post(runtime.url, resource)).status, 200); assert.equal(reads, 2);
    const deniedResource = await post(runtime.url, resource); assert.match(await deniedResource.text(), /Rate limited/); assert.equal(reads, 2);
    now = 60001;
    assert.equal((await post(runtime.url, list)).status, 200); assert.equal(reads, 3);
    const limited = await runtimeFor(t, fixture.service, { requestsPerWindow: 1 });
    await post(limited.url, { jsonrpc: '2.0', id: 9, method: 'tools/list' });
    const response = await post(limited.url, list); assert.equal(response.status, 429);
    assert.equal((await response.json()).error.code, 'rate_limited');
});

test('concurrency, response and elapsed time budgets return bounded errors', async t => {
    const fixture = createFixture(t); let release;
    const pending = new Promise(resolve => { release = resolve; });
    let called;
    const began = new Promise(resolve => { called = resolve; });
    const delayed = { ...fixture.service, async list(args) { called(); await pending; return fixture.service.list(args); } };
    const concurrency = await runtimeFor(t, delayed, { maxConcurrent: 1 });
    const first = post(concurrency.url, list); await began;
    const rejected = await post(concurrency.url, list); assert.equal(rejected.status, 429);
    release(); assert.equal((await first).status, 200);
    const bounded = await runtimeFor(t, fixture.service, { maxResponseBytes: 100 });
    const tooLarge = await post(bounded.url, list); assert.equal(tooLarge.status, 503);
    assert.deepEqual(await tooLarge.json(), { schema_version: 1, error: { code: 'source_unavailable', message: 'Source unavailable' } });
    const slow = { ...fixture.service, async list(args) { await new Promise(resolve => setTimeout(resolve, 80)); return fixture.service.list(args); } };
    const timed = await runtimeFor(t, slow, { requestTimeoutMs: 20 });
    const timedOut = await post(timed.url, list); assert.equal(timedOut.status, 503);
    assert.equal((await timedOut.json()).error.code, 'source_unavailable');
});

test('local HTTP configuration refuses non-loopback or ambiguous Origin allowlists', async t => {
    const fixture = createFixture(t);
    for (const origin of ['null', '*', 'http://*', 'https://altena.me', 'http://localhost', 'http://localhost:4321/', 'http://127.0.0.1:80']) {
        await assert.rejects(startLocalMcpHttp({ service: fixture.service, port: 0, allowedOrigins: [origin] }));
    }
});
