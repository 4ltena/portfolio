const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const source=fs.readFileSync(require('node:path').join(__dirname,'../js/main.js'),'utf8').split('function initSectionNavigation()')[1];
function setup(type="navigate", saved=null){
 const events={}, clicks={}, calls=[], messages=[]; let resolveFonts;
 const storage={value:saved ? JSON.stringify({href:'https://example.com/portfolio/index.html#skills',y:saved.portfolioScrollY}) : null,getItem(){return this.value;},setItem(key,value){this.value=value;}};
 const state={sessionStorage:storage,location:{hash:'#skills',href:'https://example.com/portfolio/index.html#skills',origin:'https://example.com',pathname:'/portfolio/index.html'},scrollY:0,REDUCED_MOTION:false,performance:{getEntriesByType:()=>[{type}]},URL,Set,CustomEvent:class{constructor(type,options){this.type=type;this.detail=options.detail;}},requestAnimationFrame:f=>f(),history:{state:saved,replaceState(value){this.state=value;},pushState(...a){calls.push(a);}},document:{documentElement:{classList:{remove(){}}},fonts:{ready:new Promise(r=>resolveFonts=r)},getElementById:id=>({getBoundingClientRect:()=>({top:1500})}),querySelector:()=>({getBoundingClientRect:()=>({height:72})}),addEventListener:(name,fn)=>clicks[name]=fn}};
 state.window={addEventListener:(name,fn)=>events[name]=fn,dispatchEvent:e=>messages.push(e.detail.active),scrollTo:o=>calls.push(o)};
 vm.createContext(state);vm.runInContext('function initSectionNavigation()'+source,state);
 return {state,events,clicks,calls,messages,resolveFonts,finish:state.initSectionNavigation()};
}
test('initial hash aligns only after fonts and dynamic layout are ready',async()=>{const h=setup(); const done=h.finish();assert.equal(h.calls.length,0);h.resolveFonts();await done;assert.equal(h.calls[0].top,1404);assert.equal(h.calls[0].behavior,'instant');assert.deepEqual(h.messages,[true,true,false]);});
test('user scrolling cancels deferred initial correction',async()=>{const h=setup();h.events.wheel();h.resolveFonts();await h.finish();assert.equal(h.calls.length,0);assert.equal(h.messages.at(-1),false);});
test('same page menu links use current layout and preserve modified clicks',async()=>{const h=setup();h.resolveFonts();await h.finish();h.calls.length=0;let prevented=false;const event={target:{closest:()=>({href:'https://example.com/portfolio/index.html#timeline'})},button:0,preventDefault:()=>prevented=true};h.clicks.click({...event,ctrlKey:true});assert.equal(h.calls.length,0);h.clicks.click(event);assert.equal(prevented,true);assert.equal(h.calls[1].behavior,'smooth');assert.equal(h.calls[1].top,1404);});

test('smooth section navigation suppresses snapping until arrival',async()=>{
 const h=setup();h.resolveFonts();await h.finish();
 h.clicks.click({target:{closest:()=>({href:'https://example.com/portfolio/index.html#timeline'})},button:0,preventDefault(){}});
 assert.equal(h.messages.at(-1),true);
 h.events.scrollend();assert.equal(h.messages.at(-1),true);
 h.state.scrollY=1404;h.events.scrollend();assert.equal(h.messages.at(-1),false);
});
test('manual interaction releases section navigation suppression',async()=>{
 const h=setup();h.resolveFonts();await h.finish();
 h.clicks.click({target:{closest:()=>({href:'https://example.com/portfolio/index.html#timeline'})},button:0,preventDefault(){}});
 h.events.wheel();assert.equal(h.messages.at(-1),false);
});

test('reload restores the reading position after layout, instead of the URL fragment',async()=>{
 const h=setup('reload',{portfolioScrollY:3200});const done=h.finish();assert.equal(h.calls.length,0);
 h.resolveFonts();await done;assert.equal(h.calls[0].top,3200);assert.equal(h.calls[0].behavior,'instant');
});
test('reload without a saved position leaves native restoration intact',async()=>{
 const h=setup('reload');h.resolveFonts();await h.finish();assert.equal(h.calls.length,0);
});
test('manual scrolling cancels pending reload restoration',async()=>{
 const h=setup('reload',{portfolioScrollY:3200});h.events.wheel();h.resolveFonts();await h.finish();assert.equal(h.calls.length,0);
});
test('pagehide saves the position without discarding existing history state',async()=>{
 const h=setup('navigate',{other:1});h.events.pagehide();assert.equal(h.state.history.state.portfolioScrollY,undefined);
 h.resolveFonts();await h.finish();h.state.scrollY=3500;h.events.pagehide();assert.equal(JSON.parse(h.state.sessionStorage.value).y,3500);assert.equal(h.state.history.state.other,1);
});
test('back navigation does not apply reload restoration',async()=>{
 const h=setup('back_forward',{portfolioScrollY:3200});h.resolveFonts();await h.finish();assert.equal(h.calls.length,0);
});
