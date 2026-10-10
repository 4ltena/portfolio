(() => {
 'use strict';
 const section=document.getElementById('scroll-bridge');if(!section)return;
 const stage=section.querySelector('.bridge-stage'),hero=stage.querySelector('.hero-wrap');
 const canvas=document.getElementById('bridge-canvas'),ctx=canvas.getContext('2d');if(!ctx)return;
 const copy=stage.querySelector('.bridge-copy'),art=stage.querySelector('.idea-art'),prose=stage.querySelector('.idea-prose');
 const heroContent=hero.querySelector('.hero-content'),backToTop=document.querySelector('.back-to-top');
 const reduced=matchMedia('(prefers-reduced-motion: reduce)');
 const clamp=v=>Math.max(0,Math.min(1,v));
 const smooth=(a,b,p)=>{const t=clamp((p-a)/(b-a));return t*t*(3-2*t);};
 const lerp=(a,b,t)=>a+(b-a)*t;
 const STRIPE_SPEED=3.5,IDEAS_HOLD_VH=60,IDEAS_GAP_VH=0;
 function scrollGeometry(){
  const travel=h+slope+440,stripeEnd=travel/STRIPE_SPEED,revealStart=stripeEnd+h*IDEAS_GAP_VH/100;
  const complete=revealStart+h*.12,end=complete+h*IDEAS_HOLD_VH/100;
  return {travel,stripeEnd,revealStart,complete,end,target:(complete+end)/2};
 }
 let w=1,h=1,dpr=1,slope=0,bleed=72,pending=false,enabled=false,lastProgress=-1;
 let logCharacters=[],logOrder=[],logStep=-1,logVisual=null,logDirty=true;
 const logSource=hero.querySelector('.divider-status-beacon');
 const textMode=logSource?.querySelector('.divider-status-textmode');
 let logIgnited=false;
 function fitLog(){
  if(!logSource)return;
  const box=hero.getBoundingClientRect(),style=getComputedStyle(hero);
  const tangent=Math.tan((parseFloat(style.getPropertyValue('--divider-angle'))||18)*Math.PI/180);
  const edge=box.height-parseFloat(style.getPropertyValue('--divider-bleed')||'72');
  const rise=parseFloat(style.getPropertyValue('--bridge-rise'))||0;
  const lines=[...logSource.querySelectorAll('.divider-status-line')];
  lines.forEach(line=>line.style.removeProperty('font-size'));
  // A smaller line also lowers the rows above it; remeasure the shared grid.
  for(let pass=0;pass<6;pass++){
   let changed=false;
   lines.forEach(line=>{
    const r=line.getBoundingClientRect();if(!r.height)return;
    const left=(edge-(r.top-box.top+rise)+14)/tangent;
    const available=Math.max(1,r.right-box.left-Math.max(14,left));
    if(r.width>available+.5){
     line.style.fontSize=(parseFloat(getComputedStyle(line).fontSize)*available/r.width*.98)+'px';changed=true;
    }
   });
   if(!changed)break;
  }
 }
 function powerLog(){
  if(logIgnited||!logVisual||hero.classList.contains('divider-intro-running'))return;
  logIgnited=true;
  if(reduced.matches||scrollY>2||performance.getEntriesByType('navigation')[0]?.type==='back_forward')return;
  const split='drop-shadow(1px 0 #00e5ff) drop-shadow(-1px 0 #8a3ffc)';
  logVisual.animate([
   {opacity:.06,translate:'0 0',filter:'none',offset:0},
   {opacity:.72,translate:'1px 0',filter:split,offset:.15},
   {opacity:.12,translate:'-1px 0',filter:'none',offset:.3},
   {opacity:.72,translate:'-1px 0',filter:split,offset:.5},
   {opacity:.3,translate:'1px 0',filter:'none',offset:.62},
   {opacity:.72,translate:'0 0',filter:'none',offset:1}
  ].map(frame=>({...frame,easing:'steps(1,end)'})),{duration:300});
 }
 let crossedTarget=false;
 let settleTimer=0,settleFrame=0,settling=false,lastY=scrollY,direction=0,holding=false,suppressUntil=0,returnArmed=false,forwardArmed=true,returningToTop=false;
 function prepareLog(){
   if(!logSource)return;
   fitLog();
   const replacement=logSource.cloneNode(true);
   replacement.classList.remove('bridge-log-source');
   replacement.classList.add('bridge-log-fragments');
   replacement.setAttribute('aria-hidden','true');replacement.setAttribute('inert','');
   replacement.removeAttribute('id');
   replacement.querySelectorAll('[id],[aria-live],[role]').forEach(e=>{e.removeAttribute('id');e.removeAttribute('aria-live');e.removeAttribute('role');});
   const walker=document.createTreeWalker(replacement,NodeFilter.SHOW_TEXT),nodes=[];
   while(walker.nextNode())nodes.push(walker.currentNode);
   logCharacters=[];
   nodes.forEach(node=>{
     if(!node.textContent.trim())return;
     const fragment=document.createDocumentFragment();
     for(const char of node.textContent){const span=document.createElement('span');span.className='log-char';span.textContent=char;fragment.append(span);if(char.trim())logCharacters.push(span);}
     node.replaceWith(fragment);
   });
   if(logVisual)logVisual.replaceChildren(...replacement.childNodes);
   else {logSource.after(replacement);logVisual=replacement;}
   logOrder=logCharacters.map((_,i)=>i);
   let seed=731;const rand=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
   for(let i=logOrder.length-1;i>0;i--){const j=Math.floor(rand()*(i+1));[logOrder[i],logOrder[j]]=[logOrder[j],logOrder[i]];}
   logStep=-1;logDirty=false;
 }
 function eraseLog(p){
   if(!logVisual)return;
   const amount=clamp((p-.012)/.15),cut=Math.min(logOrder.length,Math.floor(amount*logOrder.length/4)*4+(amount===1?4:0));
   if(cut===logStep)return;logStep=cut;
   logOrder.forEach((index,rank)=>{const span=logCharacters[index],next=amount>0&&amount<1&&rank>=cut&&rank<cut+4;
     span.style.visibility=rank<cut?'hidden':'visible';
     span.style.transform=next?`translate(${index%2?3:-3}px,${index%3-1}px)`:'none';
     span.style.textShadow=next?'2px 0 #39cfe3, -1px 0 #b7bee5':'none';
   });
   logVisual.dataset.missing=String(cut);logVisual.dataset.total=String(logCharacters.length);
 }

 function polygon(points,fill){ctx.beginPath();points.forEach(([x,y],i)=>i?ctx.lineTo(x,y):ctx.moveTo(x,y));ctx.closePath();ctx.fillStyle=fill;ctx.fill();}
 function draw(){
  pending=false;
  if(backToTop)backToTop.classList.toggle('is-visible',scrollY>Math.min(innerHeight*.35,240));
  if(!enabled)return;
  const rect=section.getBoundingClientRect(),g=scrollGeometry(),distance=Math.min(g.end,Math.max(0,-rect.top)),progress=distance/h;
  const rise=Math.min(g.travel,distance*STRIPE_SPEED),p=Math.min(.53,rise/g.travel*.53);
  const contentP=lerp(.34,.53,clamp((distance-g.revealStart)/(h*.12)));
  const refreshLog=logDirty&&p<.162&&w>600;
  if(progress===lastProgress&&!refreshLog)return;
  lastProgress=progress;
  if(refreshLog)prepareLog();
  ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,w,h);
  const edge=h-bleed-rise;
  hero.style.setProperty('--bridge-rise',rise+'px');
  document.body.classList.toggle('bridge-light',edge-slope*.08<180);
  heroContent.style.opacity=1-smooth(.03,.26,p);eraseLog(p);
  const gap=slope;
  ['#90d7e2','#b7bee5','#bfd8ca','#e8baa6','#fafdfe'].forEach((color,i)=>{const left=edge+bleed+i*110+gap;polygon([[0,left],[w,left-slope],[w,h+1],[0,h+1]],color);});
  // 実リンクの矩形は文字消去から独立させ、Hero退出まで維持する。
  if(textMode){textMode.style.visibility=p<.26?'visible':'hidden';textMode.inert=p>=.26;}
  art.style.opacity=smooth(.34,.46,contentP);prose.style.opacity=smooth(.40,.53,contentP);
  prose.style.visibility=contentP>.40?'visible':'hidden';
  if(contentP>.38)art.classList.add('is-drawn');
  const shown=smooth(.38,.53,contentP);copy.style.opacity=shown;copy.style.visibility=shown>0?'visible':'hidden';copy.style.transform='translateY('+lerp(12,0,shown)+'px)';
 }
 function schedule(){if(!pending){pending=true;requestAnimationFrame(draw);}}
 function cancelSettle(){clearTimeout(settleTimer);cancelAnimationFrame(settleFrame);settling=false;}
 function fitIdeasTail(){
  section.style.setProperty('--ideas-tail-space',Math.max(0,h-prose.offsetTop-prose.offsetHeight)+'px');
 }
 function resize(){
  cancelSettle();crossedTarget=false;lastProgress=-1;logDirty=true;enabled=!reduced.matches;document.documentElement.classList.toggle('bridge-enhanced',enabled);
  if(!enabled){if(logVisual){logVisual.remove();logVisual=null;}section.style.removeProperty('height');section.style.removeProperty('--ideas-tail-space');if(textMode){textMode.style.removeProperty('visibility');textMode.inert=false;}document.body.classList.remove('bridge-light');hero.style.removeProperty('--bridge-rise');hero.style.removeProperty('--divider-drop');heroContent.style.removeProperty('opacity');[copy,art,prose].forEach(e=>{e.style.removeProperty('opacity');e.style.removeProperty('transform');e.style.removeProperty('visibility');});fitLog();schedule();return;}
  w=stage.clientWidth;h=stage.clientHeight;dpr=Math.min(devicePixelRatio||1,2);canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr);
  const computed=getComputedStyle(hero),angle=parseFloat(computed.getPropertyValue('--divider-angle'))||18;
  slope=w*Math.tan(angle*Math.PI/180);bleed=parseFloat(computed.getPropertyValue('--divider-bleed')||'72');
  section.style.height=(h+scrollGeometry().end)+'px';
  hero.style.setProperty('--divider-drop',slope+'px');draw();fitIdeasTail();
 }
 // 上下から停止区間の中点へ揃える。一度だけ補助し、次の操作で抜けられる。
 function queueSettle(previousY=scrollY){
  clearTimeout(settleTimer);
  if(performance.now()<suppressUntil){crossedTarget=false;return;}
  const viewport=h,start=section.getBoundingClientRect().top+scrollY;
  const g=scrollGeometry(),target=start+g.target,lower=start+g.complete-viewport*.06,upper=start+g.end+viewport*.06;
  if(scrollY>upper+viewport*.15)returnArmed=true;
  else if(scrollY<lower-viewport*.15)forwardArmed=true;
  if(direction>0&&forwardArmed&&previousY<target&&scrollY>=target)crossedTarget=true;
  if(direction<0&&returnArmed&&previousY>target&&scrollY<=target)crossedTarget=true;
  if(!enabled||returningToTop||holding||direction===0||performance.now()<suppressUntil)return;
  settleTimer=setTimeout(()=>{
   if(!enabled||returningToTop||holding||performance.now()<suppressUntil)return;
   const forward=direction>0&&forwardArmed&&(crossedTarget||(scrollY>=lower&&scrollY<=upper));
   const returning=direction<0&&returnArmed&&(crossedTarget||(scrollY>=lower&&scrollY<=upper));
   if(!forward&&!returning)return;
   returnArmed=false;forwardArmed=false;crossedTarget=false;
   if(Math.abs(scrollY-target)<2)return;
   const from=scrollY,to=target,time=performance.now();settling=true;
   const advance=now=>{const t=clamp((now-time)/460);scrollTo({top:lerp(from,to,t*t*(3-2*t)),behavior:'instant'});lastY=scrollY;if(t<1)settleFrame=requestAnimationFrame(advance);else settling=false;};
   settleFrame=requestAnimationFrame(advance);
  },180);
 }
 if(logSource){logSource.classList.add('bridge-log-source');new MutationObserver(()=>{logDirty=true;schedule();}).observe(logSource,{childList:true,subtree:true,characterData:true});}
 addEventListener('portfolio:section-navigation',e=>{cancelSettle();crossedTarget=false;direction=0;lastY=scrollY;suppressUntil=e.detail.active?Infinity:performance.now()+1400;});
 addEventListener('scroll',()=>{schedule();const previousY=lastY,dy=scrollY-lastY;lastY=scrollY;if(returningToTop){if(scrollY<=1){returningToTop=false;suppressUntil=performance.now()+300;}return;}if(settling)return;if(Math.abs(dy)>.1)direction=Math.sign(dy);queueSettle(previousY);},{passive:true});
 function interruptTopReturn(){
  if(!returningToTop)return;
  returningToTop=false;suppressUntil=performance.now()+300;scrollTo({top:scrollY,left:scrollX,behavior:'instant'});
 }
 addEventListener('scrollend',()=>{if(returningToTop&&scrollY<=1){returningToTop=false;suppressUntil=performance.now()+300;lastY=scrollY;direction=0;cancelSettle();}});
 addEventListener('wheel',e=>{interruptTopReturn();cancelSettle();if(e.deltaY){const nextDirection=Math.sign(e.deltaY);if(nextDirection!==direction)crossedTarget=false;direction=nextDirection;}},{passive:true});
 addEventListener('pointerdown',()=>{crossedTarget=false;interruptTopReturn();holding=true;cancelSettle();},{passive:true});
 addEventListener('pointerup',()=>{holding=false;queueSettle();},{passive:true});
 addEventListener('pointercancel',()=>{holding=false;cancelSettle();},{passive:true});
 addEventListener('keydown',()=>{crossedTarget=false;interruptTopReturn();cancelSettle();suppressUntil=performance.now()+900;});
 document.addEventListener('click',e=>{
  if(e.target.closest('a,button')){crossedTarget=false;cancelSettle();interruptTopReturn();suppressUntil=performance.now()+1200;}
  if(e.target.closest('.back-to-top')&&e.button===0&&!e.metaKey&&!e.ctrlKey&&!e.shiftKey&&!e.altKey){
   e.preventDefault();
   returningToTop=!reduced.matches&&scrollY>1;
   if(returningToTop)suppressUntil=Infinity;
   document.getElementById('top').focus({preventScroll:true});
   scrollTo({top:0,left:0,behavior:reduced.matches?'instant':'smooth'});
  }
 },true);
 document.documentElement.classList.add('has-scroll-controls');
 addEventListener('portfolio:divider-ready',powerLog);
 addEventListener('load',powerLog,{once:true});
 document.fonts.ready.then(()=>{logDirty=true;if(enabled)fitIdeasTail();schedule();});
 addEventListener('resize',resize);reduced.addEventListener('change',resize);resize();
})();
