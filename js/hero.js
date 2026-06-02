// ヒーロー背景の Three.js キューブ群（index.html から分離）
// importmap は index.html 側に定義（'three' / 'three/addons/' を解決）

import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const canvas   = document.getElementById('hero-canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping         = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.9;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x020810);
scene.fog        = new THREE.FogExp2(0x020810, 0.015);

const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 120);
camera.position.set(0, 0, 10);

const pmrem       = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

scene.add(new THREE.AmbientLight(0x050e1a, 4));
[[0x4499ff,120,7,6,6,35],[0x00ccff,50,-9,1,4,25],[0xaaccff,20,2,-7,5,18]]
  .forEach(([c,i,x,y,z,d]) => { const l=new THREE.PointLight(c,i,d); l.position.set(x,y,z); scene.add(l); });

const matSolid = new THREE.MeshStandardMaterial({ color:0x080c12, metalness:1.0, roughness:0.12, envMapIntensity:0.6 });
const matHit   = new THREE.MeshBasicMaterial({ visible:false });
const matWire  = [
  new THREE.LineBasicMaterial({ color:0x00ddff, transparent:true, opacity:0.90 }),
  new THREE.LineBasicMaterial({ color:0x00aacc, transparent:true, opacity:0.55 }),
  new THREE.LineBasicMaterial({ color:0x006688, transparent:true, opacity:0.30 }),
  new THREE.LineBasicMaterial({ color:0x003344, transparent:true, opacity:0.13 }),
];

const ZONES = [
  { zMin:-70, zMax:-20, szMin:0.12, szMax:0.40, count:65, solidRate:0.00, collide:false, speed:0.00040 },
  { zMin:-20, zMax: -6, szMin:0.15, szMax:1.00, count:35, solidRate:0.25, collide:true,  speed:0.00150 },
  { zMin: -6, zMax:  2, szMin:0.35, szMax:2.20, count:18, solidRate:0.35, collide:true,  speed:0.00090 },
];

const rng = (a,b) => a + Math.random()*(b-a);
const cubes=[], hitBoxes=[], hitToCube=new Map();

function spawnCube({ zMin, zMax, szMin, szMax, solidRate, collide, speed }) {
  const z=rng(zMin,zMax), depth=(z-zMin)/(zMax-zMin), size=rng(szMin,szMax), solid=Math.random()<solidRate;
  let visual;
  if (solid) {
    visual = new THREE.Mesh(new THREE.BoxGeometry(size,size,size), matSolid);
  } else {
    const idx = Math.min(Math.floor((1-depth)*matWire.length), matWire.length-1);
    visual = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(size,size,size)), matWire[idx]);
  }
  const group  = new THREE.Group();
  const hitBox = new THREE.Mesh(new THREE.BoxGeometry(size*1.3,size*1.3,size*1.3), matHit);
  group.add(visual); group.add(hitBox);
  group.position.set(rng(-18,18), rng(-11,11), z);
  group.rotation.set(rng(0,Math.PI*2), rng(0,Math.PI*2), rng(0,Math.PI*2));
  scene.add(group);
  const s=speed/Math.max(0.3,Math.sqrt(size)), vel=new THREE.Vector3(rng(-s,s),rng(-s,s),0);
  const sr=0.005/Math.max(0.4,size), spin=new THREE.Vector3(rng(-sr,sr),rng(-sr,sr),rng(-sr*.7,sr*.7));
  const data={obj:group,vel,spin,size,collide};
  cubes.push(data); hitBoxes.push(hitBox); hitToCube.set(hitBox,data);
}
for (const zone of ZONES) for (let i=0;i<zone.count;i++) spawnCube(zone);
const collidables = cubes.filter(c=>c.collide);

// ── インタラクション ───────────────────────────────────────────────────────
const raycaster=new THREE.Raycaster(), mouse=new THREE.Vector2();
const grabPlane=new THREE.Plane(), grabOffset=new THREE.Vector3(), tmpVec=new THREE.Vector3();
let grabbed=null;
const HIST=6, dragHist=[];

function toNDC(cx,cy) { mouse.set((cx/innerWidth)*2-1, -(cy/innerHeight)*2+1); }

function onDown(cx,cy) {
  toNDC(cx,cy); raycaster.setFromCamera(mouse,camera);
  const hits=raycaster.intersectObjects(hitBoxes);
  if (!hits.length) return;
  grabbed=hitToCube.get(hits[0].object);
  if (!grabbed) return;
  grabbed.vel.set(0,0,0);
  camera.getWorldDirection(tmpVec);
  grabPlane.setFromNormalAndCoplanarPoint(tmpVec, grabbed.obj.position);
  raycaster.ray.intersectPlane(grabPlane, tmpVec);
  grabOffset.subVectors(grabbed.obj.position, tmpVec);
  dragHist.length=0;
  dragHist.push({x:grabbed.obj.position.x, y:grabbed.obj.position.y, t:performance.now()});
  canvas.style.cursor='grabbing';
}

function onMove(cx,cy) {
  toNDC(cx,cy);
  if (!grabbed) {
    raycaster.setFromCamera(mouse,camera);
    canvas.style.cursor = raycaster.intersectObjects(hitBoxes).length ? 'grab' : 'default';
    return;
  }
  raycaster.setFromCamera(mouse,camera);
  if (raycaster.ray.intersectPlane(grabPlane,tmpVec)) {
    grabbed.obj.position.copy(tmpVec.add(grabOffset));
    dragHist.push({x:grabbed.obj.position.x, y:grabbed.obj.position.y, t:performance.now()});
    if (dragHist.length>HIST) dragHist.shift();
  }
}

function onUp() {
  if (!grabbed) return;
  if (dragHist.length>=2) {
    const h=dragHist[dragHist.length-1], tl=dragHist[0], dt=h.t-tl.t;
    if (dt>4) {
      grabbed.vel.x=(h.x-tl.x)/dt*16; grabbed.vel.y=(h.y-tl.y)/dt*16;
      const MV=0.28, spd=Math.sqrt(grabbed.vel.x**2+grabbed.vel.y**2);
      if (spd>MV) { grabbed.vel.x*=MV/spd; grabbed.vel.y*=MV/spd; }
    }
  }
  grabbed=null; dragHist.length=0; canvas.style.cursor='default';
}

canvas.addEventListener('mousedown',  e=>onDown(e.clientX,e.clientY));
canvas.addEventListener('mousemove',  e=>onMove(e.clientX,e.clientY));
canvas.addEventListener('mouseup',    onUp);
canvas.addEventListener('mouseleave', onUp);

canvas.addEventListener('touchstart', e=>{
  const t=e.touches[0]; toNDC(t.clientX,t.clientY); raycaster.setFromCamera(mouse,camera);
  if (raycaster.intersectObjects(hitBoxes).length) { e.preventDefault(); onDown(t.clientX,t.clientY); }
}, {passive:false});
canvas.addEventListener('touchmove', e=>{
  if (!grabbed) return; e.preventDefault(); onMove(e.touches[0].clientX,e.touches[0].clientY);
}, {passive:false});
canvas.addEventListener('touchend', e=>{ e.preventDefault(); onUp(); }, {passive:false});

window.addEventListener('resize', ()=>{
  renderer.setSize(innerWidth,innerHeight);
  camera.aspect=innerWidth/innerHeight;
  camera.updateProjectionMatrix();
});

// ── 物理 / 描画ループ ────────────────────────────────────────────────────
const REPULSION=0.0006, DAMPING=0.97, BX=20, BY=13, BOUNCE=0.03;

function tick() {
  requestAnimationFrame(tick);

  for (let i=0;i<collidables.length;i++) {
    const a=collidables[i]; if (a===grabbed) continue;
    for (let j=i+1;j<collidables.length;j++) {
      const b=collidables[j]; if (b===grabbed) continue;
      const dx=b.obj.position.x-a.obj.position.x, dy=b.obj.position.y-a.obj.position.y;
      const dSq=dx*dx+dy*dy, minD=(a.size+b.size)*0.55;
      if (dSq<minD*minD && dSq>0.0001) {
        const d=Math.sqrt(dSq), f=(minD-d)/minD*REPULSION, nx=dx/d*f, ny=dy/d*f;
        a.vel.x-=nx; a.vel.y-=ny; b.vel.x+=nx; b.vel.y+=ny;
      }
    }
  }

  for (const c of cubes) {
    c.obj.rotation.x+=c.spin.x; c.obj.rotation.y+=c.spin.y; c.obj.rotation.z+=c.spin.z;
    if (c===grabbed) continue;
    c.vel.x*=DAMPING; c.vel.y*=DAMPING;
    c.obj.position.x+=c.vel.x; c.obj.position.y+=c.vel.y;
    const spd=Math.sqrt(c.vel.x**2+c.vel.y**2);
    if (spd>BOUNCE) {
      if (Math.abs(c.obj.position.x)>BX){c.obj.position.x=Math.sign(c.obj.position.x)*BX;c.vel.x*=-0.65;}
      if (Math.abs(c.obj.position.y)>BY){c.obj.position.y=Math.sign(c.obj.position.y)*BY;c.vel.y*=-0.65;}
    } else {
      if (c.obj.position.x> BX) c.obj.position.x=-BX;
      if (c.obj.position.x<-BX) c.obj.position.x= BX;
      if (c.obj.position.y> BY) c.obj.position.y=-BY;
      if (c.obj.position.y<-BY) c.obj.position.y= BY;
    }
  }

  renderer.render(scene,camera);
}
tick();
