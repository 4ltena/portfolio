// Local acceptance observation, not a production load test or peak-RSS benchmark.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import crypto from 'node:crypto';

const require = createRequire(new URL('../../mcp/package.json', import.meta.url));
const { Client } = await import(require.resolve('@modelcontextprotocol/client'));
const { StdioClientTransport } = await import(require.resolve('@modelcontextprotocol/client/stdio'));
const root = fileURLToPath(new URL('../../../', import.meta.url));
const db = root + '/api/data/portfolio.db';
const hash = () => crypto.createHash('sha256').update(fs.readFileSync(db)).digest('hex');
const before = hash();
const records = [];
for (const runtime of ['node', 'go']) {
    const transport = new StdioClientTransport(runtime === 'node' ? {
        command: '/opt/homebrew/opt/node@22/bin/node', args: [root + '/api/mcp/stdio.mjs'],
        env: { PORTFOLIO_MCP_ROOT: root, PORTFOLIO_MCP_DB: db }, stderr: 'pipe'
    } : {
        command: process.env.PORTFOLIO_MCP_BINARY || '/private/tmp/portfolio-mcp',
        args: ['--transport', 'stdio', '--root', root, '--db', db], stderr: 'pipe'
    });
    const client = new Client({ name: 'local-footprint-observation', version: '1.0.0' },
        { versionNegotiation: { mode: { pin: '2026-07-28' } } });
    try {
        await client.connect(transport);
        await client.listTools(); // Modern connect is lazy; wait for a real server response before observing idle RSS.
        const rss = () => Number(execFileSync('/bin/ps', ['-p', String(transport.pid), '-o', 'rss='], { encoding: 'utf8' }).trim());
        const idleKiB = rss();
        for (let i = 0; i < 10; i++) {
            const result = await client.callTool({ name: 'list_public_content', arguments: { kind: 'notes' } });
            if (result.isError) throw new Error('Public read failed');
            await client.readResource({ uri: 'portfolio://altena/index' });
        }
        records.push({ runtime, idle_rss_kib: idleKiB, after_10_pairs_rss_kib: rss() });
    } finally { await client.close(); }
}
if (hash() !== before) throw new Error('Readonly DB hash changed');
console.log(JSON.stringify({ platform: process.platform, architecture: process.arch,
    observation: 'stdio tools/list readiness, then 10 notes-list/index-resource pairs; single RSS snapshots, not peak or production values',
    db_unchanged: true, records }, null, 2));
