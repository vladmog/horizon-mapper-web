'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {gameGround,gameFlightPlan,gameAvatar,gameLaserFrame,TerrainGame}=require('../terrain-game.js');
function terrain(height,patch=false) {
  const n=65,radius=1000,levels=patch?[1,.5]:[1];
  const vertices=new Float32Array(n*n*5*levels.length);
  for(let l=0;l<levels.length;l++)for(let z=0;z<n;z++)for(let x=0;x<n;x++) {
    const px=(2*x/(n-1)-1)*levels[l],pz=(2*z/(n-1)-1)*levels[l];
    vertices[(l*n*n+z*n+x)*5+1]=height(px,pz,l)/radius;
  }
  return {model:{radius,n,patches:patch?[{radius:500,n}]:[]},mesh:{n,vertices}};
}
function sample(plan,u){const p=plan.from.map((v,i)=>v+(plan.to[i]-v)*u);p[1]+=4*u*(1-u)*plan.lift;return p;}
test('flight clears thin ridges, diagonal paths, and fine terrain patches',()=>{
  for(const [view,from,to] of [
    [terrain((x)=>Math.abs(x)<.02?500:0),[-.9,0,0],[.9,0,0]],
    [terrain((x,z)=>Math.abs(x-z)<.02?700:0),[-.8,0,.7],[.8,0,-.7]],
    [terrain((x,z,l)=>l===1&&Math.abs(x-.25)<.01?900:0,true),[-.8,0,0],[.8,0,0]],
    [terrain(x=>x>.75?600:0),[-.8,0,0],[.9,.6,0]],
  ]) {
    from[1]=gameGround(view,from[0],from[2])/1000;to[1]=gameGround(view,to[0],to[2])/1000;
    const plan=gameFlightPlan(view,from,to);assert.ok(plan);
    assert.ok(plan.duration>=.8 && plan.duration<=4);
    assert.deepEqual(sample(plan,0),from);assert.ok(sample(plan,1).every((v,i)=>Math.abs(v-to[i])<1e-10));
    for(let i=0;i<=10000;i++) {
      const p=sample(plan,i/10000),ground=gameGround(view,p[0],p[2])/1000;
      assert.ok(p[1]>=ground-1e-8,`terrain intersection at ${i}: ${p[1]} < ${ground}`);
    }
  }
});
test('launch progresses continuously, reaches the exact destination and can reroute safely',()=>{
  const view=terrain(x=>Math.abs(x)<.02?500:0);
  const game=Object.create(TerrainGame.prototype);
  Object.assign(game,{view,position:[-.8,0,0],spawn:[-.8,0,0],yaw:0,tilt:.24,keys:new Set(),pointers:new Map(),active:true});
  const start=[...game.position];assert.equal(game.beginFlight({position:[.8,0,0],flying:false},'target'),true);
  assert.deepEqual(game.position,start);
  game.advanceFlight(.1);assert.notDeepEqual(game.position,start);assert.notDeepEqual(game.position,[.8,0,0]);
  assert.equal(game.reset(),true);
  let count=0;
  while(game.flight && count++<1000) {
    game.advanceFlight(1/120);
    assert.ok(game.position[1]>=gameGround(view,game.position[0],game.position[2])/1000-1e-8);
  }
  assert.ok(count<1000);assert.deepEqual(game.position,game.spawn);assert.equal(game.flying,false);
  assert.equal(game.reset(),false);
  game.beginFlight({position:[.8,0,0],flying:false},'target');
  assert.equal(game.reset(),true);assert.equal(game.flight,null);assert.deepEqual(game.position,game.spawn);
  assert.equal(gameFlightPlan(view,game.position,[2,0,0]),null);
});

function walker(view,x,z=0) {
  const game=Object.create(TerrainGame.prototype);
  Object.assign(game,{view,position:[x,gameGround(view,x,z)/view.model.radius,z],
    keys:new Set(['w']),pointers:new Map(),stick:{x:0,y:0},active:true,
    yaw:-Math.PI/2,tilt:0,phase:0,velocityY:0,flying:false,speedMultiplier:100,lastTime:null});
  return game;
}
test('walking off a hill at high speed enters flight immediately and holds altitude',()=>{
  const game=walker(terrain(x=>x<0?200:0),-.01);
  const height=game.position[1];
  game.tick(0);game.tick(1000/60);
  assert.equal(game.flying,true);assert.equal(game.velocityY,0);
  assert.equal(game.position[1],height);
  assert.ok(game.position[1]*1000>gameGround(game.view,game.position[0],game.position[2]));
  game.keys.clear();game.tick(2000/60);
  assert.equal(game.position[1],height);
});
test('grounded walking and deliberate descent still work with automatic flight',()=>{
  const flat=walker(terrain(()=>0),0);flat.tick(0);flat.tick(1000/60);
  assert.equal(flat.flying,false);assert.equal(flat.position[1],0);
  const gentle=walker(terrain(x=>100-.2*x),0);gentle.speedMultiplier=1;
  gentle.tick(0);gentle.tick(1000/60);assert.equal(gentle.flying,false);
  flat.position[1]=.001;flat.velocityY=-10;flat.keys.clear();flat.step(1/120);
  assert.equal(flat.flying,true);assert.equal(flat.velocityY,0);assert.equal(flat.position[1],.001);
  flat.keys.add('q');flat.step(1/120);
  assert.equal(flat.position[1],0);assert.equal(flat.flying,false);
  flat.step(1/120);assert.equal(flat.flying,false);
});


test('position relative to start uses horizontal distance, compass direction, and signed height',()=>{
  const game=Object.create(TerrainGame.prototype);
  game.view={model:{radius:1000}};game.spawn=[.2,.4,.3];
  for(const [offset,bearing] of [[[0,0,-.1],0],[[.1,0,0],90],[[0,0,.1],180],[[-.1,0,0],270]]) {
    game.position=game.spawn.map((v,i)=>v+offset[i]);
    const relative=game.relativeToStart();
    assert.ok(Math.abs(relative.distance-100)<1e-8);assert.ok(Math.abs(relative.bearing-bearing)<1e-8);
  }
  game.position=[.2,.35,.3];
  assert.equal(game.relativeToStart().distance,0);assert.equal(game.relativeToStart().bearing,null);
  assert.ok(Math.abs(game.relativeToStart().height+50)<1e-8);
});


test('third-person camera is close while avatar size and hand-mounted laser stay in world metres',()=>{
  for(const radius of [1000,100000]) {
    const view=terrain(()=>0);view.model.radius=radius;view.canvas={clientWidth:390,clientHeight:844};
    const game=Object.create(TerrainGame.prototype);
    Object.assign(game,{view,position:[0,0,0],yaw:0,heading:2,tilt:.24,phase:0,speed:0,flying:false,thirdPerson:true});
    const camera=game.camera(),eye=game.aimCamera().eye;
    const distance=Math.hypot(...camera.eye.map((v,i)=>v-eye[i]))*radius;
    assert.ok(distance>4 && distance<5);
    const avatar=gameAvatar(game,radius),heights=[];
    for(let i=1;i<avatar.length;i+=9)heights.push(avatar[i]*radius);
    assert.ok(Math.max(...heights)>1.77 && Math.max(...heights)<1.80);
    assert.ok(Math.min(...heights)>=0 && Math.min(...heights)<.04);
    for(const tilt of [-1.2,0,.24,1.2]) {
      game.tilt=tilt;
      const laser=game.laser(),frame=gameLaserFrame(game,radius);
      assert.ok(laser.origin[0]*radius>.3,'emitter is outside the right side of the head');
      for(const hand of [frame.grip,frame.support]) {
        assert.ok(Math.hypot(...hand.map((v,i)=>v-laser.origin[i]))*radius<.4);
      }
      const head=[0,1.655/radius,0],delta=head.map((v,i)=>v-laser.origin[i]);
      const t=Math.max(0,delta.reduce((sum,v,i)=>sum+v*laser.direction[i],0));
      const clearance=Math.hypot(...head.map((v,i)=>v-laser.origin[i]-laser.direction[i]*t))*radius;
      assert.ok(clearance>.25,'beam cannot pass through the head');
      assert.ok(gameAvatar(game,radius).every(Number.isFinite));
    }
  }
});

test('third-person shoulder camera shortens its boom against a hillside',()=>{
  const view=terrain((x,z)=>z>0?1000:0);view.canvas={clientWidth:844,clientHeight:390};
  const game=Object.create(TerrainGame.prototype);
  Object.assign(game,{view,position:[0,0,0],yaw:0,tilt:.24,thirdPerson:true});
  const camera=game.camera(),eye=game.aimCamera().eye;
  assert.ok(Math.hypot(...camera.eye.map((v,i)=>v-eye[i]))*1000<4);
  for(let i=0;i<=100;i++) {
    const p=eye.map((v,j)=>v+(camera.eye[j]-v)*i/100);
    assert.ok(p[1]*1000>=gameGround(view,p[0],p[2])+.25);
  }
});
