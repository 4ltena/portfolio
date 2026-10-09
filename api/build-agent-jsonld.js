'use strict';

// Refresh metadata when static pages are prepared for deployment; never write to the database.
const fs = require('node:fs');
const path = require('node:path');
const { createPublicService } = require('./agent-public-service');
const { generateJsonLd, embedJsonLd } = require('./agent-jsonld');

function buildMetadata({ root, db, write = false }) {
    const service = createPublicService({ root, db });
    const profile = service.get({ kind: 'profile' }).item;
    const all = kind => {
        const items = [];
        let cursor;
        do {
            const page = service.list({ kind, limit: 50, cursor });
            items.push(...page.items);
            cursor = page.next_cursor || undefined;
        } while (cursor);
        return items;
    };
    const works = all('works');
    const notes = all('notes');
    const pages = [
        ['index.html', generateJsonLd({ kind: 'index', item: profile, profile })],
        ['myworks.html', generateJsonLd({ kind: 'works', items: works, profile })],
        // Notes cards are populated by JS; the initial static HTML has no visible article cards.
        ['notes.html', generateJsonLd({ kind: 'notes', items: [], profile })]
    ];
    for (const kind of ['works', 'notes']) {
        for (const summary of kind === 'works' ? works : notes) {
            const item = service.get({ kind, id: summary.id }).item;
            pages.push([`${kind}/${item.id}/index.html`, generateJsonLd({ kind: kind === 'works' ? 'work' : 'note', item, profile })]);
        }
    }
    const base = fs.realpathSync(root) + path.sep;
    const changes = pages.map(([filename, metadata]) => {
        const target = fs.realpathSync(path.join(root, filename));
        if (!target.startsWith(base)) throw new Error('Metadata target escapes the site root');
        const before = fs.readFileSync(target, 'utf8');
        return { target, filename, before, after: embedJsonLd(before, metadata) };
    });
    for (const change of changes) {
        if (write && change.before !== change.after) fs.writeFileSync(change.target, change.after);
    }
    return changes.map(({ filename, before, after }) => ({ filename, changed: before !== after }));
}

if (require.main === module) {
    if (process.argv.slice(2).some(arg => !['--write', '--check'].includes(arg))) throw new Error('Use --write or --check');
    const Database = require('better-sqlite3');
    const root = path.resolve(__dirname, '..');
    const db = new Database(path.join(__dirname, 'data/portfolio.db'), { readonly: true, fileMustExist: true });
    try {
        const changes = buildMetadata({ root, db, write: process.argv.includes('--write') });
        for (const item of changes) console.log(`${item.changed ? 'changed' : 'current'} ${item.filename}`);
    } finally { db.close(); }
}
module.exports = { buildMetadata };
