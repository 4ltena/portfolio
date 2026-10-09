import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import { createFixture } from './fixtures.mjs';
import { openLocalPublicService } from './runtime.mjs';
import { startLocalMcpStdio } from './stdio.mjs';

test('runtime SQLite connection is read-only and missing DB never creates a file', t => {
    const fixture = createFixture(t); const before = fixture.hash();
    assert.equal(fixture.source.db.readonly, true);
    assert.throws(() => fixture.source.db.prepare("UPDATE articles SET visibility='draft'").run(), /readonly/);
    assert.equal(fixture.hash(), before);
    const missing = path.join(fixture.root, 'missing.db');
    assert.throws(() => openLocalPublicService({ root: fixture.root, dbPath: missing })); assert.equal(fs.existsSync(missing), false);
});

for (const ending of ['EOF', 'SIGTERM']) test(`stdio stdout is JSON-RPC only and child exits on ${ending}`, async t => {
    const fixture = createFixture(t); const before = fixture.hash();
    const child = spawn(process.execPath, [new URL('./stdio.mjs', import.meta.url).pathname], {
        env: { PORTFOLIO_MCP_ROOT: fixture.root, PORTFOLIO_MCP_DB: fixture.dbPath }, stdio: ['pipe', 'pipe', 'pipe']
    });
    t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    const request = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw-stdio-test', version: '1' } } };
    child.stdin.write(JSON.stringify(request) + '\n');
    await once(child.stdout, 'data');
    const exited = once(child, 'exit');
    if (ending === 'EOF') child.stdin.end(); else child.kill('SIGTERM');
    const [code, signal] = await exited; assert.equal(code, 0); assert.equal(signal, null);
    const lines = stdout.trim().split('\n'); assert.ok(lines.length >= 1);
    for (const line of lines) { const parsed = JSON.parse(line); assert.equal(parsed.jsonrpc, '2.0'); assert.equal(parsed.id, 1); }
    assert.doesNotMatch(stderr, /SECRET|SQL|\/Users\//); assert.equal(fixture.hash(), before);
});

test('stdio EOF and explicit close release an unopened source exactly once', async () => {
    const stdin = new PassThrough(); const stdout = new PassThrough(); let closed = 0;
    const handle = startLocalMcpStdio({ service: { list() {}, get() {}, markdown() {} }, stdin, stdout, closeSource: () => { closed++; } });
    stdin.end(); await new Promise(resolve => setImmediate(resolve)); await handle.close(); assert.equal(closed, 1);
});
