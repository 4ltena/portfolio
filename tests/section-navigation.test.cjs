const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const source=fs.readFileSync(require('node:path').join(__dirname,'../js/main.js'),'utf8').split('function initSectionNavigation()')[1];
function setup(){
 const events={}, clicks={}, calls=[], messages=[]; let resolveFonts;
 const state={location:{hash:'#skills',href:'https://example.com/portfolio/index.html#skills',origin:'https://example.com',pathname:'/portfolio/index.html'},scrollY:0,REDUCED_MOTION:false,URL,Set,CustomEvent:class{constructor(type,options){this.type=type;this.detail=options.detail;}},requestAnimationFrame:f=>f(),history:{pushState(...a){calls.push(a);}},document:{fonts:{ready:new Promise(r=>resolveFonts=r)},getElementById:id=>({getBoundingClientRect:()=>({top:1500})}),querySelector:()=>({getBoundingClientRect:()=>({height:72})}),addEventListener:(name,fn)=>clicks[name]=fn}};
 state.window={addEventListener:(name,fn)=>events[name]=fn,dispatchEvent:e=>messages.push(e.detail.active),scrollTo:o=>calls.push(o)};
 vm.createContext(state);vm.runInContext('function initSectionNavigation()'+source,state);
 return {state,events,clicks,calls,messages,resolveFonts,finish:state.initSectionNavigation()};
}
test('initial hash aligns only after fonts and dynamic layout are ready',async()=>{const h=setup(); const done=h.finish();assert.equal(h.calls.length,0);h.resolveFonts();await done;assert.equal(h.calls[0].top,1404);assert.equal(h.calls[0].behavior,'instant');assert.deepEqual(h.messages,[true,true,false]);});
test('user scrolling cancels deferred initial correction',async()=>{const h=setup();h.events.wheel();h.resolveFonts();await h.finish();assert.equal(h.calls.length,0);assert.equal(h.messages.at(-1),false);});
test('same page menu links use current layout and preserve modified clicks',async()=>{const h=setup();h.resolveFonts();await h.finish();h.calls.length=0;let prevented=false;const event={target:{closest:()=>({href:'https://example.com/portfolio/index.html#timeline'})},button:0,preventDefault:()=>prevented=true};h.clicks.click({...event,ctrlKey:true});assert.equal(h.calls.length,0);h.clicks.click(event);assert.equal(prevented,true);assert.equal(h.calls[1].behavior,'smooth');assert.equal(h.calls[1].top,1404);});
