'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {gameGround,gameFlightPlan,TerrainGame}=require('../terrain-game.js');
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
