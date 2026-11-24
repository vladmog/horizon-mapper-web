'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root=path.resolve(__dirname,'..');

test('service worker installs coherent releases, keeps them offline, and rejects partial updates',async()=>{
  let filesVersion=0,workerVersion=1,failScript=false,requests=0;
  const server=http.createServer((req,res)=>{
    requests++;
    const name=new URL(req.url,'http://localhost').pathname.replace(/^\/horizon\//,'') || 'index.html';
    if(failScript && name==='workspace.js'){res.writeHead(503);res.end('Unavailable');return;}
    try {
      let body;
      if(name==='index.html')body=`<!doctype html><title>release-${filesVersion}</title>`;
      else if(name==='pwa.js')body=fs.readFileSync(path.join(root,name),'utf8').replace(/HORIZON_RELEASE = \d+/,`HORIZON_RELEASE = ${workerVersion}`);
      else {
        body=fs.readFileSync(path.join(root,name));
        if(['workspace.js','workspace.css'].includes(name))body=Buffer.concat([body,Buffer.from(`\n/* release-${filesVersion} */`)]);
      }
      const type=name.endsWith('.js')?'application/javascript':name.endsWith('.css')?'text/css':name.endsWith('.html')?'text/html':'application/octet-stream';
      res.writeHead(200,{'content-type':type,'cache-control':name==='service-worker.js'?'no-store':'max-age=3600'});res.end(body);
    }catch {res.writeHead(404);res.end('Not found');}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({headless:true,executablePath:process.platform==='darwin'?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':undefined});
  const context=await browser.newContext({serviceWorkers:'allow'}),page=await context.newPage();
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}/horizon/`);
    // An old HTTP-cache entry must not contaminate the new shell installation.
    assert.match(await page.evaluate(()=>fetch('workspace.js').then(r=>r.text())),/release-0/);
    await page.evaluate(async()=>{await caches.open('another-app-cache');});
    filesVersion=1;
    await page.evaluate(async()=>{
      const controlled=new Promise(resolve=>navigator.serviceWorker.addEventListener('controllerchange',resolve,{once:true}));
      await navigator.serviceWorker.register('service-worker.js',{scope:'./',updateViaCache:'none'});
      await navigator.serviceWorker.ready;await controlled;
    });
    const shell=()=>page.evaluate(async()=>Promise.all(['index.html','workspace.js','workspace.css'].map(async file=>(await (await fetch(file)).text()).match(/release-(\d+)/)[1])));
    assert.deepEqual(await shell(),['1','1','1']);
    filesVersion=2;
    const before=requests;
    assert.deepEqual(await shell(),['1','1','1']);
    await new Promise(resolve=>setTimeout(resolve,150));
    assert.equal(requests,before,'cached files must not refresh independently in the background');
    await context.setOffline(true);assert.deepEqual(await shell(),['1','1','1']);await context.setOffline(false);
    workerVersion=2;
    await page.evaluate(async()=>{
      const changed=new Promise(resolve=>navigator.serviceWorker.addEventListener('controllerchange',resolve,{once:true}));
      await (await navigator.serviceWorker.getRegistration()).update();await changed;
    });
    assert.deepEqual(await shell(),['2','2','2']);
    await page.waitForFunction(async()=>!(await caches.keys()).includes('horizon-mapper-workspace-v1'),null,{timeout:5000});
    const keys=await page.evaluate(()=>caches.keys());assert.ok(keys.includes('another-app-cache'));
    // A failed file download leaves the previous complete release active.
    workerVersion=3;filesVersion=3;failScript=true;
    await page.evaluate(async()=>{
      const reg=await navigator.serviceWorker.getRegistration();
      const failed=new Promise(resolve=>reg.addEventListener('updatefound',()=>{
        const worker=reg.installing;worker.addEventListener('statechange',()=>{if(worker.state==='redundant')resolve();});
      },{once:true}));
      await reg.update();await failed;
    });
    assert.deepEqual(await shell(),['2','2','2']);
    await context.setOffline(true);assert.deepEqual(await shell(),['2','2','2']);
  }finally {await context.close();await browser.close();await new Promise(resolve=>server.close(resolve));}
});
