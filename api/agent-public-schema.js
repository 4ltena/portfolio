'use strict';

const nullableString = { type: ['string', 'null'] };
const timestamp = { type: ['string', 'null'], format: 'date-time' };
const strings = { type: 'array', items: { type: 'string' } };
const itemProperties = {
    id: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,128}$' },
    type: { type: 'string', enum: ['profile', 'work', 'note', 'skill', 'timeline'] },
    title: { type: 'string' }, summary: { type: 'string' },
    canonical_url: { type: 'string', format: 'uri' }, source_url: { type: 'string', format: 'uri' },
    date: { type: ['string', 'null'], pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    published_at: timestamp, updated_at: timestamp,
    updated_at_basis: { type: 'string', enum: ['article-record', 'source-file-mtime', 'not-tracked'] },
    source_modified_at: { type: 'string', format: 'date-time' }, tags: strings,
    revision: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' },
    name: { type: 'string' }, roles: strings, bio: { type: 'string' }, focus: strings, links: strings,
    category: { type: 'string' }, href: nullableString
};
const itemRequired = ['id', 'type', 'title', 'summary', 'canonical_url', 'source_url', 'date', 'published_at',
    'updated_at', 'updated_at_basis', 'tags', 'revision'];
const listItem = { type: 'object', additionalProperties: false, properties: {
    ...itemProperties, type: { type: 'string', enum: ['work', 'note', 'skill', 'timeline'] }
}, required: itemRequired };
const detailItem = { type: 'object', additionalProperties: false, properties: {
    ...itemProperties, type: { type: 'string', enum: ['profile', 'work', 'note'] }, content_markdown: { type: 'string' }
}, required: [...itemRequired, 'content_markdown'] };
const LIST_SCHEMA = { type: 'object', additionalProperties: false,
    required: ['schema_version', 'generated_at', 'kind', 'query', 'count', 'total_count', 'limit', 'next_cursor', 'items'],
    properties: { schema_version: { const: 1, type: 'integer' }, generated_at: { type: 'string', format: 'date-time' },
        kind: { type: 'string', enum: ['works', 'notes', 'skills', 'timeline'] }, query: { type: 'string' },
        count: { type: 'integer', minimum: 0, maximum: 50 }, total_count: { type: 'integer', minimum: 0 },
        limit: { type: 'integer', minimum: 1, maximum: 50 }, next_cursor: nullableString,
        items: { type: 'array', maxItems: 50, items: listItem } } };
const DETAIL_SCHEMA = { type: 'object', additionalProperties: false, required: ['schema_version', 'generated_at', 'item'],
    properties: { schema_version: { const: 1, type: 'integer' }, generated_at: { type: 'string', format: 'date-time' }, item: detailItem } };
const ERROR_SCHEMA = { type: 'object', additionalProperties: false, required: ['schema_version', 'error'],
    properties: { schema_version: { const: 1, type: 'integer' }, error: { type: 'object', additionalProperties: false,
        required: ['code', 'message'], properties: { code: { type: 'string', enum: ['invalid_request', 'invalid_cursor', 'not_found',
            'method_not_allowed', 'cursor_expired', 'rate_limited', 'source_unavailable'] }, message: { type: 'string' } } } } };
module.exports = { LIST_SCHEMA, DETAIL_SCHEMA, ERROR_SCHEMA };
