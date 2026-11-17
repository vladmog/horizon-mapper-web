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

// The ground is linear between grid and triangle crossings. A concave arc
// above every crossing also clears the entire terrain segment between them.
function gameFlightPlan(view, from, to) {
  if (!view.model || !view.mesh || [...from,...to].some(v=>!Number.isFinite(v)) ||
      [from,to].some(p=>Math.max(Math.abs(p[0]),Math.abs(p[2]))>1))return null;
  const radius=view.model.radius,delta=to.map((v,i)=>v-from[i]);
  const distance=Math.hypot(...delta)*radius;
  if(distance<.01)return null;
  const cuts=[0,1],n=view.mesh.n;
  for(const level of [view.model,...(view.model.patches||[])]) {
    const extent=level.radius/radius,step=2*extent/(n-1);
    for(const [origin,direction,count,start] of [[from[0],delta[0],n,-extent],
      [from[2],delta[2],n,-extent],
      [from[0]+from[2],delta[0]+delta[2],2*n-1,-2*extent]]) {
      if(Math.abs(direction)<1e-12)continue;
      for(let i=0;i<count;i++) {
        const t=(start+i*step-origin)/direction;
        if(t>0 && t<1)cuts.push(t);
      }
    }
  }
  const horizontal=Math.hypot(delta[0],delta[2])*radius;
  const clearance=Math.min(30,Math.max(1.5,horizontal*.015))/radius;
  let lift=horizontal>.01?Math.min(400,Math.max(1.5,horizontal*.04))/radius:0;
  for(const t of cuts) {
    if(t<=0 || t>=1)continue;
    const ground=gameGround(view,from[0]+delta[0]*t,from[2]+delta[2]*t)/radius;
    const base=from[1]+delta[1]*t;
    lift=Math.max(lift,(ground-base)/(4*t*(1-t))+clearance);
  }
  const duration=Math.max(.8,Math.min(4,.65+Math.sqrt(distance+2*lift*radius)/45));
  return {from:[...from],to:[...to],lift,duration};
}

class TerrainGame {
  constructor(view) {
    this.view=view;this.active=false;this.keys=new Set();this.pointers=new Map();
    this.thirdPerson=false;this.yaw=0;this.tilt=.24;this.phase=0;this.speed=0;this.flying=false;this.speedMultiplier=25;
    this.bind();
  }
  start(position, bearing=0, camera=null) {
    const point=camera ? camera.eye : terrainPoint(this.view.model,{...position,elev:0});
    const ground=gameGround(this.view,point[0],point[2]);
    if(ground===null) throw new Error('Map the current location before starting Game.');
    const radius=this.view.model.radius;
    // Camera altitude is eye level; physics tracks the avatar's feet.
    this.position=[point[0],Math.max(ground,camera ? camera.eye[1]*radius-1.65 : ground)/radius,point[2]];
    this.yaw=camera ? Math.atan2(-camera.forward[0],-camera.forward[2]) : -bearing*Math.PI/180;
    this.tilt=camera ? -Math.asin(Math.max(-1,Math.min(1,camera.forward[1]))) : .24;
    this.horizontalFov=camera?.horizontalFov ?? null;
    if(camera)this.thirdPerson=false;
    this.flying=this.position[1]*radius>ground+.05;
    this.spawn=[...this.position];this.spawnFlying=this.flying;this.heading=this.yaw;
    this.phase=0;this.speed=0;this.velocityY=0;
    window.getSelection?.()?.removeAllRanges();
    this.flight=null;this.targetPlaced=false;this.active=true;this.lastTime=null;this.clearInput();this.view.dirty=true;
  }
  stop() { this.flight=null;this.active=false;this.clearInput();this.lastTime=null; }
  clearInput() { this.keys.clear();this.pointers.clear();this.stick={x:0,y:0};this.resetStick?.();this.resetLook?.(); }
  relativeToStart() {
    const radius=this.view.model.radius;
    const east=(this.position[0]-this.spawn[0])*radius,north=(this.spawn[2]-this.position[2])*radius;
    const distance=Math.hypot(east,north);
    return {distance,bearing:distance<.5?null:(Math.atan2(east,north)*180/Math.PI+360)%360,
      height:(this.position[1]-this.spawn[1])*radius};
  }
  reset() { return this.beginFlight({position:[...this.spawn],flying:this.spawnFlying ?? false},'start'); }
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
    return destination ? this.beginFlight(destination,'target') : false;
  }
  beginFlight(destination,label) {
    const plan=gameFlightPlan(this.view,this.position,destination.position);
    if(!plan) {
      if(this.flight && Math.hypot(...destination.position.map((v,i)=>v-this.position[i]))*this.view.model.radius<.01) {
        this.flight=null;this.position=[...destination.position];this.flying=destination.flying;
        this.velocityY=0;this.speed=0;this.clearInput();this.view.dirty=true;return true;
      }
      return false;
    }
    const dx=plan.to[0]-plan.from[0],dz=plan.to[2]-plan.from[2];
    const yaw=Math.hypot(dx,dz)>1e-10?Math.atan2(-dx,-dz):this.yaw;
    const turn=Math.atan2(Math.sin(yaw-this.yaw),Math.cos(yaw-this.yaw));
    this.flight={...plan,elapsed:0,label,flying:destination.flying,startYaw:this.yaw,turn,startTilt:this.tilt};
    this.clearInput();this.velocityY=0;this.speed=0;this.flying=true;this.lastTime=null;
    this.view.dirty=true;
    return true;
  }
  advanceFlight(dt) {
    const flight=this.flight,old=this.position;
    flight.elapsed=Math.min(flight.duration,flight.elapsed+dt);
    const t=flight.elapsed/flight.duration,u=t*t*(3-2*t);
    this.position=flight.from.map((v,i)=>v+(flight.to[i]-v)*u);
    this.position[1]+=4*u*(1-u)*flight.lift;
    if(!flight.manualLook) {
      const turn=Math.min(1,t/.25),ease=turn*turn*(3-2*turn);
      this.yaw=flight.startYaw+flight.turn*ease;
      this.tilt=flight.startTilt+(.12-flight.startTilt)*ease;
    }
    this.speed=dt>0?Math.hypot(...this.position.map((v,i)=>v-old[i]))*this.view.model.radius/dt:0;
    if(t>=1) {
      this.position=[...flight.to];this.flying=flight.flying;this.flight=null;
      this.velocityY=0;this.speed=0;this.clearInput();
    }
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
    if(this.flight) {
      if(this.pointers.size)this.flight.manualLook=true;
      this.advanceFlight(dt);return;
    }
    let right=Number(keys.has('d')||keys.has('arrowright'))-Number(keys.has('a')||keys.has('arrowleft'));
    let forward=Number(keys.has('w')||keys.has('arrowup'))-Number(keys.has('s')||keys.has('arrowdown'));
    right+=this.stick?.x || 0;forward+=this.stick?.y || 0;
    let rise=Number(keys.has('e')||keys.has(' '))-Number(keys.has('q')||keys.has('control'));
    if(rise>0){this.flying=true;this.velocityY=0;}
    if(!this.flying)rise=0;
    const length=Math.hypot(right,forward,rise);
    if(length>1){right/=length;forward/=length;rise/=length;}
    const speed=(this.flying ? 12 : 3)*(this.speedMultiplier ?? 1);
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
    // Leaving the ground enters flight before gravity can pull the player down.
    // Match the existing 5 cm contact tolerance so tiny surface changes still ground normally.
    if(!this.flying && this.position[1]*radius>floor+.05) {
      this.flying=true;this.velocityY=0;
    }
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
  lookBy(dx,dy) {
    this.yaw-=dx*.006;
    this.tilt=Math.max(-1.45,Math.min(1.45,this.tilt+dy*.006));
    if(this.flight && (dx || dy))this.flight.manualLook=true;
    this.view.dirty=true;
  }
  aimCamera() {
    const radius=this.view.model.radius;
    const eye=[this.position[0],this.position[1]+1.65/radius,this.position[2]];
    const forward=[-Math.sin(this.yaw)*Math.cos(this.tilt),-Math.sin(this.tilt),-Math.cos(this.yaw)*Math.cos(this.tilt)];
    const right=[Math.cos(this.yaw),0,-Math.sin(this.yaw)];
    const up=[right[1]*forward[2]-right[2]*forward[1],right[2]*forward[0]-right[0]*forward[2],right[0]*forward[1]-right[1]*forward[0]];
    const width=this.view.canvas?.clientWidth || 0,height=this.view.canvas?.clientHeight || 0;
    // Keep a 60-degree horizontal view on portrait phones instead of cropping
    // the landscape camera down to a narrow slice. Landscape stays unchanged.
    const portrait=width>0 && width<=900 && height>width;
    const focal=this.horizontalFov
      ? (width/height)/Math.tan(this.horizontalFov*Math.PI/360)
      : (portrait ? width/height : 1)/Math.tan(Math.PI/6);
    return {eye,right,up,forward,focal,near:.05/radius,far:Math.max(4,eye[1]+4),halfHeight:0,groundElevation:gameGround(this.view,this.position[0],this.position[2])};
  }
  camera() {
    if(!this.thirdPerson)return this.aimCamera();
    const camera=this.aimCamera(),radius=this.view.model.radius,target=camera.eye;
    // A shoulder camera at the original follow distance, measured in world metres. The person stays at
    // human scale; only the camera moves. Look along the aim instead of at his head.
    let eye=target.map((v,i)=>v+(-camera.forward[i]*20+camera.right[i]*.8+camera.up[i]*.2)/radius);
    for(let i=1;i<=48;i++) {
      const p=target.map((v,j)=>v+(eye[j]-v)*i/48),floor=gameGround(this.view,p[0],p[2]);
      if(floor!==null && p[1]*radius<floor+.25) {
        eye=target.map((v,j)=>v+(eye[j]-v)*Math.max(0,(i-1)/48));break;
      }
    }
    return {...camera,eye,far:Math.max(4,eye[1]+4)};
  }
  aimScreenPoint() {
    const camera=this.camera(),laser=this.laser(),point=laser.hit || laser.end;
    const delta=point.map((v,i)=>v-camera.eye[i]);
    const dot=axis=>delta.reduce((sum,v,i)=>sum+v*axis[i],0),depth=dot(camera.forward);
    const aspect=(this.view.canvas.clientWidth || 1)/(this.view.canvas.clientHeight || 1);
    const x=50+50*dot(camera.right)*camera.focal/(depth*aspect),y=50-50*dot(camera.up)*camera.focal/depth;
    return {x,y,visible:depth>camera.near && x>=0 && x<=100 && y>=0 && y<=100};
  }

  laser() {
    const camera=this.aimCamera(),radius=this.view.model.radius;
    const aspect=(this.view.canvas?.clientWidth || 1)/(this.view.canvas?.clientHeight || 1);
    const key=[...this.position,this.yaw,this.tilt,camera.focal,aspect,this.thirdPerson].join('/');
    if(this.laserCache?.key===key && this.laserCache.mesh===this.view.mesh)return this.laserCache.value;
    const aim=gameRaycast(this.view,camera.eye,camera.forward) || camera.eye.map((v,i)=>v+camera.forward[i]*3);
    // First person keeps its foreground tool. Third person holds it at the
    // right hand, clear of the body; both converge on the same terrain aim point.
    const depth=this.thirdPerson ? .75 : .6;
    const side=this.thirdPerson ? .38 : -.22*depth*aspect/camera.focal,down=this.thirdPerson ? -.08 : -.34*depth/camera.focal;
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
      this.lookBy(e.clientX-p.x,e.clientY-p.y);
      this.pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
    },true);
    for(const type of ['pointerup','pointercancel','lostpointercapture'])canvas.addEventListener(type,e=>{
      if(!this.active)return;consume(e);this.pointers.delete(e.pointerId);
      if(canvas.hasPointerCapture(e.pointerId))canvas.releasePointerCapture(e.pointerId);
    },true);
    canvas.addEventListener('wheel',e=>{
      if(this.active)consume(e);
    },{capture:true,passive:false});
    for(const type of ['selectstart','contextmenu'])document.addEventListener(type,e=>{
      if(this.active)e.preventDefault();
    },true);
    const controls=new Set(['w','a','s','d','arrowup','arrowdown','arrowleft','arrowright','control',' ','e','q']);
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

// Shared world-space tool frame: the beam starts at the barrel and both
// avatar hands connect to the same grip/support points used by the tool mesh.
function gameLaserFrame(game, radius, relativeTo=[0,0,0]) {
  const laser=game.laser(),forward=laser.direction;
  let right=[forward[1]*laser.camera.up[2]-forward[2]*laser.camera.up[1],forward[2]*laser.camera.up[0]-forward[0]*laser.camera.up[2],forward[0]*laser.camera.up[1]-forward[1]*laser.camera.up[0]];
  const length=Math.hypot(...right);right=right.map(v=>v/length);
  const up=[right[1]*forward[2]-right[2]*forward[1],right[2]*forward[0]-right[0]*forward[2],right[0]*forward[1]-right[1]*forward[0]];
  // Subtract in double precision before packing the tiny foreground mesh into
  // float32. World coordinates can otherwise deform the hands as we move.
  const origin=laser.origin.map((v,i)=>v-relativeTo[i]);
  const transform=p=>origin.map((v,i)=>v+(right[i]*p[0]+up[i]*p[1]+forward[i]*p[2])/radius);
  return {transform,origin,right,up,forward,grip:transform([0,-.15,-.24]),support:transform([-.065,-.065,-.105])};
}
// Procedural classic Ray Gun, modeled from Treyarch's Ray Gun retrospective.
// https://www.treyarch.com/studio-culture/2023/11/treyarch-ray-gun-retrospective-with-maxwell-porter
// Local-space mesh. Build once per camera mode; movement only transforms
// the cached vertices, preserving foreground precision without rebuilding shapes.
const gameRayGunMeshes=new Map();
function gameRayGunMesh(thirdPerson) {
  if(gameRayGunMeshes.has(thirdPerson))return gameRayGunMeshes.get(thirdPerson);
  const vertices=[],red=[.68,.055,.035],redLight=[.88,.12,.065],dark=[.065,.075,.075],
    steel=[.62,.68,.68],brass=[.68,.49,.22],energy=[.3,1,.47];
  const triangle=(a,b,c,color)=>{
    const u=b.map((v,i)=>v-a[i]),v=c.map((v,i)=>v-a[i]);
    const n=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]],length=Math.hypot(...n)||1;
    for(const p of [a,b,c])vertices.push(...p,...color,...n.map(x=>x/length));
  };
  const box=(center,size,color)=>{
    const corners=[];
    for(let i=0;i<8;i++)corners.push(center.map((v,j)=>v+((i>>j&1)?1:-1)*size[j]/2));
    for(const face of [[0,1,3,2],[4,6,7,5],[0,4,5,1],[2,3,7,6],[0,2,6,4],[1,5,7,3]]) {
      triangle(corners[face[0]],corners[face[2]],corners[face[1]],color);
      triangle(corners[face[0]],corners[face[3]],corners[face[2]],color);
    }
  };
  const cylinder=(a,b,r0,r1,color,sides=24)=>{
    const axis=b.map((v,i)=>v-a[i]),length=Math.hypot(...axis),d=axis.map(v=>v/length);
    const ref=Math.abs(d[1])<.9?[0,1,0]:[1,0,0];
    let u=[d[1]*ref[2]-d[2]*ref[1],d[2]*ref[0]-d[0]*ref[2],d[0]*ref[1]-d[1]*ref[0]];
    const norm=Math.hypot(...u);u=u.map(v=>v/norm);
    const v=[d[1]*u[2]-d[2]*u[1],d[2]*u[0]-d[0]*u[2],d[0]*u[1]-d[1]*u[0]];
    const at=(p,r,t)=>p.map((x,i)=>x+r*(u[i]*Math.cos(t)+v[i]*Math.sin(t)));
    for(let i=0;i<sides;i++) {
      const t=i*2*Math.PI/sides,q=(i+1)*2*Math.PI/sides;
      const p0=at(a,r0,t),p1=at(a,r0,q),p2=at(b,r1,t),p3=at(b,r1,q);
      triangle(p0,p1,p3,color);triangle(p0,p3,p2,color);
      triangle(a,p1,p0,color);triangle(b,p2,p3,color);
    }
  };
  const barrel=(z0,z1,r0,r1,color)=>cylinder([0,0,z0],[0,0,z1],r0,r1,color);
  const oval=(center,size,color)=>{
    const rings=8,sides=16;
    const at=(r,s)=>[center[0]+size[0]/2*Math.sin(r*Math.PI/rings)*Math.cos(s*2*Math.PI/sides),
      center[1]+size[1]/2*Math.cos(r*Math.PI/rings),center[2]+size[2]/2*Math.sin(r*Math.PI/rings)*Math.sin(s*2*Math.PI/sides)];
    for(let r=0;r<rings;r++)for(let s=0;s<sides;s++) {
      const a=at(r,s),b=at(r+1,s),c=at(r+1,s+1),d=at(r,s+1);
      triangle(a,c,b,color);triangle(a,d,c,color);
    }
  };
  // Red round receiver, metal rims, side gauge and rear cooling fins.
  cylinder([-.054,.006,-.263],[.054,.006,-.263],.067,.067,red,32);
  for(const side of [-1,1]) {
    cylinder([side*.055,.006,-.263],[side*.06,.006,-.263],.061,.058,brass,32);
    cylinder([side*.061,.006,-.263],[side*.063,.006,-.263],.051,.051,redLight,32);
    cylinder([side*.064,.018,-.258],[side*.067,.018,-.258],.026,.026,dark);
    cylinder([side*.068,.018,-.258],[side*.069,.018,-.258],.021,.021,[.82,.86,.65]);
    cylinder([side*.070,.018,-.258],[side*.070,.03,-.247],.0015,.0015,red,8);
    for(let i=0;i<7;i++) {
      const t=(-.7+i*.37)*Math.PI;
      cylinder([side*.070,.018+Math.cos(t)*.016,-.258+Math.sin(t)*.016],
        [side*.070,.018+Math.cos(t)*.019,-.258+Math.sin(t)*.019],.0007,.0007,dark,6);
    }
    for(const t of [-.65,0,.65]) {
      const y=.006+Math.sin(t)*.052,z=-.263-Math.cos(t)*.052;
      cylinder([side*.034,y,z],[side*.038,y+Math.sin(t)*.024,z-.027],.006,.004,steel,10);
    }
  }
  // Energy chamber and longitudinal red rails.
  barrel(-.24,-.09,.039,.032,dark);
  for(const z of [-.218,-.185,-.152,-.119]) {
    barrel(z-.004,z+.004,.041,.041,energy);
    barrel(z-.011,z-.005,.044,.044,steel);
  }
  for(const x of [-.029,.029])box([x,.032,-.165],[.013,.014,.15],red);
  box([0,-.035,-.17],[.067,.018,.13],red);
  barrel(-.105,-.085,.044,.037,redLight);
  // Narrow barrel with three concentric rings, flared muzzle and emitter tip.
  barrel(-.087,-.03,.013,.012,steel);
  for(const z of [-.075,-.056,-.037])barrel(z-.003,z+.003,.025,.025,brass);
  barrel(-.03,-.012,.029,.016,red);
  barrel(-.031,-.026,.031,.031,steel);
  barrel(-.012,-.002,.008,.005,dark);
  barrel(-.002,0,.005,.003,energy); // beam origin is the muzzle tip
  // Raised sight, swept fin and ribbed black pistol grip.
  box([0,.055,-.17],[.012,.027,.052],red);
  box([0,.073,-.158],[.006,.01,.025],brass);
  cylinder([0,-.055,-.26],[0,-.205,-.285],.035,.028,red,12);
  box([0,-.129,-.275],[.052,.137,.048],dark);
  for(let i=0;i<7;i++)box([0,-.073-i*.018,-.248],[.055,.005,.007],steel.map(v=>v*.45));
  // Curved trigger guard connects the chamber to the heel of the grip.
  const guard=[[0,-.04,-.1],[0,-.094,-.12],[0,-.15,-.16],[0,-.2,-.23],[0,-.211,-.279]];
  for(let i=1;i<guard.length;i++)cylinder(guard[i-1],guard[i],.006,.006,redLight,10);
  cylinder([0,-.055,-.21],[0,-.095,-.195],.005,.005,steel,10);
  // Hands use the shared grip/support anchors also used by the third-person arms.
  oval([0,-.15,-.24],[.11,.12,.12],[.57,.57,.55]);
  oval([-.065,-.065,-.105],[.085,.07,.13],[.57,.57,.55]);
  if(!thirdPerson) {
    oval([.015,-.27,-.32],[.13,.23,.19],[.21,.22,.23]);
    oval([-.1,-.13,-.17],[.10,.16,.13],[.21,.22,.23]);
  }
  const mesh=new Float32Array(vertices);gameRayGunMeshes.set(thirdPerson,mesh);return mesh;
}
function gameLaserTool(game, radius, relativeTo=[0,0,0]) {
  const frame=gameLaserFrame(game,radius,relativeTo),local=gameRayGunMesh(!!game.thirdPerson);
  const vertices=new Float32Array(local.length);
  // Avoid per-vertex temporary arrays in the animation loop on phones.
  for(let i=0;i<local.length;i+=9)for(let axis=0;axis<3;axis++) {
    vertices[i+axis]=frame.origin[axis]+(frame.right[axis]*local[i]+frame.up[axis]*local[i+1]+frame.forward[axis]*local[i+2])/radius;
    vertices[i+3+axis]=local[i+3+axis];
    vertices[i+6+axis]=frame.right[axis]*local[i+6]+frame.up[axis]*local[i+7]+frame.forward[axis]*local[i+8];
  }
  return vertices;
}

// Articulated, 1.78 metre human mesh: head, neck, torso, pelvis, arms,
// hands, legs and shoes. Dimensions are world metres, never screen pixels.
function gameAvatar(game, radius) {
  const vertices=[],skin=[.78,.52,.35],shirt=[.12,.55,.9],pants=[.12,.17,.23],shoe=[.06,.07,.09];
  const swing=game.flying?0:Math.sin(game.phase)*Math.min(1,game.speed/3)*.65;
  const rotate=(p,angle)=>[p[0],p[1]*Math.cos(angle)-p[2]*Math.sin(angle),p[1]*Math.sin(angle)+p[2]*Math.cos(angle)];
  const transform=(p,pivot,angle)=>{
    if(pivot)p=rotate(p.map((v,j)=>v-pivot[j]),angle).map((v,j)=>v+pivot[j]);
    const x=p[0]*Math.cos(game.yaw)+p[2]*Math.sin(game.yaw),z=-p[0]*Math.sin(game.yaw)+p[2]*Math.cos(game.yaw);
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
  const arm=(a,b,width)=>{
    const axis=b.map((v,i)=>v-a[i]),length=Math.hypot(...axis);
    if(length<1e-12)return;
    const direction=axis.map(v=>v/length),reference=Math.abs(direction[1])<.9?[0,1,0]:[1,0,0];
    let side=[direction[1]*reference[2]-direction[2]*reference[1],direction[2]*reference[0]-direction[0]*reference[2],direction[0]*reference[1]-direction[1]*reference[0]];
    const norm=Math.hypot(...side);side=side.map(v=>v/norm);
    const up=[direction[1]*side[2]-direction[2]*side[1],direction[2]*side[0]-direction[0]*side[2],direction[0]*side[1]-direction[1]*side[0]];
    const at=(p,t)=>p.map((v,i)=>v+(side[i]*Math.cos(t)+up[i]*Math.sin(t))*width/radius);
    for(let i=0;i<10;i++) {
      const t=i*Math.PI/5,next=(i+1)*Math.PI/5;
      const p=at(a,t),q=at(a,next),r=at(b,t),s=at(b,next);
      triangle(p,q,s,shirt);triangle(p,s,r,shirt);
    }
  };
  const tool=gameLaserFrame(game,radius);
  oval([0,1.27,0],[.46,.57,.27],shirt);oval([0,.95,0],[.35,.28,.25],pants);
  oval([0,1.53,0],[.12,.15,.12],skin);oval([0,1.655,-.015],[.23,.25,.235],skin);
  oval([0,1.75,.005],[.225,.07,.215],[.12,.08,.055]);
  oval([0,1.66,-.135],[.045,.065,.05],skin);
  for(const side of [-1,1]) {
    oval([side*.045,1.705,-.115],[.018,.014,.009],[.06,.05,.04]);
    const hip=[side*.10,.96,0],shoulder=transform([side*.255,1.46,0]);
    oval([side*.10,.57,0],[.165,.80,.185],pants,hip,side*swing);
    box([side*.10,.09,-.05],[.16,.13,.29],shoe,hip,side*swing);
    const hand=side===-1?tool.support:tool.grip;
    const elbow=shoulder.map((v,i)=>(v+hand[i])/2+([Math.cos(game.yaw)*side*.12,-.18,-Math.sin(game.yaw)*side*.12][i])/radius);
    arm(shoulder,elbow,.075);arm(elbow,hand,.06);
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
if(typeof module!=='undefined')module.exports={gameRaycast,gameGround,gameFlightPlan,gameLaserTool,gameLaserFrame,gameAvatar,gameTarget,TerrainGame};


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
  window.addEventListener('resize',reset);
  window.addEventListener('pagehide',reset);
  document.addEventListener('visibilitychange',()=>{if(document.hidden)reset();});
}


// Relative drag, identical to dragging the scene: no motion while held still.
function bindGameLook(element,getGame) {
  let pointer=null,game=null,last=null;
  const reset=()=>{
    const id=pointer;pointer=null;game=null;last=null;
    element.classList.remove('is-dragging');
    if(id!==null && element.hasPointerCapture(id)) {
      try{element.releasePointerCapture(id);}catch{}
    }
  };
  element.addEventListener('pointerdown',event=>{
    if(pointer!==null || (event.pointerType==='mouse' && event.button!==0))return;
    const active=getGame();if(!active?.active)return;
    event.preventDefault();game=active;game.resetLook=reset;
    pointer=event.pointerId;last={x:event.clientX,y:event.clientY};
    element.classList.add('is-dragging');
    try{element.setPointerCapture(pointer);}catch{}
  });
  element.addEventListener('pointermove',event=>{
    if(event.pointerId!==pointer)return;
    if(!game?.active || (event.pointerType==='mouse' && event.buttons===0)){reset();return;}
    event.preventDefault();
    game.lookBy(event.clientX-last.x,event.clientY-last.y);
    last={x:event.clientX,y:event.clientY};
  });
  const finish=event=>{if(event.pointerId===pointer){event.preventDefault();reset();}};
  element.addEventListener('lostpointercapture',finish);
  for(const type of ['pointerup','pointercancel'])window.addEventListener(type,finish,true);
  for(const type of ['blur','resize','pagehide'])window.addEventListener(type,reset);
  document.addEventListener('visibilitychange',()=>{if(document.hidden)reset();});
}
