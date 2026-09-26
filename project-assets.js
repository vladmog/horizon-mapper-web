'use strict';

function parseGPX(text, name='Track') {
  if(text.length>20*1024*1024)throw new Error('Choose a GPX file smaller than 20 MB.');
  if(/<!DOCTYPE|<!ENTITY/i.test(text))throw new Error('GPX files with document entities are not supported.');
  const doc=new DOMParser().parseFromString(text,'application/xml');
  if(doc.querySelector('parsererror')||doc.documentElement.localName!=='gpx')throw new Error('This is not a valid GPX file.');
  const children=(node,key)=>Array.from(node.children).filter(n=>n.localName===key);
  const value=(node,key)=>children(node,key)[0]?.textContent.trim();
  let count=0;
  const point=node=>{
    const la=node.getAttribute('lat'),lo=node.getAttribute('lon'),lat=Number(la),lon=Number(lo);
    if(la===null||lo===null||!la.trim()||!lo.trim()||!Number.isFinite(lat)||!Number.isFinite(lon)||Math.abs(lat)>85||Math.abs(lon)>180)
      throw new Error('The GPX contains invalid or unsupported coordinates.');
    if(++count>200000)throw new Error('This GPX exceeds 200,000 points. Split the track before loading it.');
    const ele=value(node,'ele'),time=value(node,'time');
    return {lat,lon,elev:ele!==undefined&&ele!==''&&Number.isFinite(Number(ele))?Number(ele):null,
      time:time&&Number.isFinite(Date.parse(time))?time:null};
  };
  const segments=[];
  for(const track of children(doc.documentElement,'trk'))for(const seg of children(track,'trkseg')) {
    const points=children(seg,'trkpt').map(point);if(points.length)segments.push(points);
  }
  for(const route of children(doc.documentElement,'rte')) {
    const points=children(route,'rtept').map(point);if(points.length)segments.push(points);
  }
  const waypoints=children(doc.documentElement,'wpt').map(n=>({...point(n),name:value(n,'name')||'Waypoint'}));
  if(!segments.length&&!waypoints.length)throw new Error('No tracks, routes, or waypoints found in this GPX.');
  return {name,segments,waypoints,count};
}

function trackRibbon(segments) {
  const vertices=[];
  const vertex=(point,side,other)=>vertices.push(...point,side,0,0,...other);
  for(const [a,b] of segments) {
    vertex(a,-1,b);vertex(a,1,b);vertex(b,-1,a);
    vertex(a,-1,b);vertex(b,-1,a);vertex(b,1,a);
  }
  return new Float32Array(vertices);
}

if(typeof document!=='undefined') (()=>{
  const palette=['#38bdf8','#fb7185','#a3e635','#c084fc','#fbbf24','#2dd4bf','#fb923c','#e879f9'];
  const clone=value=>structuredClone(value);
  const settings=['fov','radius','photoBearing','photoInitialBearing','selAz','selLayer','pinnedTarget','vCenter','mode'];
  const panel=document.createElement('section');panel.className='card';panel.id='project-panel';
  panel.innerHTML=`<h2>Project</h2>
    <div class="btns"><input id="project-name" aria-label="Project name" placeholder="Project name" value="Untitled project" style="min-width:140px;flex:1"><button id="project-save">Save project</button><button id="project-new">New project</button></div>
    <div class="btns"><button id="asset-add">Add photos / GPX</button><button id="project-fit">Show all on map</button><button id="project-keep-target">Keep target</button></div>
    <input id="asset-files" type="file" multiple accept="image/*,.heic,.heif,.gpx" hidden>
    <div class="btns"><select id="project-saved" aria-label="Saved projects" style="min-width:120px;flex:1"><option value="">Saved projects…</option></select><button id="project-open">Open</button><button id="project-export">Export project</button><button id="project-import">Import project</button></div>
    <input id="project-file" type="file" accept=".horizon,.json" hidden>
    <p class="sub">Select a photo to edit its viewpoint and target. Colors identify each photo across the maps. Tracks follow terrain by default.</p>
    <div id="asset-list" style="display:grid;gap:8px"></div><div id="asset-targets" class="btns"></div>
    <p id="project-message" class="sub" role="status"></p>`;
  $('card-horizon').before(panel);
  const state={id:crypto.randomUUID(),photos:[],tracks:[],active:null,busy:false,revision:0,signature:'',db:null};
  const say=text=>$('project-message').textContent=text;
  const color=()=>{
    const used=new Set([...state.photos,...state.tracks].map(a=>a.color));
    for(let i=0;i<1000;i++) {
      const hue=(i*137.508)%360;
      const generated='#'+[0,8,4].map(n=>{const k=(n+hue/30)%12;return Math.round(255*(.65-.3*Math.max(-1,Math.min(k-3,9-k,1)))).toString(16).padStart(2,'0');}).join('');
      const candidate=palette[i]||generated;if(!used.has(candidate))return candidate;
    }
    return '#ffffff';
  };
  const dirty=()=>{state.revision++;MP.dirty=true;if(terrainView)terrainView.dirty=true;};
  const current=()=>[...state.photos,...state.tracks].find(p=>p.id===state.active);
  function capture() {
    const photo=current();if(!photo||!S.pos||HZ.loading||!HZ.P)return;
    if(photo.kind==='photo'&&(S.locationSource!=='photo'||S.photoName!==photo.name))return;
    if(photo.kind==='track'&&S.locationSource!=='track')return;
    const cfg=Object.fromEntries(settings.map(k=>[k,HZ[k]??null]));
    const signature=JSON.stringify([state.active,cfg,photoObserverHeight,photoCustomHeight,HZ.P?.hObs]);
    if(signature!==state.signature||photo.snapshot?.profile!==HZ.P){state.signature=signature;dirty();}
    const views=clone(terrainModeViews);
    if(terrainView?.model && ['3d','perspective'].includes(mapView))views[mapView]=terrainView.captureView();
    photo.snapshot={coords:{...S.pos.coords},settings:cfg,profile:HZ.P||photo.snapshot?.profile,
      terrain:terrainData||photo.snapshot?.terrain,observers:clone(observerStates),height:photoObserverHeight,custom:photoCustomHeight,
      views};
    const target=readoutTarget();photo.target=target?.selected?{bearing:HZ.selAz,point:{...target.point}}:null;
  }
  function list() {
    const root=$('asset-list');root.replaceChildren();
    for(const asset of [...state.photos,...state.tracks]) {
      const row=document.createElement('div');row.className='btns';row.style.margin='0';
      const visible=document.createElement('input');visible.type='checkbox';visible.checked=asset.visible!==false;visible.ariaLabel='Show '+asset.name;
      visible.onchange=()=>{asset.visible=visible.checked;dirty();};
      const swatch=document.createElement('input');swatch.type='color';swatch.value=asset.color;swatch.ariaLabel='Color for '+asset.name;swatch.style.width='38px';
      swatch.oninput=()=>{asset.color=swatch.value;dirty();};
      const button=document.createElement('button');button.textContent=(asset.id===state.active?'● ':'')+asset.name;
      button.style.cssText='flex:1;min-width:0;overflow-wrap:anywhere;text-align:left';button.disabled=state.busy;
      button.onclick=()=>run(()=>asset.kind==='photo'?activate(asset):focusTrack(asset));
      row.append(visible,swatch,button);
      if(asset.kind==='track') {
        const mode=document.createElement('select');mode.ariaLabel='Track elevation';
        for(const [v,label] of [['ground','On terrain'],['recorded','Recorded altitude']])mode.add(new Option(label,v));
        mode.value=asset.elevation||'ground';mode.onchange=()=>{asset.elevation=mode.value;dirty();};row.append(mode);
      }
      const remove=document.createElement('button');remove.textContent='Remove';remove.disabled=state.busy;
      remove.onclick=()=>run(async()=>{capture();state.photos=state.photos.filter(p=>p!==asset);state.tracks=state.tracks.filter(p=>p!==asset);
        if(state.active===asset.id){state.active=null;resetLocationOutput();clearPhotoPreview();S.pos=null;if(state.photos.length)await activate(state.photos[0]);else if(state.tracks.length)await focusTrack(state.tracks[0]);}
        dirty();});row.append(remove);root.append(row);
    }
    const targets=$('asset-targets');targets.replaceChildren();
    for(const [i,target] of (current()?.targets||[]).entries()) {
      const button=document.createElement('button');button.textContent='Target '+(i+1);button.disabled=state.busy;
      button.onclick=()=>{HZ.selAz=target.bearing;HZ.selLayer=0;HZ.pinnedTarget=clone(target);mpFitSelection();capture();};targets.append(button);
    }
  }
  async function run(fn) {
    if(state.busy)return;state.busy=true;list();
    for(const id of ['photo-pick','use-gps','asset-add','project-save','project-new','project-open','project-import','project-export'])$(id).disabled=true;
    try{await fn();}catch(error){say(error.message||String(error));}
    finally{state.busy=false;list();for(const id of ['photo-pick','use-gps','asset-add','project-save','project-new','project-open','project-import','project-export'])$(id).disabled=false;}
  }
  async function waitMapped() {
    const deadline=Date.now()+180000;
    while((HZ.loading||!terrainData)&&!HZ.err) {
      if(Date.now()>deadline)throw new Error('Terrain is taking too long. Select this asset to retry.');
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    if(HZ.err)throw new Error(HZ.status||'Terrain could not be loaded. Select the asset to retry.');
    capture();
  }
  const originalUpload=$('photo-file').onchange;
  async function activate(photo) {
    capture();if(mapView!=='2d')setMapView('2d');state.active=null;
    const saved=photo.snapshot;
    if(!saved?.profile||!saved?.terrain) {
      Object.assign(observerStates,{'3d':{height:'photo',customHeight:30},perspective:{height:'custom',customHeight:30}});
      photoObserverHeight='photo';photoCustomHeight=30;
      await originalUpload({target:{files:[photo.file],value:''}});
      if(S.photoName!==photo.name||S.locationSource!=='photo')throw new Error($('photo-status').textContent||'Photo could not be opened.');
      state.active=photo.id;await waitMapped();
    }else {
      ++photoRequest;resetLocationOutput();
      if(watchId!==null)navigator.geolocation.clearWatch(watchId);watchId=null;
      S.locationSource='photo';S.photoName=photo.name;S.pos={coords:{...saved.coords},timestamp:Date.now()};S.posErr=null;
      Object.assign(HZ,clone(saved.settings));HZ.P=saved.profile;prepProfile(HZ.P);HZ.at={lat:HZ.P.lat0,lon:HZ.P.lon0};HZ.loading=false;HZ.err=false;HZ.status='';
      Object.assign(observerStates,clone(saved.observers));photoObserverHeight=saved.height;photoCustomHeight=saved.custom;
      Object.assign(terrainModeViews,clone(saved.views||{}));terrainData=saved.terrain;terrainView?.setModel(terrainData);
      MP.lat0=HZ.P.lat0;MP.lon0=HZ.P.lon0;MP.z=terrainData.z;MP.zoom=0;fitProfile();mpFit();
      showPhotoPreview(photo.file);$('location-source').textContent='Photo: '+photo.name;
      $('hz-bearing-label').textContent='Photo bearing';$('pan-hint').hidden=true;
      $('use-gps').classList.remove('on');$('photo-pick').classList.add('on');
      $('custom-height').value=photoCustomHeight;loadNamedPeaks(HZ.P);state.active=photo.id;
    }
    for(const button of $('hz-fov').querySelectorAll('button'))button.classList.toggle('on',Number(button.dataset.f)===HZ.fov);
    dirty();say('Editing '+photo.name+'. Other visible assets stay on the maps.');
  }
  async function focusTrack(track) {
    capture();const previousTarget=track.target&&clone(track.target),previousHeight=track.snapshot?.profile?.hObs;
    state.active=null;if(mapView!=='2d')setMapView('2d');resetLocationOutput();clearPhotoPreview();
    const p=track.data.segments[0]?.[0]||track.data.waypoints[0];
    ++photoRequest;if(watchId!==null)navigator.geolocation.clearWatch(watchId);watchId=null;
    S.locationSource='track';S.photoName='';S.pos={coords:{latitude:p.lat,longitude:p.lon,altitude:p.elev},timestamp:Date.now()};
    photoObserverHeight='ground';HZ.photoBearing=0;HZ.photoInitialBearing=0;
    const points=track.data.segments.flat();let extent=2000;
    for(const q of points)extent=Math.max(extent,Math.hypot((q.lat-p.lat)*111320,(q.lon-p.lon)*111320*Math.cos(p.lat*Math.PI/180)));
    HZ.radius=Math.min(250000,Math.max(2000,extent*1.1));$('location-source').textContent='Track: '+track.name;
    mapHorizon();await waitMapped();
    if(previousTarget)restoreObserverSelection({...previousTarget,altitude:previousHeight??HZ.P.hObs});
    state.active=track.id;capture();fitAll();say('Track loaded. Terrain covers up to 250 km from its starting point.');
  }
  async function addFiles(files) {
    capture();const errors=[];
    for(const file of files) {
      try {
        if(/\.gpx$/i.test(file.name)) {
          if(file.size>20*1024*1024)throw new Error('Choose a GPX file smaller than 20 MB.');
          if(state.tracks.length>=100)throw new Error('A project can contain up to 100 GPX files.');
          const data=parseGPX(await file.text(),file.name);const track={id:crypto.randomUUID(),kind:'track',name:file.name,file,color:color(),visible:true,elevation:'ground',targets:[],data};state.tracks.push(track);
          if(!HZ.P)await focusTrack(track);
        }else {
          if(state.photos.length>=30)throw new Error('A project can contain up to 30 photos.');
          const coords=await readPhotoLocation(file);
          const photo={id:crypto.randomUUID(),kind:'photo',name:file.name,file,coords,color:color(),visible:true,targets:[]};state.photos.push(photo);
          await activate(photo);
        }
        dirty();list();
      }catch(e){errors.push(file.name+': '+e.message);}
    }
    say(errors.length?errors.join(' · '):'Assets loaded. Select a photo to edit its own target and viewpoint.');
  }
  const sceneCache=new Map();
  function scene(mode='full') {
    capture();const cached=sceneCache.get(mode);if(cached?.revision===state.revision)return cached.groups;
    const groups=[];
    for(const photo of state.photos) {
      if(photo.visible===false)continue;const P=photo.snapshot?.profile;if(!P)continue;
      const origin={lat:P.lat0,lon:P.lon0,elev:P.hObs},lines=[],points=[origin],horizon=[];
      if(mode==='game') {
        if(photo.target){lines.push([origin,photo.target.point]);points.push(photo.target.point);}
        groups.push({color:photo.color,lines,points,name:photo.name});continue;
      }
      for(let i=0;i<P.rays;i++)horizon.push({lat:P.lat[i],lon:P.lon[i],elev:P.elev[i]});
      for(let i=0;i<P.rays;i++) {const j=(i+1)%P.rays;if(Math.abs(P.dist[i]-P.dist[j])<12*Math.max(1,Math.min(P.dist[i],P.dist[j])*2*Math.PI/P.rays))lines.push([horizon[i],horizon[j]]);}
      if(photo.target){lines.push([origin,photo.target.point]);points.push(photo.target.point);}
      if(!photo.target) {const bearing=photo.snapshot.settings.photoBearing||0,b=Math.round(((bearing%360+360)%360)/360*P.rays)%P.rays;lines.push([origin,horizon[b]]);}
      groups.push({color:photo.color,lines,points,horizon,name:photo.name});
    }
    for(const track of state.tracks)if(track.visible!==false) {
      const lines=[],points=[...track.data.waypoints];
      for(const segment of track.data.segments) {if(segment.length)points.push(segment[0],segment.at(-1));for(let i=1;i<segment.length;i++)lines.push([segment[i-1],segment[i]]);}
      groups.push({color:track.color,lines,points,ground:track.elevation!=='recorded',track:true});
      if(track.snapshot?.profile) {
        const P=track.snapshot.profile,origin={lat:P.lat0,lon:P.lon0,elev:P.hObs};
        const targets=[...(track.targets||[]),...(track.target?[track.target]:[])];
        groups.push({color:track.color,lines:targets.map(t=>[origin,t.point]),points:[origin,...targets.map(t=>t.point)]});
      }
    }
    sceneCache.set(mode,{revision:state.revision,groups});return groups;
  }
  function draw2D(ctx) {
    const groups=scene();ctx.save();
    for(const group of groups) {
      ctx.strokeStyle=group.color;ctx.fillStyle=group.color;ctx.lineWidth=2;
      if(group.horizon?.length){ctx.globalAlpha=.06;ctx.beginPath();group.horizon.forEach((p,i)=>i?ctx.lineTo(mpX(p.lon),mpY(p.lat)):ctx.moveTo(mpX(p.lon),mpY(p.lat)));ctx.closePath();ctx.fill();ctx.globalAlpha=1;}
      ctx.beginPath();for(const [a,b] of group.lines){if(Math.abs(a.lon-b.lon)>180)continue;ctx.moveTo(mpX(a.lon),mpY(a.lat));ctx.lineTo(mpX(b.lon),mpY(b.lat));}ctx.stroke();
      for(const p of group.points){ctx.beginPath();ctx.arc(mpX(p.lon),mpY(p.lat),4,0,Math.PI*2);ctx.fill();}
      if(group.name){const p=group.points[0];ctx.fillText(group.name,mpX(p.lon)+7,mpY(p.lat)-7);}
    }
    ctx.restore();
  }
  let meshCache=null;
  function draw3D(view,viewport={width:view.canvas.width,height:view.canvas.height,dpr:devicePixelRatio||1}) {
    const mode=view.photoView?'full':'simple',groups=scene(mode==='simple'?'game':'full'),gl=view.gl;
    if(!meshCache||meshCache.model!==view.model||meshCache.mesh!==view.mesh||meshCache.revision!==state.revision||meshCache.gl!==gl||meshCache.mode!==mode) {
      const batches=[];
      for(const group of groups) {
        const convert=p=>{const q=terrainPoint(view.model,{...p,elev:p.elev??0});if(group.track){const h=gameGround(view,q[0],q[2]);if(h===null)return null;if(group.ground||p.elev==null)q[1]=(h+1)/view.model.radius;}return q;};
        const vertices=[];
        for(const [a,b] of group.lines) {
          if(Math.abs(a.lon-b.lon)>180)continue;
          const distance=Math.hypot((b.lat-a.lat)*111320,(b.lon-a.lon)*111320*Math.cos(a.lat*Math.PI/180));
          const steps=group.track?Math.min(2000,Math.max(1,Math.ceil(distance/Math.max(15,view.meshSpacing)))):1;
          let last=convert(a);
          for(let i=1;i<=steps;i++){const t=i/steps,p={lat:a.lat+(b.lat-a.lat)*t,lon:a.lon+(b.lon-a.lon)*t,elev:a.elev!=null&&b.elev!=null?a.elev+(b.elev-a.elev)*t:null},next=convert(p);if(last&&next)vertices.push(...last,...next);last=next;}
          if(vertices.length>1200000)break;
        }
        const lineCount=vertices.length/3,ribbon=(group.track||mode==='simple')?trackRibbon(Array.from({length:lineCount/2},(_,i)=>[vertices.slice(i*6,i*6+3),vertices.slice(i*6+3,i*6+6)])):null;
        for(const p of group.points){const q=convert(p);if(q)vertices.push(...q);}
        batches.push({data:new Float32Array(vertices),ribbon,lineCount,pointCount:vertices.length/3-lineCount,color:group.color,track:group.track});
      }
      meshCache={model:view.model,mesh:view.mesh,revision:state.revision,gl,mode,batches};
    }
    gl.enable(gl.DEPTH_TEST);gl.depthFunc(gl.LEQUAL);gl.depthMask(false);
    for(const batch of meshCache.batches) {
      gl.bindBuffer(gl.ARRAY_BUFFER,view.markerBuffer);gl.bufferData(gl.ARRAY_BUFFER,batch.data,gl.DYNAMIC_DRAW);
      gl.vertexAttribPointer(0,3,gl.FLOAT,false,0,0);gl.disableVertexAttribArray(1);gl.vertexAttrib2f(1,0,0);
      gl.uniform3fv(view.uniforms.color,[1,3,5].map(i=>parseInt(batch.color.slice(i,i+2),16)/255));
      if(batch.ribbon?.length) {
        gl.bufferData(gl.ARRAY_BUFFER,batch.ribbon,gl.DYNAMIC_DRAW);
        gl.vertexAttribPointer(0,3,gl.FLOAT,false,36,0);
        gl.enableVertexAttribArray(2);gl.vertexAttribPointer(2,3,gl.FLOAT,false,36,12);
        gl.enableVertexAttribArray(3);gl.vertexAttribPointer(3,3,gl.FLOAT,false,36,24);
        gl.uniform1f(view.uniforms.lineWidth,viewport.dpr);gl.uniform1i(view.uniforms.mode,4);
        gl.drawArrays(gl.TRIANGLES,0,batch.ribbon.length/9);
        gl.disableVertexAttribArray(2);gl.disableVertexAttribArray(3);
        gl.bindBuffer(gl.ARRAY_BUFFER,view.markerBuffer);gl.bufferData(gl.ARRAY_BUFFER,batch.data,gl.DYNAMIC_DRAW);
        gl.vertexAttribPointer(0,3,gl.FLOAT,false,0,0);
      } else {gl.uniform1i(view.uniforms.mode,1);gl.drawArrays(gl.LINES,0,batch.lineCount);}
      gl.uniform1i(view.uniforms.mode,2);gl.drawArrays(gl.POINTS,batch.lineCount,batch.pointCount);
    }
    gl.depthMask(true);gl.depthFunc(gl.LESS);
  }
  function fitAll() {
    if(!HZ.P)return;setMapView('2d');fitMapCanvas();
    const points=scene().flatMap(g=>[...g.points,...g.lines.flat()]);if(!points.length)return;
    let x0=Infinity,x1=-Infinity,y0=Infinity,y1=-Infinity;
    for(const p of points){const x=lon2px(p.lon,MP.z),y=lat2px(p.lat,MP.z);x0=Math.min(x0,x);x1=Math.max(x1,x);y0=Math.min(y0,y);y1=Math.max(y1,y);}
    MP.cx=(x0+x1)/2;MP.cy=(y0+y1)/2;MP.k=Math.min(mw/Math.max(1,(x1-x0)*1.15),mh/Math.max(1,(y1-y0)*1.15));MP.zoom=-1;mpPaths();dirty();
  }
  const db=new Promise((resolve,reject)=>{const request=indexedDB.open('horizon-projects',1);request.onupgradeneeded=()=>request.result.createObjectStore('projects',{keyPath:'id'});request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
  db.catch(()=>{});
  async function stored(method,value) {
    const database=await db;return new Promise((resolve,reject)=>{const tx=database.transaction('projects',method==='getAll'?'readonly':'readwrite'),store=tx.objectStore('projects');const request=store[method](value);tx.oncomplete=()=>resolve(request.result);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||new Error('Project save failed.'));});
  }
  async function refreshSaved() {const select=$('project-saved');select.replaceChildren(new Option('Saved projects…',''));for(const p of await stored('getAll'))select.add(new Option(p.name,p.id));}
  function record() {capture();return {format:'horizon-project',version:1,id:state.id,name:$('project-name').value.trim()||'Untitled project',active:state.active,photos:state.photos,tracks:state.tracks};}
  async function save() {if(HZ.loading)await waitMapped();await stored('put',record());await refreshSaved();say('Project saved on this device, including original files and targets.');}
  async function open(record) {
    if(record?.format!=='horizon-project'||record.version!==1||!Array.isArray(record.photos)||!Array.isArray(record.tracks)||record.photos.length>30||record.tracks.length>100)throw new Error('Unsupported project file.');
    const ids=new Set();
    for(const asset of [...record.photos,...record.tracks]) {
      if(!(asset.file instanceof Blob)||typeof asset.name!=='string'||!/^#[0-9a-f]{6}$/i.test(asset.color)||typeof asset.id!=='string'||ids.has(asset.id))throw new Error('Invalid project asset.');
      ids.add(asset.id);
    }
    for(const photo of record.photos) {
      const coords=await readPhotoLocation(photo.file);photo.kind='photo';photo.coords=coords;
      if(!Array.isArray(photo.targets))photo.targets=[];
      for(const target of [...photo.targets,...(photo.target?[photo.target]:[])])
        if(!Number.isFinite(target?.bearing)||!target.point||!['lat','lon','elev','dist','ang'].every(k=>Number.isFinite(target.point[k])))throw new Error('Invalid photo target in project.');
      const saved=photo.snapshot;
      if(saved) {
        if(!saved.settings||!['photo','ground','custom'].includes(saved.height)||!Number.isFinite(saved.custom)||saved.custom<1.6||saved.custom>5000||!saved.observers)throw new Error('Invalid photo settings in project.');
        const P=saved.profile;
        if(P && (!Number.isInteger(P.rays)||P.rays<1||P.rays>10000||!['lat','lon','elev','dist','ang','z'].every(k=>Array.isArray(P[k])&&P[k].length===P.rays&&P[k].every(Number.isFinite))||!P.sub||!Array.isArray(P.tiers)))throw new Error('Invalid cached horizon in project.');
        saved.coords=coords;
      }
    }
    for(const track of record.tracks)track.kind='track';
    for(const track of record.tracks)track.data=parseGPX(await track.file.text(),track.name);
    capture();if(mapView!=='2d')setMapView('2d');resetLocationOutput();clearPhotoPreview();
    Object.assign(state,{id:record.id||crypto.randomUUID(),photos:record.photos,tracks:record.tracks,active:null});$('project-name').value=record.name;
    const track=state.tracks.find(p=>p.id===record.active),photo=state.photos.find(p=>p.id===record.active)||state.photos[0];
    if(track)await focusTrack(track);else if(photo)await activate(photo);else if(state.tracks.length)await focusTrack(state.tracks[0]);else {S.pos=null;$('location-source').textContent='Add photos or a GPX track to begin.';}
    dirty();say('Opened '+record.name+'.');
  }
  function download(blob,name) {const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);}
  async function exportProject() {
    if(HZ.loading)await waitMapped();
    const data=clone(record());
    for(const asset of [...data.photos,...data.tracks]){asset.encoded=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(reader.error);reader.readAsDataURL(asset.file);});delete asset.file;}
    download(new Blob([JSON.stringify(data,(k,v)=>ArrayBuffer.isView(v)?Array.from(v):v)],{type:'application/json'}),(data.name.replace(/[^a-z0-9_-]/gi,'_')||'project')+'.horizon');say('Project exported with its original photos and GPX files.');
  }
  $('asset-add').onclick=()=>$('asset-files').click();$('asset-files').onchange=e=>{const files=[...e.target.files];e.target.value='';run(()=>addFiles(files));};
  $('photo-file').onchange=e=>{const files=[...e.target.files];e.target.value='';return run(()=>addFiles(files));};
  const useGPS=$('use-gps').onclick;$('use-gps').onclick=()=>{capture();state.active=null;useGPS();dirty();list();};
  $('project-fit').onclick=fitAll;$('project-save').onclick=()=>run(save);
  $('project-open').onclick=()=>run(async()=>{const all=await stored('getAll'),p=all.find(p=>p.id===$('project-saved').value);if(p)await open(p);else say('Choose a saved project first.');});
  $('project-new').onclick=()=>run(async()=>{if(state.photos.length||state.tracks.length)await save();await open({format:'horizon-project',version:1,id:crypto.randomUUID(),name:'Untitled project',photos:[],tracks:[]});});
  $('project-export').onclick=()=>run(exportProject);$('project-import').onclick=()=>$('project-file').click();
  $('project-file').onchange=e=>{const file=e.target.files[0];e.target.value='';if(file)run(async()=>{
    if(file.size>400*1024*1024)throw new Error('Project file exceeds 400 MB.');const data=JSON.parse(await file.text());
    if(data?.format!=='horizon-project'||!Array.isArray(data.photos)||!Array.isArray(data.tracks))throw new Error('Invalid project file.');
    for(const asset of [...data.photos,...data.tracks]){if(typeof asset.encoded!=='string'||!/^data:[^,]*;base64,/.test(asset.encoded))throw new Error('Invalid embedded file.');const split=asset.encoded.indexOf(','),bytes=Uint8Array.from(atob(asset.encoded.slice(split+1)),c=>c.charCodeAt(0));asset.file=new File([bytes],asset.name,{type:asset.encoded.slice(5,split).split(';')[0]});delete asset.encoded;}
    await open(data);
  });};
  $('project-keep-target').onclick=()=>{capture();const photo=current();if(!photo?.target){say('Select a photo and mark a target first.');return;}
    photo.targets ||= [];if(!photo.targets.some(t=>t.point.lat===photo.target.point.lat&&t.point.lon===photo.target.point.lon&&t.point.elev===photo.target.point.elev))photo.targets.push(clone(photo.target));list();dirty();say('Target kept with '+photo.name+'.');};
  window.projectAssets={get active(){return current()?.kind==='photo'?state.active:null;},capture,draw2D,draw3D,state,addFiles,activate,scene,save,open,record,parseGPX};
  refreshSaved().catch(()=>say('Local project storage is unavailable. Export projects to keep a copy.'));
})();
if(typeof module!=='undefined')module.exports={trackRibbon};
