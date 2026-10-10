'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const { buildMetadata } = require('./build-agent-jsonld');

function sourceFiles(root) {
    const write = (name, body) => {
        const target = path.join(root, name);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, `<html><head><title>Fixture</title></head><body>${body}</body></html>`);
    };
    write('index.html', '<div class="hero-foot"><span>Infrastructure</span></div><section id="profile"><span class="brand">Altena</span><p class="philosophy">Design</p><div class="bio"><p>公開紹介</p></div><nav class="profile-social"><a href="https://github.com/4ltena">GitHub</a></nav></section>');
    fs.mkdirSync(path.join(root, 'terminal'), { recursive: true });
    fs.writeFileSync(path.join(root, 'terminal/profile.txt'), '|__ Role Software Engineer\n');
    write('myworks.html', '<div class="page-tile-container"></div>');
    write('notes.html', '<div id="all-notes"></div>');
    return write;
}
function schema(html) {
    return JSON.parse(/<script[^>]*id="portfolio-agent-jsonld"[^>]*>([\s\S]*?)<\/script>/.exec(html)[1]);
}

test('static metadata build is idempotent, readonly, and leaves private pages untouched', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'portfolio-jsonld-build-'));
    const write = sourceFiles(root);
    const cards = [];
    for (let i = 0; i < 21; i++) {
        const id = `work-${i}`;
        cards.push(`<a class="page-tile-item" href="works/${id}/index.html"><h3>${id}</h3><span class="note-date">2026/10/09</span><p>Summary</p></a>`);
        write(`works/${id}/index.html`, '<div class="project-desc"><p>Work body</p></div>');
    }
    write('myworks.html', `<div class="page-tile-container">${cards.join('')}</div>`);
    write('notes/public/index.html', '<h1>Public</h1>');
    write('notes/private/index.html', 'PRIVATE_MARKER');
    const database = path.join(root, 'fixture.db');
    const writer = new Database(database);
    writer.exec(`CREATE TABLE articles (id TEXT,title TEXT,date TEXT,tags TEXT,excerpt TEXT,content TEXT,created_at INTEGER,updated_at INTEGER,published_at INTEGER,visibility TEXT);
        CREATE TABLE skills (id TEXT,name TEXT,description TEXT,sort_order INTEGER);
        CREATE TABLE timeline (id TEXT,date TEXT,title TEXT,category TEXT,href TEXT);`);
    const insert = writer.prepare('INSERT INTO articles VALUES (?,?,?,?,?,?,?,?,?,?)');
    insert.run('public','Public','2026/10/09','[]','Summary','<p>Body</p>',1000,2000,1000,'public');
    insert.run('private','PRIVATE_MARKER','2026/10/09','[]','SECRET','<p>Secret</p>',1000,2000,null,'draft');
    writer.close();
    const hash = () => crypto.createHash('sha256').update(fs.readFileSync(database)).digest('hex');
    const before = hash();
    const db = new Database(database, { readonly: true, fileMustExist: true });
    let listener;
    t.after(async () => {
        if (listener) await new Promise(resolve => listener.close(resolve));
        db.close(); fs.rmSync(root, { recursive: true, force: true });
    });
    assert.equal(buildMetadata({ root, db, write: true }).length, 25);
    const top = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    assert.ok(schema(top)['@graph'].some(item => item['@type'] === 'Person'));
    assert.ok(schema(fs.readFileSync(path.join(root, 'notes/public/index.html'), 'utf8'))['@graph'].some(item => item['@type'] === 'BlogPosting'));
    assert.doesNotMatch(top, /PRIVATE_MARKER|SECRET/);
    assert.doesNotMatch(fs.readFileSync(path.join(root, 'notes/private/index.html'), 'utf8'), /portfolio-agent-jsonld/);
    assert.ok(buildMetadata({ root, db }).every(item => !item.changed));
    listener = require('./agent-preview').createPreview({root,db}).listen(0,'127.0.0.1');
    await new Promise(resolve => listener.once('listening',resolve));
    const collection = await (await fetch(`http://127.0.0.1:${listener.address().port}/portfolio/works.jsonld`)).json();
    assert.equal(collection['@graph'].find(node => node['@type'] === 'ItemList').numberOfItems,21);
    assert.equal(hash(), before);
});

test('publish and update stage the same dates and revision as JSON; unpublishing removes every detail', async t => {
    const jwt = require('jsonwebtoken');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'portfolio-jsonld-publish-'));
    sourceFiles(root);
    const values = { PORTFOLIO_ROOT: root, PORTFOLIO_DATA_DIR: path.join(root,'data'), PORTFOLIO_NOTES_OUT_DIR: path.join(root,'notes'), PORTFOLIO_IMG_DIR: path.join(root,'img'), ADMIN_PASSWORD: 'fixture-only-password', NODE_ENV: 'test' };
    for (const name of ['data','notes','img']) fs.mkdirSync(path.join(root,name));
    const previous = Object.fromEntries(Object.keys(values).map(name => [name,process.env[name]]));
    Object.assign(process.env, values);
    const modulePath = require.resolve('./server');
    delete require.cache[modulePath];
    const runtime = require('./server');
    const listener = runtime.app.listen(0, '127.0.0.1');
    await new Promise(resolve => listener.once('listening',resolve));
    t.after(async () => {
        await new Promise(resolve => listener.close(resolve));
        runtime.db.close(); delete require.cache[modulePath];
        for (const [name,value] of Object.entries(previous)) value === undefined ? delete process.env[name] : process.env[name]=value;
        fs.rmSync(root,{recursive:true,force:true});
    });
    const base = `http://127.0.0.1:${listener.address().port}`;
    const token = jwt.sign({admin:true},runtime.config.jwtSecret,{expiresIn:'5m'});
    const body = {title:'Fixture Note',date:'2026/10/09',tags:['Test'],excerpt:'Summary',content:'<p>Body</p>',visibility:'public'};
    const save = (route,method,payload) => fetch(base+route,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(payload)});
    const created = await save('/articles','POST',body);
    assert.equal(created.status,201,await created.clone().text());
    const id = (await created.json()).id;
    const validate = async title => {
        const response = await fetch(`${base}/agent/api/public/notes/${id}`);
        assert.equal(response.status,200);
        const item = (await response.json()).item;
        const markup = fs.readFileSync(path.join(root,'notes',id,'index.html'),'utf8');
        const article = schema(markup)['@graph'].find(node => node['@type']==='BlogPosting');
        assert.equal(article.headline,title); assert.equal(article.url,item.canonical_url);
        assert.equal(article.dateModified,item.updated_at); assert.equal(article.datePublished,item.published_at);
        assert.equal(article.version,item.revision);
        return item;
    };
    const first = await validate(body.title);
    assert.equal((await save(`/articles/${id}`,'PUT',{...body,title:'Updated Note',content:'<p>Changed</p>'})).status,200);
    const second = await validate('Updated Note');
    assert.notEqual(second.revision,first.revision); assert.equal(second.published_at,first.published_at);
    assert.equal((await save(`/articles/${id}`,'PUT',{...body,visibility:'draft'})).status,200);
    assert.equal((await fetch(`${base}/agent/api/public/notes/${id}`)).status,404);
    assert.equal((await fetch(`${base}/agent/notes/${id}.md`)).status,404);
    assert.ok(!fs.existsSync(path.join(root,'notes',id,'index.html')));
});
