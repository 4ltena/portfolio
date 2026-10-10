import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const require = createRequire(new URL('../../mcp/package.json', import.meta.url));
const { Client, StreamableHTTPClientTransport } = await import(require.resolve('@modelcontextprotocol/client'));
const { documentMarkdown } = require('../agent-content.js');
let endpoint;
const prefix = 'portfolio://altena/';
const kinds = ['notes', 'works', 'skills', 'timeline'];
const resourceKinds = ['index', 'profile', 'works', 'notes', 'skills', 'timeline'];
const normalize = value => value.normalize('NFKC').toLowerCase();
const normalizedQuery = value => normalize(value.trim());
const same = isDeepStrictEqual;
const metadata = item => Object.fromEntries(Object.entries(item).filter(([key]) => key !== 'content_markdown'));
const searchText = item => normalize([item.title, item.summary, ...item.tags, item.content_markdown].join('\n'));
const metadataText = item => [item.title, item.summary, ...item.tags].join('\n');
const report = { endpoint: null, transports: [], public_counts: {}, searches: [], note_pages: 0,
    metadata_verified: 0, note_resources_verified: 0, rejections_verified: [], tool_calls: 0, http_requests: 0, origin_header_sent: false };
let phase = 'endpoint validation';
let lastRequestAt = 0;
let requestQueue = Promise.resolve();

class AcceptanceError extends Error {}

function check(condition, message) {
    if (!condition) throw new AcceptanceError(message);
}

async function connect(modern) {
    const client = new Client({ name: 'portfolio-remote-contract-check', version: '1.0.0' }, modern ?
        { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {});
    // Expected protocol rejections must not dump SDK diagnostics or response content.
    client.onerror = () => {};
    const transport = new StreamableHTTPClientTransport(endpoint, { fetch: async (input, init) => {
        requestQueue = requestQueue.then(async () => {
            await delay(Math.max(0, 400 - (performance.now() - lastRequestAt)));
            check(report.http_requests < 100, 'HTTP acceptance-test budget exceeded');
            report.http_requests += 1;
            lastRequestAt = performance.now();
        });
        await requestQueue;
        const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
        report.origin_header_sent ||= headers.has('Origin');
        return fetch(input, { ...init, credentials: 'omit', redirect: 'error' });
    } });
    await client.connect(transport);
    const version = client.getNegotiatedProtocolVersion();
    check(client.getProtocolEra() === (modern ? 'modern' : 'legacy'), 'Unexpected negotiated protocol era');
    if (modern) check(version === '2026-07-28', 'Modern protocol pin was not negotiated');
    report.transports.push({ era: modern ? 'modern' : 'legacy', version });
    return client;
}

async function call(client, name, args) {
    check(report.tool_calls < 50, 'Tool acceptance-test budget exceeded');
    report.tool_calls += 1;
    return client.callTool({ name, arguments: args });
}

async function success(client, name, args) {
    const result = await call(client, name, args);
    check(!result.isError && result.structuredContent?.schema_version === 1, 'Public tool did not return a successful envelope');
    const text = result.content.find(item => item.type === 'text');
    check(text && same(JSON.parse(text.text), result.structuredContent), 'Text and structured envelopes differ');
    return result.structuredContent;
}

async function discovery(client) {
    const { tools } = await client.listTools();
    check(same(tools.map(tool => tool.name).sort(), ['get_public_content', 'list_public_content', 'search_public_content']), 'Expected exactly three public tools');
    for (const tool of tools) {
        check(tool.title && tool.description && tool.inputSchema && tool.outputSchema, 'Public tool metadata is incomplete');
        const hints = tool.annotations;
        check(hints?.readOnlyHint === true && hints.destructiveHint === false && hints.idempotentHint === true && hints.openWorldHint === false,
            'Public tool read-only annotations differ');
    }
    const { resources } = await client.listResources();
    check(same(resources.map(item => item.uri).sort(), resourceKinds.map(kind => prefix + kind).sort()), 'Expected exactly six public resources');
    check(resources.every(item => item.mimeType === 'text/markdown' && item.title && item.description), 'Public resource metadata is incomplete');
    const { resourceTemplates } = await client.listResourceTemplates();
    check(same(resourceTemplates.map(item => item.uriTemplate).sort(), ['notes', 'works'].map(kind => `${prefix}${kind}/{id}`).sort()),
        'Expected exactly two public resource templates');
    check(resourceTemplates.every(item => item.mimeType === 'text/markdown' && item.title && item.description), 'Resource template metadata is incomplete');
    return resources;
}

function validateList(list, kind, limit = 50) {
    check(list.kind === kind && list.limit === limit && Array.isArray(list.items), 'List kind, limit or items differ');
    check(list.count === list.items.length && list.total_count >= list.count, 'List counts are inconsistent');
    check(new Set(list.items.map(item => item.id)).size === list.count, 'List IDs are duplicated');
    check(list.items.every(item => typeof item.id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(item.id) &&
        typeof item.title === 'string' && typeof item.summary === 'string' && Array.isArray(item.tags) && !Object.hasOwn(item, 'content_markdown')),
    'List metadata or content bounds differ');
}

async function lists(client) {
    const result = {};
    for (const kind of kinds) {
        const list = await success(client, 'list_public_content', { kind, limit: 50 });
        validateList(list, kind);
        check(list.query === '' && list.next_cursor === null && list.count === list.total_count,
            'Public dataset exceeds the bounded acceptance-test page');
        check(list.count > 0, 'Actual public dataset is empty');
        result[kind] = list;
    }
    return result;
}

async function search(client, kind, q, all, label, expectedId) {
    phase = `${label} search`;
    const expected = all.filter(item => !normalizedQuery(q) || searchText(item).includes(normalizedQuery(q)));
    const result = await success(client, 'search_public_content', { kind, q, limit: 50 });
    validateList(result, kind);
    check(result.query === normalizedQuery(q), 'Search query normalization differs');
    check(result.total_count === expected.length && result.next_cursor === null &&
        same(result.items.map(item => item.id), expected.map(item => item.id)), 'Search IDs differ from the public title, summary, tags and body filter');
    check(result.items.every((item, i) => same(item, metadata(expected[i]))), 'Search metadata differs from public detail metadata');
    if (expectedId) check(result.items.some(item => item.id === expectedId), 'Positive search omitted its known public item');
    report.searches.push({ label, kind, query: q, normalized_query: result.query, matches: result.items.map(item => item.title) });
    return result;
}

async function rejected(client, action, label) {
    phase = `${label} rejection`;
    const before = report.http_requests;
    let rejected = false;
    try {
        const result = await action();
        rejected = result?.isError === true && result.structuredContent?.error?.code === 'invalid_request';
    } catch (error) {
        rejected = error.code === -32602;
    }
    check(rejected && report.http_requests > before, 'Remote request was not rejected as invalid parameters');
    report.rejections_verified.push(label);
}

async function main() {
    try { endpoint = new URL(process.env.PORTFOLIO_MCP_URL || 'https://altena.me/portfolio/mcp'); }
    catch { throw new AcceptanceError('Invalid remote MCP URL'); }
    check(!endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash &&
        (endpoint.protocol === 'https:' || endpoint.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)),
    'Expected a credential-free HTTPS endpoint or loopback HTTP endpoint');
    report.endpoint = endpoint.origin + endpoint.pathname;
    phase = 'modern connection';
    const modern = await connect(true);
    try {
        phase = 'modern discovery';
        const resources = await discovery(modern);
        phase = 'public lists';
        const publicLists = await lists(modern);
        for (const kind of kinds) report.public_counts[kind] = publicLists[kind].total_count;
        check(publicLists.notes.count >= 3, 'Expected at least three actual public notes for cursor acceptance');

        const details = { notes: [], works: [] };
        phase = 'public detail metadata';
        for (const kind of ['notes', 'works']) {
            for (const listed of publicLists[kind].items) {
                const result = await success(modern, 'get_public_content', { kind, id: listed.id });
                check(result.item && result.item.type === listed.type && same(metadata(result.item), listed), 'Public detail metadata differs from list metadata');
                check(typeof result.item.content_markdown === 'string' && result.item.content_markdown.length > 0, 'Public detail body is empty');
                details[kind].push(result.item);
                report.metadata_verified += 1;
            }
        }

        phase = 'public resources';
        for (const resource of resources) {
            const result = await modern.readResource({ uri: resource.uri });
            check(result.contents.length === 1 && result.contents[0].uri === resource.uri && result.contents[0].mimeType === 'text/markdown' &&
                typeof result.contents[0].text === 'string' && result.contents[0].text.startsWith('# '), 'Public resource did not return bounded Markdown');
        }
        for (const note of details.notes) {
            const uri = `${prefix}notes/${note.id}`;
            const result = await modern.readResource({ uri });
            const expected = documentMarkdown({ ...note, description: note.summary, excerpt: note.summary });
            check(result.contents.length === 1 && result.contents[0].uri === uri && result.contents[0].mimeType === 'text/markdown' &&
                result.contents[0].text === expected, 'Note resource title, metadata or body differs from its public detail');
            report.note_resources_verified += 1;
        }

        const note = details.notes.find(item => item.title.trim() && [...item.title.trim()].length <= 120);
        check(note, 'No bounded public note title is available for positive search');
        const positive = note.title.trim();
        await search(modern, 'notes', positive, details.notes, 'public note title', note.id);
        const asciiItem = [...details.notes.map(item => ({ kind: 'notes', item })), ...details.works.map(item => ({ kind: 'works', item }))]
            .find(({ item }) => /[A-Za-z]{2,}/.test(metadataText(item)));
        check(asciiItem, 'No public ASCII term is available for case and width search');
        const ascii = metadataText(asciiItem.item).match(/[A-Za-z]{2,}/)[0].slice(0, 24);
        const wide = ` ${ascii.toUpperCase().replace(/[!-~]/g, character => String.fromCharCode(character.charCodeAt(0) + 0xfee0))} `;
        await search(modern, asciiItem.kind, wide, details[asciiItem.kind], 'case and fullwidth', asciiItem.item.id);
        await search(modern, 'notes', ' \u3000 ', details.notes, 'empty query');
        const negative = `remote-no-match-${randomUUID()}`;
        check(!details.notes.some(item => searchText(item).includes(normalize(negative))), 'Negative query unexpectedly occurs in public data');
        await search(modern, 'notes', negative, details.notes, 'unique no-results');
        const japanese = metadataText(note).match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]{2,8}/u)?.[0];
        if (japanese) await search(modern, 'notes', japanese, details.notes, 'public Japanese term', note.id);
        const bodyOnly = details.notes.flatMap(item => {
            const text = normalize(metadataText(item));
            const token = [...item.content_markdown.matchAll(/[A-Za-z0-9_-]{4,}|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]{2,12}/gu)]
                .map(match => match[0]).find(value => !text.includes(normalize(value)));
            return token ? [{ item, token }] : [];
        })[0];
        check(bodyOnly, 'No public body-only term is available to verify body search');
        await search(modern, 'notes', bodyOnly.token, details.notes, 'public body-only term', bodyOnly.item.id);
        const work = details.works.find(item => item.title.trim() && [...item.title.trim()].length <= 120);
        check(work, 'No bounded public work title is available for search');
        await search(modern, 'works', work.title.trim(), details.works, 'public work title', work.id);

        phase = 'notes cursor paging';
        const paged = [], cursors = new Set();
        let cursor;
        do {
            const args = { kind: 'notes', limit: 1, ...(cursor ? { cursor } : {}) };
            const page = await success(modern, 'list_public_content', args);
            validateList(page, 'notes', 1);
            check(page.count === 1 && page.total_count === publicLists.notes.total_count && page.query === '', 'Cursor page counts or query differ');
            paged.push(...page.items);
            report.note_pages += 1;
            cursor = page.next_cursor;
            if (cursor) {
                check(typeof cursor === 'string' && !cursors.has(cursor), 'Cursor repeats or is invalid');
                cursors.add(cursor);
            }
        } while (cursor);
        check(same(paged, publicLists.notes.items), 'Cursor pages skip, duplicate or change public metadata');

        phase = 'missing public note';
        const missingId = 'remote-contract-missing-note';
        check(!details.notes.some(item => item.id === missingId), 'Missing-note sentinel exists in public data');
        const missing = await call(modern, 'get_public_content', { kind: 'notes', id: missingId });
        check(missing.isError === true && same(missing.structuredContent,
            { schema_version: 1, error: { code: 'not_found', message: 'Not found' } }), 'Missing note did not return the fixed not_found envelope');
        report.rejections_verified.push('missing note not_found');
        await rejected(modern, () => call(modern, 'list_public_content', { kind: 'notes', unknown: true }), 'unknown argument');
        await rejected(modern, () => call(modern, 'search_public_content', { kind: 'notes', q: 'q'.repeat(121) }), 'overlong query');
        await rejected(modern, () => modern.readResource({ uri: `${prefix}notes/../profile` }), 'invalid resource URI');

        phase = 'legacy connection';
        const legacy = await connect(false);
        try {
            phase = 'legacy discovery';
            await discovery(legacy);
            phase = 'legacy public lists';
            const legacyLists = await lists(legacy);
            check(kinds.every(kind => same(legacyLists[kind].items, publicLists[kind].items)), 'Modern and legacy public lists differ');
            await search(legacy, 'notes', positive, details.notes, 'legacy public note title', note.id);
            const legacyResource = await legacy.readResource({ uri: `${prefix}notes/${note.id}` });
            check(legacyResource.contents[0]?.text === documentMarkdown({ ...note, description: note.summary, excerpt: note.summary }),
                'Legacy note resource differs from modern public detail');
        } finally {
            await legacy.close();
        }
    } finally {
        await modern.close();
    }
    console.log(JSON.stringify({ status: 'passed', ...report }, null, 2));
}

main().catch(error => {
    // Do not serialize SDK error bodies, detail content, cursors or stack traces.
    console.error(JSON.stringify({ status: 'failed', phase, error: error instanceof AcceptanceError ? error.message : 'Remote MCP request failed',
        tool_calls: report.tool_calls, http_requests: report.http_requests }));
    process.exitCode = 1;
});
