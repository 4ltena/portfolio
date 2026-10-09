import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createFixture } from '../../mcp/fixtures.mjs';
import { openLocalPublicService } from '../../mcp/runtime.mjs';

const require = createRequire(new URL('../../mcp/package.json', import.meta.url));
const { Client } = await import(require.resolve('@modelcontextprotocol/client'));
const { StdioClientTransport } = await import(require.resolve('@modelcontextprotocol/client/stdio'));
const repo = fileURLToPath(new URL('../../../', import.meta.url));
const binary = process.env.PORTFOLIO_MCP_BINARY || '/private/tmp/portfolio-mcp';
const stable = value => {
    const result = structuredClone(value);
    if (result && typeof result === 'object') delete result.generated_at;
    return result;
};
const hash = filename => crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
async function connect(t, root, dbPath, modern = true) {
    const client = new Client({ name: 'native-contract-check', version: '1.0.0' }, modern ?
        { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {});
    const transport = new StdioClientTransport({ command: binary, args: ['--root', root, '--db', dbPath, '--transport', 'stdio'], stderr: 'pipe' });
    t.after(() => client.close());
    await client.connect(transport);
    return client;
}
function enhancedFixture(t) {
    const f = createFixture(t);
    const works = fs.readFileSync(path.join(f.root, 'myworks.html'), 'utf8');
    fs.writeFileSync(path.join(f.root, 'myworks.html'), `<div class="page-tile-container">${works}</div>`);
    fs.writeFileSync(path.join(f.root, 'index.html'), '<div class="hero-foot"><span>INFRASTRUCTURE</span><span>DESIGN</span></div><section id="profile"><span class="brand">Altena</span><p class="philosophy">公開プロフィール &amp; Design</p><div class="bio"><p>第一行。<br>第二行。</p></div><nav class="profile-social"><a href="https://github.com/4ltena">GitHub</a><a href="mailto:contact@altena.me">Email</a></nav></section>');
    const body = '<h2>章 &amp; Linux</h2><p><strong>強調</strong>と<a href="../other.html">リンク</a><br>次行</p><ul><li>一</li><li>二</li></ul><pre><code>const x = `a`;\n  ```\n  x &lt; 3;</code></pre><table><tr><th>キー</th><th>値</th></tr><tr><td>A|B</td><td>1</td></tr></table><script>ACTIVE_SECRET</script><img src="image.png" alt="図">';
    f.writer.prepare('UPDATE articles SET content=? WHERE id=?').run(body, 'public');
    const insert = f.writer.prepare('INSERT INTO articles VALUES (?,?,?,?,?,?,?,?,?,?,?)');
    for (const id of ['公開', 'public\0secret']) insert.run(id, 'INVALID_ID_SECRET', '2026/10/09', '[]', '', 'INVALID_ID_BODY_SECRET', 1000, 4000, 3000, 'public', 88);
    for (const filename of ['index.html', 'myworks.html', 'terminal/profile.txt', 'works/public-work/index.html']) {
        fs.utimesSync(path.join(f.root, filename), new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));
    }
    return f;
}

for (const modern of [true, false]) test(`Go stdio discovery and JS fixture parity (${modern ? 'modern' : 'legacy'})`, async t => {
    const f = enhancedFixture(t), before = hash(f.dbPath);
    const client = await connect(t, f.root, f.dbPath, modern);
    const tools = await client.listTools(); assert.equal(tools.tools.length, 3);
    assert.equal((await client.listResources()).resources.length, 6);
    assert.equal((await client.listResourceTemplates()).resourceTemplates.length, 2);
    for (const kind of ['works', 'notes', 'skills', 'timeline']) {
        const args = { kind, limit: 1 };
        const expected = f.service.list(args);
        const actual = await client.callTool({ name: 'list_public_content', arguments: args });
        assert.equal(Boolean(actual.isError), false, JSON.stringify(actual));
        assert.deepEqual(stable(actual.structuredContent), stable(expected), kind);
        if (expected.next_cursor) {
            const nextArgs = { ...args, cursor: expected.next_cursor };
            const page = await client.callTool({ name: 'list_public_content', arguments: nextArgs });
            assert.deepEqual(stable(page.structuredContent), stable(f.service.list(nextArgs)), `${kind} cross-runtime cursor`);
        }
    }
    for (const args of [{ kind: 'profile' }, { kind: 'works', id: 'public-work' }, { kind: 'notes', id: 'public' }]) {
        const result = await client.callTool({ name: 'get_public_content', arguments: args });
        assert.deepEqual(stable(result.structuredContent), stable(f.service.get(args)), args.kind);
    }
    for (const args of [{ kind: 'notes', q: ' ＬＩＮＵＸ ' }, { kind: 'works', q: 'Linux' }, { kind: 'notes', q: 'does-not-exist' },
        { kind: 'notes', q: 'ΟΣ' }, { kind: 'notes', q: '\u0130' }, { kind: 'notes', q: '\ufeffLinux\ufeff' }]) {
        const result = await client.callTool({ name: 'search_public_content', arguments: args });
        assert.deepEqual(stable(result.structuredContent), stable(f.service.list(args)), JSON.stringify(args));
    }
    for (const kind of ['index', 'profile', 'works', 'notes', 'skills', 'timeline']) {
        const result = await client.readResource({ uri: `portfolio://altena/${kind}` });
        assert.equal(result.contents[0].text, f.service.markdown({ kind }), kind);
    }
    for (const [kind, id] of [['notes', 'public'], ['works', 'public-work']]) {
        assert.equal((await client.readResource({ uri: `portfolio://altena/${kind}/${id}` })).contents[0].text, f.service.markdown({ kind, id }));
    }
    for (const id of ['draft', 'unlisted', 'missing']) {
        const result = await client.callTool({ name: 'get_public_content', arguments: { kind: 'notes', id } });
        assert.equal(result.isError, true);
        assert.equal(result.structuredContent.error.code, 'not_found');
    }
    for (const uri of ['portfolio://altena/notes/../public', 'portfolio://altena/notes/%70ublic', 'portfolio://altena/notes/public?x=1', 'portfolio://altena/profile/altena']) {
        await assert.rejects(client.readResource({ uri }));
    }
    const page = await client.callTool({ name: 'list_public_content', arguments: { kind: 'notes', limit: 1 } });
    const cursor = page.structuredContent.next_cursor;
    f.writer.prepare('UPDATE articles SET content=? WHERE id=?').run('PRIVATE_EDIT_SECRET', 'draft');
    assert.equal(Boolean((await client.callTool({ name: 'list_public_content', arguments: { kind: 'notes', limit: 1, cursor } })).isError), false);
    f.writer.prepare("UPDATE articles SET visibility='draft' WHERE id='public'").run();
    const expired = await client.callTool({ name: 'list_public_content', arguments: { kind: 'notes', limit: 1, cursor } });
    assert.equal(expired.structuredContent.error.code, 'cursor_expired');
    assert.notEqual(hash(f.dbPath), before); // Only the fixture writer above may modify this DB.
});

test('Go readonly real portfolio parity and unchanged DB', async t => {
    const dbPath = path.join(repo, 'api/data/portfolio.db');
    const before = hash(dbPath), source = openLocalPublicService({ root: repo, dbPath });
    t.after(() => source.close());
    const client = await connect(t, repo, dbPath);
    for (const kind of ['works', 'notes', 'skills', 'timeline']) {
        const result = await client.callTool({ name: 'list_public_content', arguments: { kind } });
        assert.deepEqual(stable(result.structuredContent), stable(source.service.list({ kind })), kind);
    }
    const profile = await client.callTool({ name: 'get_public_content', arguments: { kind: 'profile' } });
    assert.deepEqual(stable(profile.structuredContent), stable(source.service.get({ kind: 'profile' })));
    for (const kind of ['index', 'profile', 'works', 'notes', 'skills', 'timeline']) {
        assert.equal((await client.readResource({ uri: `portfolio://altena/${kind}` })).contents[0].text, source.service.markdown({ kind }), kind);
    }
    assert.equal(hash(dbPath), before);
});
