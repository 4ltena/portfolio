import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const require = createRequire(new URL('../../mcp/package.json', import.meta.url));
const { Client, StreamableHTTPClientTransport } = await import(require.resolve('@modelcontextprotocol/client'));
const root = fileURLToPath(new URL('../../../', import.meta.url));
const binary = process.env.PORTFOLIO_MCP_BINARY || '/private/tmp/portfolio-mcp';
function rawPost(url, headers, body) {
    return new Promise((resolve, reject) => {
        const request = http.request(url, { method: 'POST', headers }, response => {
            response.resume(); response.on('end', () => resolve({ status: response.statusCode, cache: response.headers['cache-control'] }));
        });
        request.on('error', reject); request.end(body);
    });
}
async function server(t) {
    const child = spawn(binary, ['--transport', 'http', '--root', root, '--db', root + '/api/data/portfolio.db', '--port', '0'], { stdio: ['ignore', 'ignore', 'pipe'] });
    t.after(() => new Promise(resolve => {
        if (child.exitCode !== null) return resolve();
        child.once('exit', resolve); child.kill('SIGTERM');
    }));
    return await new Promise((resolve, reject) => {
        let logs = ''; const timer = setTimeout(() => reject(new Error('HTTP startup timeout')), 10_000);
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('exit', () => { clearTimeout(timer); reject(new Error('HTTP server exited before ready')); });
        child.stderr.on('data', data => {
            logs = (logs + data.toString()).slice(-16_384);
            const match = logs.match(/http:\/\/127\.0\.0\.1:\d+\/mcp/);
            if (match) { clearTimeout(timer); resolve(match[0]); }
        });
    });
}
for (const modern of [true, false]) test(`Go HTTP real SDK (${modern ? 'modern' : 'legacy'}) and transport guards`, async t => {
    const url = await server(t), captured = [];
    const client = new Client({ name: 'native-http-check', version: '1.0.0' }, modern ?
        { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {});
    t.after(() => client.close());
    const transport = new StreamableHTTPClientTransport(new URL(url), { fetch: async (input, init) => {
        const request = new Request(input, init);
        captured.push({ body: await request.clone().text(), headers: Object.fromEntries(request.headers) });
        return fetch(request);
    } });
    await client.connect(transport);
    assert.equal((await client.listTools()).tools.length, 3);
    assert.equal((await client.listResources()).resources.length, 6);
    const result = await client.callTool({ name: 'list_public_content', arguments: { kind: 'notes' } });
    assert.equal(Boolean(result.isError), false); assert.ok(result.structuredContent.count >= 0);
    assert.match((await client.readResource({ uri: 'portfolio://altena/index' })).contents[0].text, /Altena/);
    const sample = captured.find(entry => JSON.parse(entry.body || '{}').method === 'tools/call');
    assert.ok(sample);
    for (const headers of [{ ...sample.headers, host: 'evil.example' }, { ...sample.headers, origin: 'https://evil.example' }]) {
        const response = await rawPost(url, headers, sample.body);
        assert.ok(response.status >= 400, JSON.stringify({ status: response.status, host: headers.host, origin: headers.origin }));
        assert.equal(response.cache, 'no-store');
    }
    if (modern) for (const changed of [{ 'mcp-method': 'resources/read' }, { 'mcp-name': 'unknown' }, { 'mcp-protocol-version': '2099-01-01' }]) {
        const response = await fetch(url, { method: 'POST', headers: { ...sample.headers, ...changed }, body: sample.body });
        assert.ok(response.status >= 400); await response.text();
    }
    const oversized = await fetch(url, { method: 'POST', headers: sample.headers, body: ' '.repeat(65_537) });
    assert.ok(oversized.status >= 400); await oversized.text();
});
