'use strict';

// Sample the same triangles rendered on screen, including blended LOD edges.
function gameGround(view, x, z) {
  const mesh=view.mesh, model=view.model;
  if (!mesh || !model || Math.abs(x)>1 || Math.abs(z)>1) return null;
  const levels=[model,...(model.patches || [])];
  let level=0;
  for(let i=1;i<levels.length;i++) {
    const extent=levels[i].radius/model.radius;
    if(Math.max(Math.abs(x),Math.abs(z))<=extent) level=i;
  }
  const n=mesh.n, extent=levels[level].radius/model.radius;
  const gx=(x/extent+1)*(n-1)/2,gz=(z/extent+1)*(n-1)/2;
  const ix=Math.min(n-2,Math.max(0,Math.floor(gx))),iz=Math.min(n-2,Math.max(0,Math.floor(gz)));
  const tx=gx-ix,tz=gz-iz,h=(a,b)=>mesh.vertices[(level*n*n+b*n+a)*5+1]*model.radius;
  return tx+tz<=1 ? h(ix,iz)+(h(ix+1,iz)-h(ix,iz))*tx+(h(ix,iz+1)-h(ix,iz))*tz
    : h(ix+1,iz+1)+(h(ix,iz+1)-h(ix+1,iz+1))*(1-tx)+(h(ix+1,iz)-h(ix+1,iz+1))*(1-tz);
}

// The ray is linear between grid edges and triangle diagonals. Splitting at
// every crossing finds the first surface hit without stepping over thin ridges.
function gameRaycast(view, origin, direction) {
  let end=4;
  for(const axis of [0,2]) {
    if(Math.abs(origin[axis])>1)return null;
    if(Math.abs(direction[axis])>1e-12)
      end=Math.min(end,((direction[axis]>0?1:-1)-origin[axis])/direction[axis]);
  }
  if(end<=0)return null;
  const cuts=[0,end],n=view.mesh.n;
  for(const level of [view.model,...(view.model.patches||[])]) {
    const extent=level.radius/view.model.radius,step=2*extent/(n-1);
    for(const [o,d,count,start] of [[origin[0],direction[0],n,-extent],
      [origin[2],direction[2],n,-extent],
      [origin[0]+origin[2],direction[0]+direction[2],2*n-1,-2*extent]]) {
      if(Math.abs(d)<1e-12)continue;
      for(let i=0;i<count;i++){const t=(start+i*step-o)/d;if(t>0&&t<end)cuts.push(t);}
    }
  }
  cuts.sort((a,b)=>a-b);
  const at=t=>origin.map((v,i)=>v+direction[i]*t);
  const gap=t=>{const p=at(t);return p[1]-gameGround(view,
    Math.max(-1,Math.min(1,p[0])),Math.max(-1,Math.min(1,p[2])))/view.model.radius;};
  let previous=0,height=gap(0);
  if(height<=0)return at(0);
  for(const t of cuts) {
    const next=gap(t);
    if(next<=0) return at(previous+(t-previous)*height/(height-next));
    previous=t;height=next;
  }
  return null;
}

class TerrainGame {
  constructor(view) {
    this.view=view;this.active=false;this.keys=new Set();this.pointers=new Map();
    this.yaw=0;this.tilt=.24;this.followDistance=20;this.phase=0;this.speed=0;this.flying=false;this.speedMultiplier=10;
    this.bind();
  }
  start(position, bearing=0) {
    const point=terrainPoint(this.view.model,{...position,elev:0});
    const ground=gameGround(this.view,point[0],point[2]);
    if(ground===null) throw new Error('Map the current location before starting Game.');
    this.position=[point[0],ground/this.view.model.radius,point[2]];
    this.spawn=[...this.position];this.yaw=-bearing*Math.PI/180;this.heading=this.yaw;
    this.tilt=.24;this.followDistance=20;this.phase=0;this.speed=0;this.velocityY=0;
    this.flying=false;this.targetPlaced=false;this.active=true;this.lastTime=null;this.clearInput();this.view.dirty=true;
  }
  stop() { this.active=false;this.clearInput();this.lastTime=null; }
  clearInput() { this.keys.clear();this.pointers.clear();this.stick={x:0,y:0};this.resetStick?.(); }
  reset() { this.position=[...this.spawn];this.flying=false;this.velocityY=0;this.clearInput(); }
  targetDestination(point) {
    if(!point || ![point.lat,point.lon,point.elev].every(Number.isFinite))return null;
    const position=terrainPoint(this.view.model,point);
    const ground=gameGround(this.view,position[0],position[2]);
    if(ground===null)return null;
    position[1]=Math.max(ground,point.elev)/this.view.model.radius;
    return {position,flying:point.elev>ground+.1};
  }
  goToTarget(point) {
    const destination=this.targetDestination(point);
    if(!destination)return false;
    this.position=destination.position;this.flying=destination.flying;
    const dx=this.spawn[0]-this.position[0],dz=this.spawn[2]-this.position[2];
    if(Math.hypot(dx,dz)*this.view.model.radius>.01)
      this.yaw=Math.atan2(-dx,-dz);
    this.heading=this.yaw;this.tilt=.24;
    this.velocityY=0;this.speed=0;this.phase=0;this.lastTime=null;
    this.clearInput();this.view.dirty=true;
    return true;
  }
  tick(time) {
    if(!this.active || !this.view.model) return;
    const dt=this.lastTime==null ? 0 : Math.max(0,Math.min(.25,(time-this.lastTime)/1000));
    this.lastTime=time;
    const steps=Math.max(1,Math.ceil(dt*120));
    for(let i=0;i<steps;i++)this.step(dt/steps);
    this.view.dirty=true;
  }
  step(dt) {
    const radius=this.view.model.radius,keys=this.keys;
    let right=Number(keys.has('d')||keys.has('arrowright'))-Number(keys.has('a')||keys.has('arrowleft'));
    let forward=Number(keys.has('w')||keys.has('arrowup'))-Number(keys.has('s')||keys.has('arrowdown'));
    right+=this.stick?.x || 0;forward+=this.stick?.y || 0;
    let rise=Number(keys.has('e')||keys.has(' '))-Number(keys.has('q')||keys.has('control'));
    if(rise>0){this.flying=true;this.velocityY=0;}
    if(!this.flying)rise=0;
    const length=Math.hypot(right,forward,rise);
    if(length>1){right/=length;forward/=length;rise/=length;}
    const speed=(this.flying ? (keys.has('shift')?24:12) : (keys.has('shift')?5.5:3))*(this.speedMultiplier ?? 1);
    const dx=(right*Math.cos(this.yaw)-forward*Math.sin(this.yaw))*speed*dt;
    const dz=(-right*Math.sin(this.yaw)-forward*Math.cos(this.yaw))*speed*dt;
    const x=this.position[0]+dx/radius,z=this.position[2]+dz/radius;
    const ground=gameGround(this.view,x,z),oldGround=gameGround(this.view,this.position[0],this.position[2]);
    const oldX=this.position[0],oldZ=this.position[2];
    // Stay inside the mapped square; steep uphill faces require flight.
    if(ground!==null && (this.flying || ground-oldGround<=Math.hypot(dx,dz)*1.2+.002)) {
      this.position[0]=x;this.position[2]=z;
    }
    const floor=gameGround(this.view,this.position[0],this.position[2]);
    if(this.flying) {
      this.position[1]=Math.min((floor+5000)/radius,Math.max(floor/radius,this.position[1]+rise*speed*dt/radius));
      if(rise<=0 && this.position[1]*radius<=floor+1e-6) {
        this.position[1]=floor/radius;this.flying=false;this.velocityY=0;
      }
    }
    else {
      this.velocityY-=9.81*dt;
      this.position[1]+=this.velocityY*dt/radius;
      if(this.position[1]*radius<=floor+.05){this.position[1]=floor/radius;this.velocityY=0;}
    }
    const moved=Math.hypot(this.position[0]-oldX,this.position[2]-oldZ)*radius;
    this.speed=dt>0?moved/dt:0;
    if(moved>1e-8){this.heading=Math.atan2(-dx,-dz);this.phase+=moved*4;}
  }
  camera() {
    const radius=this.view.model.radius,target=[...this.position];target[1]+=1.25/radius;
    const offset=[Math.cos(this.tilt)*Math.sin(this.yaw),Math.sin(this.tilt),Math.cos(this.tilt)*Math.cos(this.yaw)];
    let eye=target.map((v,i)=>v+offset[i]*this.followDistance/radius);
    // Shorten the camera boom before it crosses terrain, rather than seeing
    // through the back of a hillside. Heights are in metres above local ground.
    for(let i=1;i<=24;i++) {
      const p=target.map((v,j)=>v+(eye[j]-v)*i/24),floor=gameGround(this.view,p[0],p[2]);
      if(floor!==null && p[1]*radius<floor+.25) {
        eye=target.map((v,j)=>v+(eye[j]-v)*Math.max(0,(i-1)/24));break;
      }
    }
    const forward=target.map((v,i)=>v-eye[i]),length=Math.hypot(...forward);
    if(length<.1/radius){eye=[target[0],target[1]+1/radius,target[2]+.5/radius];forward.splice(0,3,0,-1/radius,-.5/radius);}
    const norm=Math.hypot(...forward);for(let i=0;i<3;i++)forward[i]/=norm;
    const right=[-forward[2],0,forward[0]],rn=Math.hypot(...right);for(let i=0;i<3;i++)right[i]/=rn;
    const up=[right[1]*forward[2]-right[2]*forward[1],right[2]*forward[0]-right[0]*forward[2],right[0]*forward[1]-right[1]*forward[0]];
    return {eye,right,up,forward,focal:1/Math.tan(Math.PI/6),near:.05/radius,far:Math.max(4,eye[1]+4),halfHeight:0,groundElevation:gameGround(this.view,this.position[0],this.position[2])};
  }
  laser() {
    const camera=this.camera(),radius=this.view.model.radius;
    const origin=this.position.map((v,i)=>v+camera.right[i]*.32/radius);
    origin[1]+=1.4/radius;
    // Aim above the avatar so the beam and terrain hit remain visible.
    const direction=camera.forward.map((v,i)=>v+camera.up[i]*.22);
    const length=Math.hypot(...direction);for(let i=0;i<3;i++)direction[i]/=length;
    const hit=gameRaycast(this.view,origin,direction);
    return {origin,hit,end:hit||origin.map((v,i)=>v+direction[i]*2)};
  }
  bind() {
    const canvas=this.view.canvas;
    const consume=e=>{e.preventDefault();e.stopImmediatePropagation();};
    canvas.addEventListener('pointerdown',e=>{
      if(!this.active)return;consume(e);canvas.focus();canvas.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
    },true);
    canvas.addEventListener('pointermove',e=>{
      if(!this.active)return;consume(e);const p=this.pointers.get(e.pointerId);if(!p)return;
      this.yaw-=(e.clientX-p.x)*.006;this.tilt=Math.max(-.15,Math.min(1.2,this.tilt+(e.clientY-p.y)*.006));
      this.pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
    },true);
    for(const type of ['pointerup','pointercancel','lostpointercapture'])canvas.addEventListener(type,e=>{
      if(!this.active)return;consume(e);this.pointers.delete(e.pointerId);
      if(canvas.hasPointerCapture(e.pointerId))canvas.releasePointerCapture(e.pointerId);
    },true);
    canvas.addEventListener('wheel',e=>{
      if(!this.active)return;consume(e);this.followDistance=Math.max(3,Math.min(100,this.followDistance*Math.exp(e.deltaY*.001)));
    },{capture:true,passive:false});
    const controls=new Set(['w','a','s','d','arrowup','arrowdown','arrowleft','arrowright','shift','control',' ','e','q']);
    window.addEventListener('keydown',e=>{
      if(!this.active || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName))return;
      if(e.key==='Escape'){consume(e);this.onExit?.();return;}
      const key=e.key.toLowerCase();if(!controls.has(key))return;consume(e);
      this.keys.add(key);
    },true);
    window.addEventListener('keyup',e=>{if(this.active)this.keys.delete(e.key.toLowerCase());},true);
    window.addEventListener('blur',()=>this.clearInput());
    document.addEventListener('visibilitychange',()=>{if(document.hidden){this.clearInput();this.lastTime=null;}});
  }
}

// Articulated, 1.78 metre human mesh: head, neck, torso, pelvis, arms,
// hands, legs and shoes. Dimensions are world metres, never screen pixels.
function gameAvatar(game, radius) {
  const vertices=[],skin=[.78,.52,.35],shirt=[.12,.55,.9],pants=[.12,.17,.23],shoe=[.06,.07,.09];
  const swing=game.flying?0:Math.sin(game.phase)*Math.min(1,game.speed/3)*.65;
  const rotate=(p,angle)=>[p[0],p[1]*Math.cos(angle)-p[2]*Math.sin(angle),p[1]*Math.sin(angle)+p[2]*Math.cos(angle)];
  const transform=(p,pivot,angle)=>{
    if(pivot)p=rotate(p.map((v,j)=>v-pivot[j]),angle).map((v,j)=>v+pivot[j]);
    const x=p[0]*Math.cos(game.heading)+p[2]*Math.sin(game.heading),z=-p[0]*Math.sin(game.heading)+p[2]*Math.cos(game.heading);
    return [game.position[0]+x/radius,game.position[1]+p[1]/radius,game.position[2]+z/radius];
  };
  const triangle=(a,b,c,color)=>{
    const u=b.map((v,i)=>v-a[i]),v=c.map((v,i)=>v-a[i]);
    const n=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]],length=Math.hypot(...n)||1;
    for(const p of [a,b,c])vertices.push(...p,...color,...n.map(x=>x/length));
  };
  const box=(center,size,color,pivot=null,angle=0)=>{
    const corners=[];
    for(let i=0;i<8;i++)corners.push(transform(center.map((v,j)=>v+((i>>j&1)?1:-1)*size[j]/2),pivot,angle));
    for(const face of [[0,1,3,2],[4,6,7,5],[0,4,5,1],[2,3,7,6],[0,2,6,4],[1,5,7,3]]) {
      triangle(corners[face[0]],corners[face[2]],corners[face[1]],color);
      triangle(corners[face[0]],corners[face[3]],corners[face[2]],color);
    }
  };
  const oval=(center,size,color,pivot=null,angle=0)=>{
    const rings=8,sides=12;
    const at=(r,s)=>transform([center[0]+size[0]/2*Math.sin(r*Math.PI/rings)*Math.cos(s*2*Math.PI/sides),
      center[1]+size[1]/2*Math.cos(r*Math.PI/rings),center[2]+size[2]/2*Math.sin(r*Math.PI/rings)*Math.sin(s*2*Math.PI/sides)],pivot,angle);
    for(let r=0;r<rings;r++)for(let s=0;s<sides;s++){
      const a=at(r,s),b=at(r+1,s),c=at(r+1,s+1),d=at(r,s+1);
      triangle(a,c,b,color);triangle(a,d,c,color);
    }
  };
  oval([0,1.27,0],[.46,.57,.27],shirt);oval([0,.95,0],[.35,.28,.25],pants);
  oval([0,1.53,0],[.12,.15,.12],skin);oval([0,1.655,-.015],[.23,.25,.235],skin);
  oval([0,1.75,.005],[.225,.07,.215],[.12,.08,.055]);
  oval([0,1.66,-.135],[.045,.065,.05],skin);
  for(const side of [-1,1]) {
    oval([side*.045,1.705,-.115],[.018,.014,.009],[.06,.05,.04]);
    const hip=[side*.10,.96,0],shoulder=[side*.255,1.46,0];
    oval([side*.10,.57,0],[.165,.80,.185],pants,hip,side*swing);
    box([side*.10,.09,-.05],[.16,.13,.29],shoe,hip,side*swing);
    oval([side*.265,1.20,0],[.15,.56,.155],shirt,shoulder,-side*swing);
    oval([side*.27,.90,0],[.11,.16,.095],skin,shoulder,-side*swing);
  }
  return new Float32Array(vertices);
}

function gameTarget(game, observerAltitude, refraction=.13, position=game.position) {
  const model=game.view.model,size=256*2**model.z;
  const lat=180/Math.PI*Math.atan(Math.sinh(Math.PI*(1-2*(model.cy+position[2]*model.half)/size)));
  const lon=(((model.cx+position[0]*model.half)/size*360)%360+360)%360-180;
  const lat0=model.lat0 ?? 180/Math.PI*Math.atan(Math.sinh(Math.PI*(1-2*model.cy/size)));
  const lon0=model.lon0 ?? model.cx/size*360-180;
  const rad=Math.PI/180,a=lat0*rad,b=lat*rad,delta=(lon-lon0)*rad;
  const h=Math.sin((b-a)/2)**2+Math.cos(a)*Math.cos(b)*Math.sin(delta/2)**2;
  const dist=2*6371008.8*Math.asin(Math.min(1,Math.sqrt(h))),elev=position[1]*model.radius;
  const bearing=(Math.atan2(Math.sin(delta)*Math.cos(b),Math.cos(a)*Math.sin(b)-Math.sin(a)*Math.cos(b)*Math.cos(delta))/rad+360)%360;
  const drop=dist*dist*(1-refraction)/(2*6371008.8);
  return {bearing,point:{lat,lon,dist,elev,ang:Math.atan2(elev-observerAltitude-drop,dist)/rad,z:model.z}};
}
if(typeof module!=='undefined')module.exports={gameRaycast,gameGround,gameAvatar,gameTarget,TerrainGame};


// A single captured pointer drives movement independently of camera-look touches.
function bindGameStick(element,getGame) {
  let pointer=null,activeGame=null;
  const thumb=element.querySelector('.game-stick-thumb');
  const reset=()=>{
    const id=pointer;pointer=null;
    if(activeGame)activeGame.stick={x:0,y:0};
    activeGame=null;
    thumb.style.transform='translate(0px, 0px)';
    if(id!==null&&element.hasPointerCapture(id)) {
      try{element.releasePointerCapture(id);}catch{}
    }
  };
  const move=event=>{
    if(event.pointerId!==pointer)return;
    // Browsers can omit pointerup after a gesture interruption. A mouse move
    // with no held button is definitive evidence that the drag has ended.
    if(event.pointerType==='mouse'&&event.buttons===0){reset();return;}
    event.preventDefault();
    const rect=element.getBoundingClientRect(),travel=rect.width*.3;
    const dx=event.clientX-rect.left-rect.width/2,dy=event.clientY-rect.top-rect.height/2;
    const length=Math.hypot(dx,dy),magnitude=Math.min(1,length/travel);
    const x=length?dx/length:0,y=length?dy/length:0;
    const strength=Math.max(0,(magnitude-.08)/.92);
    activeGame.stick={x:x*strength,y:-y*strength};
    thumb.style.transform='translate('+x*magnitude*travel+'px, '+y*magnitude*travel+'px)';
  };
  element.addEventListener('pointerdown',event=>{
    if(pointer!==null || (event.pointerType==='mouse'&&event.button!==0))return;
    const game=getGame();if(!game?.active)return;
    event.preventDefault();activeGame=game;game.resetStick=reset;
    pointer=event.pointerId;
    try{element.setPointerCapture(pointer);}catch{}
    move(event);
  });
  element.addEventListener('pointermove',move);
  const finish=event=>{if(event.pointerId===pointer){event.preventDefault();reset();}};
  element.addEventListener('lostpointercapture',finish);
  // Capture releases globally as well as on the element. This covers iOS
  // gesture cancellation, controls moving during rotation, and DOM changes.
  for(const type of ['pointerup','pointercancel'])window.addEventListener(type,finish,true);
  window.addEventListener('blur',reset);
  window.addEventListener('pagehide',reset);
  document.addEventListener('visibilitychange',()=>{if(document.hidden)reset();});
}
