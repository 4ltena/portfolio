import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import publicService from '../agent-public-service.js';

const require = createRequire(new URL('../package.json', import.meta.url));
const DEFAULT_ROOT = fileURLToPath(new URL('../../', import.meta.url));

export function openLocalPublicService({ root = DEFAULT_ROOT, dbPath = path.join(root, 'api/data/portfolio.db') } = {}) {
    const Database = require('better-sqlite3');
    const db = new Database(path.resolve(dbPath), { readonly: true, fileMustExist: true });
    try {
        const service = publicService.createPublicService({ root: path.resolve(root), db });
        return { service, db, close: () => { if (db.open) db.close(); } };
    } catch (error) {
        db.close();
        throw error;
    }
}

export function localSourceOptions(env = process.env) {
    const root = env.PORTFOLIO_MCP_ROOT ? path.resolve(env.PORTFOLIO_MCP_ROOT) : DEFAULT_ROOT;
    return { root, dbPath: env.PORTFOLIO_MCP_DB ? path.resolve(env.PORTFOLIO_MCP_DB) : path.join(root, 'api/data/portfolio.db') };
}
