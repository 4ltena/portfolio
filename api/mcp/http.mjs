import http from 'node:http';
import { pathToFileURL } from 'node:url';
import express from 'express';
import { hostHeaderValidation, originValidation } from '@modelcontextprotocol/express';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import publicService from '../agent-public-service.js';
import { createMcpServer } from './server.mjs';
import { openLocalPublicService, localSourceOptions } from './runtime.mjs';

const { publicError, errorEnvelope } = publicService;
export const HTTP_DEFAULTS = Object.freeze({ port: 3318, maxRequestBytes: 65536, maxResponseBytes: 5 * 1024 * 1024,
    maxConcurrent: 8, requestTimeoutMs: 5000, rateWindowMs: 60000, requestsPerWindow: 120, toolsPerWindow: 60, resourcesPerWindow: 60 });

function canonicalOrigin(origin) {
    if (typeof origin !== 'string' || !/^http:\/\/(?:127\.0\.0\.1|localhost):[0-9]+$/.test(origin)) throw new TypeError('Only explicit loopback HTTP origins are allowed');
    const url = new URL(origin);
    if (url.origin !== origin || Number(url.port) < 1 || Number(url.port) > 65535) throw new TypeError('Invalid allowed origin');
    return origin;
}

export function createLocalMcpApp({ service, allowedOrigins = [], now = Date.now, ...options } = {}) {
    const settings = { ...HTTP_DEFAULTS, ...options };
    for (const key of Object.keys(HTTP_DEFAULTS).filter(key => key !== 'port')) {
        if (!Number.isInteger(settings[key]) || settings[key] < 1) throw new TypeError(`Invalid HTTP budget: ${key}`);
    }
    if (!Number.isInteger(settings.port) || settings.port < 0 || settings.port > 65535) throw new TypeError('Invalid loopback port');
    const origins = new Set(allowedOrigins.map(canonicalOrigin));
    const buckets = new Map();
    function consume(category, limit) {
        const at = now();
        let bucket = buckets.get(category);
        if (!bucket || at - bucket.start >= settings.rateWindowMs) { bucket = { start: at, count: 0 }; buckets.set(category, bucket); }
        if (bucket.count >= limit) throw publicError('rate_limited');
        bucket.count++;
    }
    const app = express();
    app.disable('x-powered-by');
    app.set('trust proxy', false);
    const sendError = (res, status, code) => res.status(status).json(errorEnvelope(publicError(code)));
    let active = 0;
    app.use((req, res, next) => {
        res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Robots-Tag': 'noindex, nofollow' });
        const port = settings.port || req.socket.localPort;
        const host = req.headers.host;
        const headerCount = name => req.rawHeaders.filter((_, i) => i % 2 === 0 && req.rawHeaders[i].toLowerCase() === name).length;
        if (headerCount('host') !== 1 || ![`127.0.0.1:${port}`, `localhost:${port}`].includes(host)) return sendError(res, 403, 'invalid_request');
        const origin = req.headers.origin;
        if (headerCount('origin') > 1 || (origin !== undefined && !origins.has(origin))) return sendError(res, 403, 'invalid_request');
        next();
    });
    // SDK hostname validation complements the stricter scheme/host/port gate.
    app.use(hostHeaderValidation(['127.0.0.1', 'localhost']));
    app.use(originValidation(['127.0.0.1', 'localhost']));
    app.use((req, res, next) => {
        try { consume('http', settings.requestsPerWindow); } catch { return sendError(res, 429, 'rate_limited'); }
        if (active >= settings.maxConcurrent) return sendError(res, 429, 'rate_limited');
        active++;
        let finished = false;
        const release = () => { if (!finished) { finished = true; active--; } };
        res.once('finish', release); res.once('close', release);
        next();
    });
    app.use(express.json({ limit: settings.maxRequestBytes, strict: true, inflate: false }));
    const handler = createMcpHandler(() => createMcpServer({ service, readTimeoutMs: settings.requestTimeoutMs,
        beforeRead: category => consume(category, category === 'tool' ? settings.toolsPerWindow : settings.resourcesPerWindow) }),
    { legacy: 'stateless', responseMode: 'json', maxRequestBodySize: settings.maxRequestBytes, maxSubscriptions: 0 });

    // Buffer the bounded response, including the SDK's legacy SSE response,
    // before sending it so a budget failure cannot leak a partial result.
    const boundedHandler = { fetch: async (request, inputs) => {
        const controller = new AbortController();
        const signal = AbortSignal.any([request.signal, controller.signal]);
        const limitedRequest = new Request(request, { signal });
        const failure = status => new Response(JSON.stringify(errorEnvelope(publicError('source_unavailable'))), {
            status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
        });
        let timer;
        const timeout = new Promise(resolve => { timer = setTimeout(() => { controller.abort(); resolve(failure(503)); }, settings.requestTimeoutMs); });
        const exchange = (async () => {
            try {
                const response = await handler.fetch(limitedRequest, inputs);
                if (!response.body) return response;
                const reader = response.body.getReader();
                const chunks = []; let size = 0;
                for (;;) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    size += value.byteLength;
                    if (size > settings.maxResponseBytes) { await reader.cancel(); controller.abort(); return failure(503); }
                    chunks.push(value);
                }
                const headers = new Headers(response.headers);
                headers.set('Cache-Control', 'no-store'); headers.delete('content-length');
                return new Response(Buffer.concat(chunks), { status: response.status, headers });
            } catch { return failure(503); }
        })();
        try { return await Promise.race([exchange, timeout]); } finally { clearTimeout(timer); }
    } };
    const nodeHandler = toNodeHandler(boundedHandler, { maxRequestBodySize: settings.maxRequestBytes });
    app.all('/mcp', (req, res) => { void nodeHandler(req, res, req.body); });
    app.use((error, req, res, next) => {
        if (res.headersSent) return next(error);
        sendError(res, error.type === 'entity.too.large' ? 413 : 400, 'invalid_request');
    });
    return { app, settings, close: handler.close };
}

export async function startLocalMcpHttp({ closeSource = () => {}, ...options } = {}) {
    const runtime = createLocalMcpApp(options);
    const server = http.createServer(runtime.app);
    server.requestTimeout = runtime.settings.requestTimeoutMs;
    server.headersTimeout = runtime.settings.requestTimeoutMs;
    server.keepAliveTimeout = 2000;
    try {
        await new Promise((resolve, reject) => { server.once('error', reject); server.listen(runtime.settings.port, '127.0.0.1', resolve); });
    } catch (error) {
        await runtime.close(); closeSource(); throw error;
    }
    let closing;
    return { ...runtime, server, url: `http://127.0.0.1:${server.address().port}/mcp`, close: () => closing ||= (async () => {
        try {
            await runtime.close();
            await new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); });
        } finally { closeSource(); }
    })() };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    let source;
    try {
        source = openLocalPublicService(localSourceOptions());
        const port = process.env.PORTFOLIO_MCP_PORT === undefined ? HTTP_DEFAULTS.port : Number(process.env.PORTFOLIO_MCP_PORT);
        const allowedOrigins = process.env.PORTFOLIO_MCP_ORIGINS ? process.env.PORTFOLIO_MCP_ORIGINS.split(',') : [];
        const runtime = await startLocalMcpHttp({ service: source.service, closeSource: source.close, port, allowedOrigins });
        console.error(`Local public MCP: ${runtime.url}`);
        for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void runtime.close().finally(() => process.exit(0)); });
    } catch {
        source?.close(); console.error('Local public MCP could not be started'); process.exitCode = 1;
    }
}
