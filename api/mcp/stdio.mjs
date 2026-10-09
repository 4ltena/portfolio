import { pathToFileURL } from 'node:url';
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createMcpServer } from './server.mjs';
import { openLocalPublicService, localSourceOptions } from './runtime.mjs';

export function startLocalMcpStdio({ service, closeSource = () => {}, stdin = process.stdin, stdout = process.stdout } = {}) {
    const transport = new StdioServerTransport(stdin, stdout, { maxBufferSize: 65536 });
    let closed = false;
    const release = () => { if (!closed) { closed = true; closeSource(); } };
    const handle = serveStdio(() => {
        const server = createMcpServer({ service });
        server.server.onclose = release;
        return server;
    }, { transport, legacy: 'serve', onerror: () => console.error('MCP protocol request failed') });
    // EOF before the first request never constructs a server instance.
    stdin.once('end', release);
    const close = async () => { try { await handle.close(); } finally { release(); } };
    return { close };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    let source;
    try {
        source = openLocalPublicService(localSourceOptions());
        const handle = startLocalMcpStdio({ service: source.service, closeSource: source.close });
        for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void handle.close().finally(() => process.exit(0)); });
    } catch {
        source?.close();
        console.error('Public MCP source could not be opened');
        process.exitCode = 1;
    }
}
