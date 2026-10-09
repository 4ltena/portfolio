'use strict';

const express = require('express');
const { PublicError, publicError, errorEnvelope } = require('./agent-public-service');
const openapi = require('../docs/superpowers/api/public-openapi.json');

function createPublicRouter({ service }) {
    const router = express.Router();
    function send(req, res, status, value) {
        const json = JSON.stringify(value);
        // Use end rather than Express json/send, which can turn revoked data into a 304.
        res.status(status).set({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff', 'Content-Length': String(Buffer.byteLength(json)) }).end(req.method === 'HEAD' ? undefined : json);
    }
    function query(req, allowed) {
        const raw = req.url.split('?').slice(1).join('?');
        if (/%(?![0-9a-f]{2})/i.test(raw)) throw publicError('invalid_request');
        try { decodeURIComponent(raw.replaceAll('+', ' ')); } catch { throw publicError('invalid_request'); }
        const params = new URLSearchParams(raw);
        const result = {};
        for (const [key, value] of params) {
            if (!allowed.includes(key) || Object.hasOwn(result, key)) throw publicError('invalid_request');
            result[key] = value;
        }
        return result;
    }
    router.use((req, res, next) => {
        if (!['GET', 'HEAD'].includes(req.method)) {
            res.set('Allow', 'GET, HEAD');
            return send(req, res, 405, errorEnvelope(publicError('method_not_allowed')));
        }
        next();
    });
    router.get('/', (req, res) => {
        query(req, []);
        send(req, res, 200, { schema_version: 1, description: 'Public portfolio information only.',
            endpoints: ['profile', 'works', 'notes', 'skills', 'timeline', 'openapi.json'] });
    });
    router.get('/openapi.json', (req, res) => { query(req, []); send(req, res, 200, openapi); });
    router.get('/profile', (req, res) => { query(req, []); send(req, res, 200, service.get({ kind: 'profile' })); });
    for (const kind of ['works', 'notes', 'skills', 'timeline']) router.get(`/${kind}`, (req, res) => {
        const input = query(req, ['works', 'notes'].includes(kind) ? ['q', 'limit', 'cursor'] : ['limit', 'cursor']);
        send(req, res, 200, service.list({ kind, ...input }));
    });
    for (const kind of ['works', 'notes']) router.get(`/${kind}/:id`, (req, res) => {
        query(req, []); send(req, res, 200, service.get({ kind, id: req.params.id }));
    });
    router.use((req, res) => send(req, res, 404, errorEnvelope(publicError('not_found'))));
    router.use((error, req, res, next) => {
        const failure = error instanceof PublicError ? error : publicError(error instanceof URIError ? 'not_found' : 'source_unavailable');
        send(req, res, failure.status, errorEnvelope(failure));
    });
    return router;
}
module.exports = { createPublicRouter };
