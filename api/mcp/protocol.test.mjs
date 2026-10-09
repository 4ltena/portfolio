import test from 'node:test';
import assert from 'node:assert/strict';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createFixture } from './fixtures.mjs';
import { startLocalMcpHttp } from './http.mjs';
import { parsePublicResourceUri } from './server.mjs';

const hidden = /SECRET|share_version|visibility|share_token/;
function clientFor(mode) { return new Client({ name: 'portfolio-protocol-tests', version: '1.0.0' }, mode === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {}); }
async function connectHttp(t, service, mode = 'modern', options = {}) {
    const runtime = await startLocalMcpHttp({ service, port: 0, ...options });
    const client = clientFor(mode);
    const transport = new StreamableHTTPClientTransport(new URL(runtime.url));
    t.after(async () => { await client.close(); await runtime.close(); });
    await client.connect(transport, { timeout: 5000 });
    return { runtime, client };
}
async function contract(client, service) {
    assert.equal(client.getServerVersion().name, 'altena-portfolio-public');
    const capabilities = client.getServerCapabilities();
    assert.deepEqual(Object.keys(capabilities).sort(), ['resources', 'tools']);
    assert.equal(capabilities.resources.subscribe, undefined);
    assert.equal(capabilities.tools.listChanged, false);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(tool => tool.name), ['list_public_content', 'search_public_content', 'get_public_content']);
    for (const tool of tools) assert.deepEqual(tool.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    for (const kind of ['works', 'notes', 'skills', 'timeline']) {
        const result = await client.callTool({ name: 'list_public_content', arguments: { kind } });
        assert.equal(result.isError, false);
        assert.deepEqual(result.structuredContent, service.list({ kind }));
        assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
        assert.doesNotMatch(JSON.stringify(result), hidden);
        assert.ok(result.structuredContent.items.every(item => !Object.hasOwn(item, 'content_markdown')));
    }
    for (const [kind, id] of [['profile', undefined], ['works', 'public-work'], ['notes', 'public']]) {
        const args = id ? { kind, id } : { kind };
        const result = await client.callTool({ name: 'get_public_content', arguments: args });
        assert.equal(result.isError, false);
        assert.deepEqual(result.structuredContent, service.get(args));
        const link = result.content.find(content => content.type === 'resource_link');
        assert.ok(link);
        const body = await client.readResource({ uri: link.uri });
        assert.equal(body.contents[0].text, service.markdown(args));
        assert.doesNotMatch(JSON.stringify(body), hidden);
    }
    const resources = await client.listResources();
    assert.equal(resources.resources.length, 6);
    for (const item of resources.resources) {
        assert.equal(item.mimeType, 'text/markdown');
        assert.ok(item.title && item.description);
        const result = await client.readResource({ uri: item.uri });
        assert.equal(result.contents[0].text, service.markdown({ kind: item.name }));
    }
    assert.equal((await client.listResourceTemplates()).resourceTemplates.length, 2);
    for (const id of ['draft', 'unlisted', 'missing']) {
        const result = await client.callTool({ name: 'get_public_content', arguments: { kind: 'notes', id } });
        assert.equal(result.isError, true);
        assert.deepEqual(result.structuredContent, { schema_version: 1, error: { code: 'not_found', message: 'Not found' } });
        await assert.rejects(client.readResource({ uri: `portfolio://altena/notes/${id}` }), error => error.code === -32602);
    }
    const normalized = await client.callTool({ name: 'search_public_content', arguments: { kind: 'notes', q: 'ＬＩＮＵＸ' } });
    assert.equal(normalized.structuredContent.count, 3);
    const empty = await client.callTool({ name: 'search_public_content', arguments: { kind: 'notes', q: 'absent-term' } });
    assert.equal(empty.isError, false); assert.equal(empty.structuredContent.count, 0);
    const badCursor = await client.callTool({ name: 'list_public_content', arguments: { kind: 'notes', cursor: 'garbage' } });
    assert.equal(badCursor.isError, true); assert.equal(badCursor.structuredContent.error.code, 'invalid_cursor');
    const first = await client.callTool({ name: 'list_public_content', arguments: { kind: 'notes', limit: 1 } });
    const second = await client.callTool({ name: 'list_public_content', arguments: { kind: 'notes', limit: 1, cursor: first.structuredContent.next_cursor } });
    assert.equal(second.structuredContent.items[0].id, 'second');
    await assert.rejects(client.callTool({ name: 'unknown_public_tool', arguments: {} }), error => error.code < 0);
}

for (const mode of ['modern', 'legacy']) test(`real HTTP SDK client ${mode} shares JSON/Markdown and privacy contracts`, async t => {
    const fixture = createFixture(t);
    const before = fixture.hash();
    const { client, runtime } = await connectHttp(t, fixture.service, mode, { toolsPerWindow: 200, resourcesPerWindow: 200 });
    assert.equal(runtime.server.address().address, '127.0.0.1');
    await contract(client, fixture.service);
    assert.equal(fixture.hash(), before);
});

for (const mode of ['modern', 'legacy']) test(`real stdio SDK client ${mode} lists, calls and reads local read-only source`, async t => {
    const fixture = createFixture(t);
    const before = fixture.hash();
    const client = clientFor(mode);
    const transport = new StdioClientTransport({ command: process.execPath, args: [new URL('./stdio.mjs', import.meta.url).pathname],
        cwd: new URL('./', import.meta.url).pathname, env: { PORTFOLIO_MCP_ROOT: fixture.root, PORTFOLIO_MCP_DB: fixture.dbPath }, stderr: 'pipe' });
    let stderr = ''; transport.stderr.on('data', chunk => { stderr += chunk; });
    t.after(() => client.close());
    await client.connect(transport, { timeout: 5000 });
    const listed = await client.listTools(); assert.equal(listed.tools.length, 3);
    const result = await client.callTool({ name: 'get_public_content', arguments: { kind: 'notes', id: 'public' } });
    assert.equal(result.isError, false); assert.deepEqual(result.structuredContent.item, fixture.service.get({ kind: 'notes', id: 'public' }).item);
    const resource = await client.readResource({ uri: 'portfolio://altena/notes/public' });
    assert.equal(resource.contents[0].text, fixture.service.markdown({ kind: 'notes', id: 'public' }));
    const hiddenResult = await client.callTool({ name: 'get_public_content', arguments: { kind: 'notes', id: 'draft' } });
    assert.equal(hiddenResult.structuredContent.error.code, 'not_found');
    assert.doesNotMatch(JSON.stringify([result, resource, hiddenResult]) + stderr, hidden);
    const pid = transport.pid; await client.close();
    assert.throws(() => process.kill(pid, 0), /ESRCH/);
    assert.equal(fixture.hash(), before);
});

test('revocation changes list/search/count, expires old cursors and denies known resource URI', async t => {
    const fixture = createFixture(t);
    const { client } = await connectHttp(t, fixture.service);
    const first = await client.callTool({ name: 'list_public_content', arguments: { kind: 'notes', limit: 1 } });
    assert.equal(first.structuredContent.items[0].id, 'public');
    fixture.writer.prepare("UPDATE articles SET visibility='draft' WHERE id='public'").run();
    const after = await client.callTool({ name: 'search_public_content', arguments: { kind: 'notes', q: 'Linux' } });
    assert.equal(after.structuredContent.total_count, 2);
    assert.ok(after.structuredContent.items.every(item => item.id !== 'public'));
    const expired = await client.callTool({ name: 'list_public_content', arguments: { kind: 'notes', limit: 1, cursor: first.structuredContent.next_cursor } });
    assert.equal(expired.structuredContent.error.code, 'cursor_expired');
    const direct = await client.callTool({ name: 'get_public_content', arguments: { kind: 'notes', id: 'public' } });
    assert.equal(direct.structuredContent.error.code, 'not_found');
    await assert.rejects(client.readResource({ uri: 'portfolio://altena/notes/public' }), error => error.code === -32602);
});

const malformedUris = ['https://altena.me/portfolio/notes/public.md', 'portfolio://evil/notes/public', 'portfolio://altena@evil/profile',
    'portfolio://user@altena/profile', 'portfolio://altena:80/profile', 'portfolio://altena/profile?x=1', 'portfolio://altena/profile#x',
    'portfolio://altena/notes/../profile', 'portfolio://altena/notes/%70ublic', 'portfolio://altena/notes/%252f', 'portfolio://altena/notes/a/b',
    'portfolio://altena/profile/altena', 'portfolio://altena/unknown', 'portfolio://altena/notes/' + 'x'.repeat(129), 'PORTFOLIO://altena/profile'];
test('raw resource URI allowlist rejects normalized traversal and encoded aliases before reader', async t => {
    const fixture = createFixture(t); let reads = 0;
    const service = { ...fixture.service, markdown(args) { reads++; return fixture.service.markdown(args); } };
    const { client } = await connectHttp(t, service);
    for (const uri of malformedUris) {
        assert.throws(() => parsePublicResourceUri(uri));
        await assert.rejects(client.readResource({ uri }), error => error.code === -32602);
    }
    assert.equal(reads, 0);
});

test('tool inputs reject invalid arguments and enforce Unicode and byte boundaries', async t => {
    const fixture = createFixture(t);
    const { client } = await connectHttp(t, fixture.service);
    const invalid = [{ name: 'list_public_content', arguments: { kind: 'notes', q: 'unexpected' } },
        ...[-1, 0, 51, 1.5].map(limit => ({ name: 'list_public_content', arguments: { kind: 'notes', limit } })),
        { name: 'list_public_content', arguments: { kind: 'unknown' } },
        { name: 'get_public_content', arguments: { kind: 'profile', id: 'altena' } },
        { name: 'get_public_content', arguments: { kind: 'notes' } },
        { name: 'get_public_content', arguments: { kind: 'notes', id: '../public' } },
        ...['😀'.repeat(121), ['Linux'], 'bad\nquery'].map(q => ({ name: 'search_public_content', arguments: { kind: 'notes', q } })),
        { name: 'list_public_content', arguments: { kind: 'notes', cursor: '界'.repeat(683) } }];
    for (const args of invalid) {
        const result = await client.callTool(args);
        assert.equal(result.isError, true); assert.doesNotMatch(JSON.stringify(result), hidden);
    }
    const valid = await client.callTool({ name: 'search_public_content', arguments: { kind: 'notes', q: '😀'.repeat(120) } });
    assert.equal(valid.isError, false); assert.equal(valid.structuredContent.count, 0);
});
