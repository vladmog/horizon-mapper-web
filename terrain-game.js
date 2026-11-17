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
    this.yaw=0;this.tilt=.24;this.phase=0;this.speed=0;this.flying=false;this.speedMultiplier=10;
    this.bind();
  }
  start(position, bearing=0) {
    const point=terrainPoint(this.view.model,{...position,elev:0});
    const ground=gameGround(this.view,point[0],point[2]);
    if(ground===null) throw new Error('Map the current location before starting Game.');
    this.position=[point[0],ground/this.view.model.radius,point[2]];
    this.spawn=[...this.position];this.yaw=-bearing*Math.PI/180;this.heading=this.yaw;
    this.tilt=.24;this.phase=0;this.speed=0;this.velocityY=0;
    this.flying=false;this.targetPlaced=false;this.active=true;this.lastTime=null;this.clearInput();this.view.dirty=true;
  }
  stop() { this.active=false;this.clearInput();this.lastTime=null; }
  clearInput() { this.keys.clear();this.pointers.clear();this.stick={x:0,y:0};this.lookStick={x:0,y:0};this.resetStick?.();this.resetLookStick?.(); }
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
    this.yaw-=(this.lookStick?.x || 0)*1.6*dt;
    this.tilt=Math.max(-1.45,Math.min(1.45,this.tilt-(this.lookStick?.y || 0)*1.3*dt));
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
    const radius=this.view.model.radius;
    const eye=[this.position[0],this.position[1]+1.65/radius,this.position[2]];
    const forward=[-Math.sin(this.yaw)*Math.cos(this.tilt),-Math.sin(this.tilt),-Math.cos(this.yaw)*Math.cos(this.tilt)];
    const right=[Math.cos(this.yaw),0,-Math.sin(this.yaw)];
    const up=[right[1]*forward[2]-right[2]*forward[1],right[2]*forward[0]-right[0]*forward[2],right[0]*forward[1]-right[1]*forward[0]];
    const width=this.view.canvas?.clientWidth || 0,height=this.view.canvas?.clientHeight || 0;
    // Keep a 60-degree horizontal view on portrait phones instead of cropping
    // the landscape camera down to a narrow slice. Landscape stays unchanged.
    const portrait=width>0 && width<=900 && height>width;
    const focal=(portrait ? width/height : 1)/Math.tan(Math.PI/6);
    return {eye,right,up,forward,focal,near:.05/radius,far:Math.max(4,eye[1]+4),halfHeight:0,groundElevation:gameGround(this.view,this.position[0],this.position[2])};
  }
  laser() {
    const camera=this.camera(),radius=this.view.model.radius;
    const aspect=(this.view.canvas?.clientWidth || 1)/(this.view.canvas?.clientHeight || 1);
    const key=[...this.position,this.yaw,this.tilt,camera.focal,aspect].join('/');
    if(this.laserCache?.key===key && this.laserCache.mesh===this.view.mesh)return this.laserCache.value;
    const aim=gameRaycast(this.view,camera.eye,camera.forward) || camera.eye.map((v,i)=>v+camera.forward[i]*3);
    // The emitter stays visible at the lower left and converges on the crosshair.
    const depth=.6,side=-.22*depth*aspect/camera.focal,down=-.34*depth/camera.focal;
    const origin=camera.eye.map((v,i)=>v+(camera.right[i]*side+camera.up[i]*down+camera.forward[i]*depth)/radius);
    const delta=aim.map((v,i)=>v-origin[i]),length=Math.hypot(...delta);
    const direction=delta.map(v=>v/length);
    const hit=gameRaycast(this.view,origin,direction);
    const value={origin,hit,end:hit||origin.map((v,i)=>v+direction[i]*3),direction,camera};
    this.laserCache={key,mesh:this.view.mesh,value};
    return value;
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
      this.yaw-=(e.clientX-p.x)*.006;this.tilt=Math.max(-1.45,Math.min(1.45,this.tilt+(e.clientY-p.y)*.006));
      this.pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
    },true);
    for(const type of ['pointerup','pointercancel','lostpointercapture'])canvas.addEventListener(type,e=>{
      if(!this.active)return;consume(e);this.pointers.delete(e.pointerId);
      if(canvas.hasPointerCapture(e.pointerId))canvas.releasePointerCapture(e.pointerId);
    },true);
    canvas.addEventListener('wheel',e=>{
      if(this.active)consume(e);
    },{capture:true,passive:false});
    const controls=new Set(['w','a','s','d','arrowup','arrowdown','arrowleft','arrowright','shift','control',' ','e','q']);
    window.addEventListener('keydown',e=>{
      if(!this.active || /INPUT|TEXTAREA|SELECT|SUMMARY|BUTTON/.test(e.target.tagName))return;
      if(e.key==='Escape'){consume(e);this.onExit?.();return;}
      const key=e.key.toLowerCase();if(!controls.has(key))return;consume(e);
      this.keys.add(key);
    },true);
    window.addEventListener('keyup',e=>{if(this.active)this.keys.delete(e.key.toLowerCase());},true);
    window.addEventListener('blur',()=>this.clearInput());
    document.addEventListener('visibilitychange',()=>{if(document.hidden){this.clearInput();this.lastTime=null;}});
  }
}

// Camera-relative handheld laser tool and gloved hands, in world metres.
function gameLaserTool(game, radius) {
  const laser=game.laser(),forward=laser.direction,vertices=[];
  let right=[forward[1]*laser.camera.up[2]-forward[2]*laser.camera.up[1],forward[2]*laser.camera.up[0]-forward[0]*laser.camera.up[2],forward[0]*laser.camera.up[1]-forward[1]*laser.camera.up[0]];
  const length=Math.hypot(...right);right=right.map(v=>v/length);
  const up=[right[1]*forward[2]-right[2]*forward[1],right[2]*forward[0]-right[0]*forward[2],right[0]*forward[1]-right[1]*forward[0]];
  const transform=p=>laser.origin.map((v,i)=>v+(right[i]*p[0]+up[i]*p[1]+forward[i]*p[2])/radius);
  const triangle=(a,b,c,color)=>{
    const u=b.map((v,i)=>v-a[i]),v=c.map((v,i)=>v-a[i]);
    const n=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]],length=Math.hypot(...n)||1;
    for(const p of [a,b,c])vertices.push(...p,...color,...n.map(x=>x/length));
  };
  const box=(center,size,color)=>{
    const corners=[];
    for(let i=0;i<8;i++)corners.push(transform(center.map((v,j)=>v+((i>>j&1)?1:-1)*size[j]/2)));
    for(const face of [[0,1,3,2],[4,6,7,5],[0,4,5,1],[2,3,7,6],[0,2,6,4],[1,5,7,3]]) {
      triangle(corners[face[0]],corners[face[2]],corners[face[1]],color);
      triangle(corners[face[0]],corners[face[3]],corners[face[2]],color);
    }
  };
  const glove=(center,size)=>{
    const rings=6,sides=10;
    const at=(r,s)=>transform([center[0]+size[0]/2*Math.sin(r*Math.PI/rings)*Math.cos(s*2*Math.PI/sides),
      center[1]+size[1]/2*Math.cos(r*Math.PI/rings),center[2]+size[2]/2*Math.sin(r*Math.PI/rings)*Math.sin(s*2*Math.PI/sides)]);
    for(let r=0;r<rings;r++)for(let s=0;s<sides;s++) {
      const a=at(r,s),b=at(r+1,s),c=at(r+1,s+1),d=at(r,s+1);
      triangle(a,c,b,[.57,.57,.55]);triangle(a,d,c,[.57,.57,.55]);
    }
  };
  box([0,-.005,-.12],[.075,.075,.25],[.32,.34,.36]); // barrel
  box([0,-.04,-.23],[.105,.12,.15],[.18,.19,.20]); // body
  box([0,-.13,-.25],[.07,.16,.09],[.11,.12,.13]); // grip
  box([0,.045,-.2],[.025,.025,.055],[.65,.65,.65]); // sight
  glove([0,-.15,-.24],[.11,.12,.12]); // gripping glove
  box([.015,-.27,-.32],[.13,.20,.19],[.21,.22,.23]); // sleeve
  glove([-.065,-.065,-.105],[.085,.07,.13]); // supporting hand
  box([-.1,-.13,-.17],[.10,.14,.13],[.21,.22,.23]);
  box([0,.012,.012],[.022,.022,.018],[1,.08,.04]); // lit emitter
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
if(typeof module!=='undefined')module.exports={gameRaycast,gameGround,gameLaserTool,gameTarget,TerrainGame};


// A single captured pointer drives movement independently of camera-look touches.
function bindGameStick(element,getGame,kind='move') {
  const field=kind==='look'?'lookStick':'stick',resetField=kind==='look'?'resetLookStick':'resetStick';
  let pointer=null,activeGame=null;
  const thumb=element.querySelector('.game-stick-thumb');
  const reset=()=>{
    const id=pointer;pointer=null;
    if(activeGame)activeGame[field]={x:0,y:0};
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
    activeGame[field]={x:x*strength,y:-y*strength};
    thumb.style.transform='translate('+x*magnitude*travel+'px, '+y*magnitude*travel+'px)';
  };
  element.addEventListener('pointerdown',event=>{
    if(pointer!==null || (event.pointerType==='mouse'&&event.button!==0))return;
    const game=getGame();if(!game?.active)return;
    event.preventDefault();activeGame=game;game[resetField]=reset;
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
  window.addEventListener('resize',reset);
  window.addEventListener('pagehide',reset);
  document.addEventListener('visibilitychange',()=>{if(document.hidden)reset();});
}
