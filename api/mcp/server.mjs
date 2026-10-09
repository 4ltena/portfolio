import { McpServer, ResourceTemplate, ResourceNotFoundError, ProtocolError,
    INVALID_PARAMS, INTERNAL_ERROR, fromJsonSchema } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import publicService from '../agent-public-service.js';
import publicSchema from '../agent-public-schema.js';

const { errorEnvelope, publicError } = publicService;
const { LIST_SCHEMA, DETAIL_SCHEMA, ERROR_SCHEMA } = publicSchema;
const PREFIX = 'portfolio://altena/';
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const limit = z.number().int().min(1).max(50).optional();
const cursor = z.string().refine(value => Buffer.byteLength(value, 'utf8') <= 2048, 'Cursor exceeds 2048 bytes').optional();
const id = z.string().regex(ID);
const query = z.string().refine(value => [...value].length <= 120 && !/[\u0000-\u001f\u007f-\u009f]/u.test(value), 'Query exceeds 120 code points or contains control characters');
const output = schema => fromJsonSchema({ type: 'object', anyOf: [schema, ERROR_SCHEMA] });

export function parsePublicResourceUri(uri) {
    // Validate the original string before URL parsing can normalize dot paths.
    if (typeof uri !== 'string' || !uri.startsWith(PREFIX)) throw new ProtocolError(INVALID_PARAMS, 'Invalid public resource URI');
    const path = uri.slice(PREFIX.length);
    const match = /^(index|profile|skills|timeline|works|notes)(?:\/([A-Za-z0-9_-]{1,128}))?$/.exec(path);
    if (!match || (match[2] && !['works', 'notes'].includes(match[1]))) throw new ProtocolError(INVALID_PARAMS, 'Invalid public resource URI');
    return { kind: match[1], ...(match[2] ? { id: match[2] } : {}) };
}

function links(envelope) {
    const items = envelope.item ? [envelope.item] : envelope.items || [];
    return items.filter(item => ['work', 'note', 'profile'].includes(item.type)).map(item => ({
        type: 'resource_link',
        uri: PREFIX + (item.type === 'profile' ? 'profile' : `${item.type === 'work' ? 'works' : 'notes'}/${item.id}`),
        name: item.id,
        title: item.title,
        mimeType: 'text/markdown'
    }));
}

export function createMcpServer({ service, beforeRead = () => {}, readTimeoutMs = 5000 }) {
    if (!service || !['list', 'get', 'markdown'].every(method => typeof service[method] === 'function')) throw new TypeError('A public read service is required');
    const server = new McpServer({ name: 'altena-portfolio-public', version: '1.0.0' }, {
        capabilities: { tools: { listChanged: false }, resources: { listChanged: false } }
    });
    async function read(category, method, args) {
        beforeRead(category);
        const started = performance.now();
        const result = await service[method](args);
        if (performance.now() - started > readTimeoutMs) throw publicError('source_unavailable');
        return result;
    }
    const tool = (method, project) => async args => {
        try {
            const envelope = await read('tool', method, project(args));
            return { content: [{ type: 'text', text: JSON.stringify(envelope) }, ...links(envelope)], structuredContent: envelope, isError: false };
        } catch (error) {
            const envelope = errorEnvelope(error);
            return { content: [{ type: 'text', text: JSON.stringify(envelope) }], structuredContent: envelope, isError: true };
        }
    };
    server.registerTool('list_public_content', {
        title: 'List public portfolio content', description: 'Read a bounded page of public works, notes, skills or timeline entries.',
        inputSchema: z.object({ kind: z.enum(['works', 'notes', 'skills', 'timeline']), limit, cursor }).strict(),
        outputSchema: output(LIST_SCHEMA), annotations
    }, tool('list', args => args));
    server.registerTool('search_public_content', {
        title: 'Search public portfolio content', description: 'Search public works or notes by title, summary, tags and Markdown text.',
        inputSchema: z.object({ kind: z.enum(['works', 'notes']), q: query, limit, cursor }).strict(),
        outputSchema: output(LIST_SCHEMA), annotations
    }, tool('list', args => args));
    server.registerTool('get_public_content', {
        title: 'Read public portfolio content', description: 'Read the public profile or one public work or note, including its Markdown body.',
        inputSchema: z.union([
            z.object({ kind: z.literal('profile') }).strict(),
            z.object({ kind: z.enum(['works', 'notes']), id }).strict()
        ]), outputSchema: output(DETAIL_SCHEMA), annotations
    }, tool('get', args => args));

    async function resource(uri) {
        const args = parsePublicResourceUri(uri);
        try {
            const text = await read('resource', 'markdown', args);
            return { contents: [{ uri, mimeType: 'text/markdown', text }] };
        } catch (error) {
            const envelope = errorEnvelope(error);
            if (envelope.error.code === 'not_found') throw new ResourceNotFoundError(uri, envelope.error.message);
            throw new ProtocolError(envelope.error.code === 'invalid_request' ? INVALID_PARAMS : INTERNAL_ERROR, envelope.error.message);
        }
    }
    for (const [kind, title] of [['index', 'Public portfolio overview'], ['profile', 'Public profile'], ['works', 'Public works'],
        ['notes', 'Public notes'], ['skills', 'Public skills'], ['timeline', 'Public timeline']]) {
        server.registerResource(kind, PREFIX + kind, { title, description: title + ' as bounded Markdown.', mimeType: 'text/markdown' }, uri => resource(uri.href));
    }
    for (const kind of ['works', 'notes']) server.registerResource(`${kind}-detail`, new ResourceTemplate(PREFIX + `${kind}/{id}`, { list: undefined }),
        { title: `Public ${kind} detail`, description: 'Read a public item ID discovered from a tool result.', mimeType: 'text/markdown' }, uri => resource(uri.href));
    // The SDK otherwise creates URL before a callback, normalizing ../. Keep
    // SDK discovery/serialization and validate the raw requested URI here.
    server.server.setRequestHandler('resources/read', request => resource(request.params.uri));
    return server;
}
