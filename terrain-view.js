"use strict";

// CPU geometry helpers stay independent of WebGL for coverage of sampling and
// coordinate alignment. East is +X, up is +Y, south is +Z; UV north is v=0.
function terrainMesh(model, detail) {
  const step = { low: 4, medium: 2, high: 1 }[detail] || 2;
  const n = (model.n - 1) / step + 1;
  const vertices = new Float32Array(n * n * 5);
  const indices = new Uint32Array((n - 1) * (n - 1) * 6);
  let i = 0, j = 0;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const u = x / (n - 1), v = y / (n - 1);
    vertices.set([u * 2 - 1, model.heights[y * step * model.n + x * step] / model.radius,
      v * 2 - 1, u, v], i); i += 5;
    if (x < n - 1 && y < n - 1) {
      const a = y * n + x;
      indices.set([a, a + n, a + 1, a + 1, a + n, a + n + 1], j); j += 6;
    }
  }
  return { vertices, indices, n };
}
// Assemble non-overlapping rings. Fine boundary vertices lie exactly on the
// coarse edge, including its intermediate points, so there are no cracks or
// overlapping surfaces. A short interior blend avoids an abrupt height change.
function terrainLODMesh(model, detail) {
  const levels = [model, ...(model.patches || [])];
  if (levels.length === 1) return { ...terrainMesh(model, detail), spacing: 2*model.radius/({low:64,medium:128,high:256}[detail] || 128), levels: 1 };
  const meshes = levels.map(level => terrainMesh({ ...model, heights: level.heights }, detail));
  const n = meshes[0].n, count = n*n, vertices = new Float32Array(count*5*levels.length), indices = [];
  const heightAt = (mesh, x, y) => {
    const ix=Math.min(n-2,Math.floor(x)), iy=Math.min(n-2,Math.floor(y)), tx=x-ix, ty=y-iy;
    const h=(a,b)=>mesh.vertices[(b*n+a)*5+1];
    // Match the actual coarse triangle, not a bilinear surface.
    return tx+ty<=1 ? h(ix,iy)+(h(ix+1,iy)-h(ix,iy))*tx+(h(ix,iy+1)-h(ix,iy))*ty
      : h(ix+1,iy+1)+(h(ix,iy+1)-h(ix+1,iy+1))*(1-tx)+(h(ix+1,iy)-h(ix+1,iy+1))*(1-ty);
  };
  for (let level=0;level<levels.length;level++) {
    const mesh=meshes[level], scale=levels[level].radius/model.radius;
    for(let y=0;y<n;y++) for(let x=0;x<n;x++) {
      const offset=(y*n+x)*5, edge=Math.min(x,y,n-1-x,n-1-y);
      if(level && edge<4) {
        const coarse=heightAt(meshes[level-1],(n-1)/4+x/2,(n-1)/4+y/2);
        mesh.vertices[offset+1]=coarse+(mesh.vertices[offset+1]-coarse)*edge/4;
      }
      const px=(2*x/(n-1)-1)*scale, pz=(2*y/(n-1)-1)*scale;
      vertices.set([px,mesh.vertices[offset+1],pz,(px+1)/2,(pz+1)/2],level*count*5+offset);
      if(x===n-1 || y===n-1) continue;
      if(level<levels.length-1 && x>=(n-1)/4 && x<3*(n-1)/4 && y>=(n-1)/4 && y<3*(n-1)/4) continue;
      const a=level*count+y*n+x;
      indices.push(a,a+n,a+1,a+1,a+n,a+n+1);
    }
  }
  return { vertices, indices:new Uint32Array(indices), n, levels:levels.length,
    spacing:2*levels.at(-1).radius/(n-1) };
}

function terrainPoint(model, point) {
  const size = 256 * 2 ** model.z;
  let px = (point.lon + 180) / 360 * size;
  // Use the nearest wrapped copy at the antimeridian.
  px = model.cx + ((px - model.cx + size / 2) % size + size) % size - size / 2;
  const r = point.lat * Math.PI / 180;
  const py = (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * size;
  return [(px - model.cx) / model.half, point.elev / model.radius, (py - model.cy) / model.half];
}

function terrainCameraFromMap(model, view) {
  if (!model || !(view.k > 0 && view.height > 0)) return null;
  const factor = 2 ** (model.z - view.z);
  const pixelsPerUnit = view.k * model.half / factor;
  const x=(view.cx * factor - model.cx) / model.half;
  const z=(view.cy * factor - model.cy) / model.half;
  // A close map fit may be only metres wide on a mountain. Its orbit plane
  // must follow terrain, otherwise the first tilt moves the eye underground.
  // Changing Y does not change the straight-down orthographic framing.
  let surface=model;
  for(const patch of model.patches || [])
    if(Math.max(Math.abs(x),Math.abs(z))<=patch.radius/model.radius)surface=patch;
  const n=surface.n || model.n,extent=surface.radius/model.radius;
  let elevation=0;
  if(n>1 && surface.heights) {
    const gx=Math.max(0,Math.min(n-1,(x/extent+1)*(n-1)/2));
    const gz=Math.max(0,Math.min(n-1,(z/extent+1)*(n-1)/2));
    const ix=Math.min(n-2,Math.floor(gx)),iz=Math.min(n-2,Math.floor(gz)),tx=gx-ix,tz=gz-iz;
    const h=(a,b)=>surface.heights[b*n+a];
    elevation=tx+tz<=1 ? h(ix,iz)+(h(ix+1,iz)-h(ix,iz))*tx+(h(ix,iz+1)-h(ix,iz))*tz
      : h(ix+1,iz+1)+(h(ix,iz+1)-h(ix+1,iz+1))*(1-tx)+(h(ix+1,iz)-h(ix+1,iz+1))*(1-tz);
  }
  return { focus: [x,elevation/model.radius || 0,z],
    distance: view.height / (2 * pixelsPerUnit) * 2.41421356 };
}

function terrainOrbitCamera(view) {
  const sy=Math.sin(view.yaw), cy=Math.cos(view.yaw), st=Math.sin(view.tilt), ct=Math.cos(view.tilt);
  const backward=[ct*sy,st,ct*cy], distance=view.orthographic ? 20 : view.distance;
  return { eye:view.focus.map((v,i)=>v+distance*backward[i]),
    right:[cy,0,-sy], up:[-st*sy,ct,-st*cy], forward:backward.map(v=>-v),
    focal:2.41421356, halfHeight:view.orthographic ? view.distance/2.41421356 : 0,
    near:view.orthographic ? .01 : Math.min(.01,view.distance/1000), far:100 };
}
function terrainCameraBearing(camera) {
  if (!camera) return null;
  let x=camera.forward?.[0],z=camera.forward?.[2];
  if (![x,z].every(Number.isFinite) || Math.hypot(x,z)<1e-6) {
    x=camera.up?.[0];z=camera.up?.[2];
  }
  if (![x,z].every(Number.isFinite) || Math.hypot(x,z)<1e-9) return null;
  return (Math.atan2(x,-z)*180/Math.PI+360)%360;
}
function terrainPointVisible(camera, point, aspect) {
  if (!point || !point.every(Number.isFinite) || !(aspect > 0)) return false;
  const offset=point.map((v,i)=>v-camera.eye[i]);
  const dot=axis=>offset.reduce((sum,v,i)=>sum+v*axis[i],0);
  const depth=dot(camera.forward);
  if (depth < camera.near || depth > camera.far) return false;
  const halfHeight=camera.halfHeight || depth/camera.focal;
  return Math.abs(dot(camera.right)) <= halfHeight*aspect && Math.abs(dot(camera.up)) <= halfHeight;
}
function terrainOrbitPivot(view, source, target) {
  if (view.orbitSelection === 'source' && source) return [...source];
  if (view.orbitSelection === 'target' && target) return [...target];
  if (view.orbitSelection === 'midpoint' && source && target)
    return source.map((v,i)=>(v+target[i])/2);
  return [...view.focus];
}

// Hit distances are CSS pixels, independent of display density. Clip the line
// to the camera depth range before projection so off-screen endpoints work too.
function terrainOrbitHit(view, source, target, x, y, width, height) {
  if (!(width>0 && height>0)) return null;
  const camera=terrainOrbitCamera(view);
  const local=p=>p?.every(Number.isFinite) ? ['right','up','forward'].map(axis=>
    p.reduce((sum,v,i)=>sum+(v-camera.eye[i])*camera[axis][i],0)) : null;
  const project=p=>{
    const half=camera.halfHeight || p[2]/camera.focal;
    return [width/2+p[0]*height/(2*half),height/2-p[1]*height/(2*half)];
  };
  const points=[local(source),local(target)];
  const screens=points.map(p=>p && p[2]>=camera.near && p[2]<=camera.far ? project(p) : null);
  const distance=p=>p ? Math.hypot(p[0]-x,p[1]-y) : Infinity;
  const distances=screens.map(distance);
  if (Math.min(...distances)<=22) return distances[0]<=distances[1] ? 'source' : 'target';
  if (Math.min(...distances)<36 || points.some(p=>!p)) return null;
  const [a,b]=points, dz=b[2]-a[2];
  let start=0,end=1;
  if (Math.abs(dz)<1e-12) { if(a[2]<camera.near || a[2]>camera.far) return null; }
  else {
    const t0=(camera.near-a[2])/dz,t1=(camera.far-a[2])/dz;
    start=Math.max(0,Math.min(t0,t1));end=Math.min(1,Math.max(t0,t1));
    if(start>end) return null;
  }
  const at=t=>project(a.map((v,i)=>v+t*(b[i]-v)));
  const p=at(start),q=at(end),dx=q[0]-p[0],dy=q[1]-p[1],length=dx*dx+dy*dy;
  if(length<1) return null;
  const t=Math.max(0,Math.min(1,((x-p[0])*dx+(y-p[1])*dy)/length));
  return Math.hypot(x-p[0]-t*dx,y-p[1]-t*dy)<=10 ? 'midpoint' : null;
}

function terrainPhotoCamera(model, photo, aspect) {
  const floor = photo.ground + (photo.eye ?? 1.6);
  const supplied = Number.isFinite(photo.altitude);
  const shared = Number.isFinite(photo.observerAltitude);
  const altitude = shared ? photo.observerAltitude : supplied ? Math.max(floor, photo.altitude) : floor;
  const bearing = photo.bearing * Math.PI / 180, pitch = photo.pitch * Math.PI / 180;
  const s = Math.sin(bearing), c = Math.cos(bearing), sp = Math.sin(pitch), cp = Math.cos(pitch);
  return { eye: [0, altitude / model.radius, 0],
    right: [c, 0, s], up: [-s * sp, cp, c * sp], forward: [s * cp, sp, -c * cp],
    focal: aspect / Math.tan(photo.fov * Math.PI / 360),
    near: Math.max(1e-6, .25 / model.radius), far: Math.max(4, altitude / model.radius + 4),
    altitude, altitudeSource: shared ? (photo.observerSource || 'Observer height') : !supplied ? 'Terrain + eye level'
      : photo.altitude < floor ? 'Eye level (photo altitude below terrain)' : 'Photo altitude' };
}

// A bounded, camera-centered imagery patch supplies the same XYZ tile level as
// the 2D view at the orbit focus. The full-area texture remains underneath it.
function terrainImageryPlan(model, camera, pixelHeight, size = 2048) {
  const pixelsPerUnit = pixelHeight * 2.41421356 / (2 * camera.distance);
  if (!(pixelsPerUnit > 512)) return null;
  const level = Math.max(0, Math.min(23, Math.round(model.z + Math.log2(pixelsPerUnit / model.half))));
  return terrainImageryPatch(model, camera, level, size);
}
function terrainImageryPatch(model, camera, level, size) {
  const pixel = 2 ** (model.z - level), quantum = pixel * 128;
  const cx = Math.round((model.cx + camera.focus[0] * model.half) / quantum) * quantum;
  const cy = Math.round((model.cy + camera.focus[2] * model.half) / quantum) * quantum;
  const half = size * pixel / 2;
  return { level, size, cx, cy, half, key: `${level}/${cx}/${cy}/${size}`,
    view: { z: model.z, k: 1 / pixel, cx, cy, width: size, height: size, dpr: 1 },
    bounds: [(cx - half - model.cx + model.half) / (2 * model.half),
      (cy - half - model.cy + model.half) / (2 * model.half), half / model.half, half / model.half] };
}

// Keep every intermediate level, rather than replacing one shrinking square.
// Tilted terrain outside the finest patch retains its existing imagery as zoom
// increases. Each layer is 1024 square (~5.3 MB including mipmaps).
function terrainImageryPlans(model, camera, pixelHeight) {
  const finest = terrainImageryPlan(model, camera, pixelHeight, 1024);
  const baseLevel = Math.max(0, Math.min(23, Math.round(model.z + Math.log2(512 / model.half))));
  const plans = [];
  for (let level = baseLevel + 1; finest && level <= finest.level; level++)
    plans.push(terrainImageryPatch(model, camera, level, 1024));
  return plans;
}

// Ground perspective needs its finest coverage at the eye, not at a fixed
// point far ahead. Nested squares allocate progressively coarser texels with
// distance and remain stable while looking around. Stop at ~0.25 m texels;
// requesting arbitrary zoom-23 imagery at eye height only magnifies the source.
function terrainPerspectiveImageryPlans(model, camera, pixelHeight) {
  const baseLevel=Math.max(0,Math.min(23,Math.round(model.z+Math.log2(512/model.half))));
  const metersPerPixel=model.radius/model.half;
  const aboveGround=Math.max(0, camera.eye[1]*model.radius-(camera.groundElevation ?? model.heights[(model.heights.length-1)/2]));
  const texel=Math.max(.25,aboveGround*2/(pixelHeight*camera.focal));
  const finest=Math.max(baseLevel,Math.min(23,Math.ceil(model.z+Math.log2(metersPerPixel/texel))));
  const plans=[];
  for(let level=baseLevel+1;level<=finest;level++)
    plans.push(terrainImageryPatch(model,{focus:camera.eye},level,1024));
  return plans;
}

class TerrainView {
  constructor(canvas, changed, failed, photoLook = () => {}) {
    this.canvas = canvas; this.changed = changed; this.failed = failed;
    this.photoLook = photoLook; this.photoView = false;
    this.detail = 'high'; this.model = null; this.dirty = true; this.textureDirty = true;
    this.points = new Map(); this.lost = false;
    this.textureCanvas = document.createElement('canvas');
    this.textureCanvas.width = this.textureCanvas.height = 1024;
    this.textureContext = this.textureCanvas.getContext('2d');
    this.detailCanvas = document.createElement('canvas');
    this.detailCanvas.width = this.detailCanvas.height = 1024;
    this.detailContext = this.detailCanvas.getContext('2d');
    this.detailPlan = null; this.detailPlans = []; this.detailDirty = true;
    this.imagery = new SatelliteMap(() => { this.textureDirty = this.detailDirty = this.dirty = true; changed(); });
    this.gl = canvas.getContext('webgl2', { alpha: false, antialias: true });
    if (!this.gl) throw new Error('3D is unavailable on this device. The 2D map still works.');
    this.initGL(); this.resetCamera(); this.bindGestures();
    canvas.addEventListener('webglcontextlost', e => {
      e.preventDefault(); this.lost = true; this.cancelGestures();
      failed('3D graphics were interrupted. Switched to 2D; try 3D again once graphics recover.');
    });
    canvas.addEventListener('webglcontextrestored', () => {
      try { this.lost = false; this.initGL(); if (this.model) this.uploadMesh();
        this.textureDirty = this.dirty = true; changed(); }
      catch (e) { failed(e.message); }
    });
  }
  initGL() {
    const gl = this.gl;
    const compile = (kind, source) => {
      const shader = gl.createShader(kind); gl.shaderSource(shader, source); gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const error = gl.getShaderInfoLog(shader); gl.deleteShader(shader); throw new Error(error);
      }
      return shader;
    };
    const vs = compile(gl.VERTEX_SHADER, `#version 300 es
      precision highp float;
      layout(location=0) in vec3 position;
      layout(location=1) in vec2 uv;
      layout(location=2) in vec3 tint;
      out vec3 vTint;
      layout(location=3) in vec3 avatarNormal; flat out vec3 vAvatarNormal;
      uniform vec3 eye, right, up, forward;
      uniform float aspect, halfHeight, focal, clipNear, clipFar;
      uniform highp int mode; uniform vec2 viewport; uniform float lineWidth;
      out vec2 vUV; out vec3 vPosition;
      void main() {
        vec3 p = position-eye;
        float depth = dot(p,forward);
        gl_Position = vec4(dot(p,right)*focal/aspect, dot(p,up)*focal,
          (clipFar+clipNear)/(clipFar-clipNear)*depth-2.0*clipFar*clipNear/(clipFar-clipNear), depth);
        if (halfHeight > 0.0) gl_Position = vec4(dot(p,right)/(aspect*halfHeight),
          dot(p,up)/halfHeight, (depth-.01)/99.99*2.0-1.0, 1.0);
        if (mode == 4) {
          vec3 q = avatarNormal-eye;
          float qDepth = dot(q,forward);
          vec4 qClip = vec4(dot(q,right)*focal/aspect, dot(q,up)*focal,
            (clipFar+clipNear)/(clipFar-clipNear)*qDepth-2.0*clipFar*clipNear/(clipFar-clipNear), qDepth);
          if (halfHeight > 0.0) qClip = vec4(dot(q,right)/(aspect*halfHeight),
            dot(q,up)/halfHeight, (qDepth-.01)/99.99*2.0-1.0, 1.0);
          vec2 delta=(qClip.xy/max(abs(qClip.w),1e-7)-gl_Position.xy/max(abs(gl_Position.w),1e-7))*viewport;
          vec2 normal=length(delta)>1e-5 ? normalize(vec2(-delta.y,delta.x)) : vec2(0.0,1.0);
          gl_Position.xy += normal*tint.x*lineWidth*2.0/viewport*gl_Position.w;
        }
        gl_PointSize = 10.0;
        vUV=uv; vPosition=position; vTint=tint; vAvatarNormal=avatarNormal;
      }`);
    const fs = compile(gl.FRAGMENT_SHADER, `#version 300 es
      precision highp float;
      in vec2 vUV; in vec3 vPosition; in vec3 vTint; flat in vec3 vAvatarNormal;
      uniform sampler2D imagery;
      uniform highp sampler2DArray detailImagery;
      uniform vec4 detailBounds[24]; uniform int detailCount;
      uniform highp int mode; uniform vec3 color;
      out vec4 fragColor;
      void main() {
        if(mode==1 || mode==2 || mode==4) {
          if(mode==2 && length(gl_PointCoord-vec2(.5))>.5) discard;
          fragColor=vec4(color,1.0); return;
        }
        vec3 normal=normalize(cross(dFdx(vPosition),dFdy(vPosition)));
        if(normal.y<0.0) normal=-normal;
        float light=.65+.35*max(0.0,dot(normal,normalize(vec3(-.5,1.,-.4))));
        if(mode==3) { float avatarLight=.55+.45*max(0.,dot(normalize(vAvatarNormal),normalize(vec3(-.5,1.,-.4))));fragColor=vec4(vTint*avatarLight,1.0);return; }
        vec3 surface=texture(imagery,vUV).rgb;
        vec2 dx=dFdx(vUV), dy=dFdy(vUV);
        vec3 detailColor=vec3(0.); float remaining=1.;
        for(int i=detailCount-1;i>=0;i--) {
          vec4 bounds=detailBounds[i];
          vec2 detailUV=(vUV-bounds.xy)/bounds.zw;
          if(all(greaterThanEqual(detailUV,vec2(0.))) && all(lessThanEqual(detailUV,vec2(1.)))) {
            vec4 finer=textureGrad(detailImagery,vec3(detailUV,float(i)),dx/bounds.zw,dy/bounds.zw);
            vec2 edge=min(detailUV,1.0-detailUV);
            float alpha=finer.a*smoothstep(0.0,.005,min(edge.x,edge.y));
            detailColor+=remaining*alpha*finer.rgb; remaining*=1.-alpha;
            if(remaining<.001) break;
          }
        }
        surface=detailColor+remaining*surface;
        fragColor=vec4(surface*light,1.0);
      }`);
    this.program = gl.createProgram(); gl.attachShader(this.program, vs); gl.attachShader(this.program, fs);
    gl.linkProgram(this.program); gl.deleteShader(vs); gl.deleteShader(fs);
    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(this.program));
    this.uniforms = Object.fromEntries(['eye','right','up','forward','aspect','halfHeight','focal','clipNear','clipFar','viewport','lineWidth','imagery','detailImagery','detailBounds','detailCount','mode','color']
      .map(name => [name, gl.getUniformLocation(this.program, name === 'detailBounds' ? 'detailBounds[0]' : name)]));
    this.vertexBuffer = gl.createBuffer(); this.indexBuffer = gl.createBuffer(); this.markerBuffer = gl.createBuffer(); this.avatarBuffer=gl.createBuffer();
    const anisotropy = gl.getExtension('EXT_texture_filter_anisotropic');
    const createTexture = (target = gl.TEXTURE_2D) => {
      const texture = gl.createTexture(); gl.bindTexture(target, texture);
      gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(target, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(target, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      if (anisotropy) gl.texParameterf(target, anisotropy.TEXTURE_MAX_ANISOTROPY_EXT,
        Math.min(8, gl.getParameter(anisotropy.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
      if (target === gl.TEXTURE_2D) gl.texImage2D(target,0,gl.RGBA,1,1,0,gl.RGBA,gl.UNSIGNED_BYTE,new Uint8Array(4));
      else gl.texImage3D(target,0,gl.RGBA,1,1,1,0,gl.RGBA,gl.UNSIGNED_BYTE,new Uint8Array(4));
      gl.generateMipmap(target);
      return texture;
    };
    gl.activeTexture(gl.TEXTURE0);
    this.texture = createTexture(); this.detailTexture = createTexture(gl.TEXTURE_2D_ARRAY);
    this.detailLayers = 0;
    this.textureDirty = this.detailDirty = true;
  }
  setModel(model) {
    if (model && (model.n !== 257 || model.heights?.length !== model.n * model.n || !(model.radius > 0)
      || model.heights.some(h => !Number.isFinite(h)))) throw new Error('Invalid 3D terrain data.');
    if (model?.patches && (!Array.isArray(model.patches) || model.patches.length > 8 ||
      model.patches.some((patch,i) => patch.radius !== model.radius / 2**(i+1) ||
        patch.heights?.length !== model.n*model.n || patch.heights.some(h=>!Number.isFinite(h)))))
      throw new Error('Invalid 3D terrain detail data.');
    this.game?.stop();
    this.cancelGestures(); this.model = model; this.lastTarget = ''; this.detailPlan = null;
    this.orbitSource = this.orbitTarget = null;
    this.imagery.releaseView('base');
    for (const plan of this.detailPlans) this.imagery.releaseView(`detail-${plan.level}`);
    this.detailPlans = [];
    if (model && !this.lost) this.uploadMesh();
    this.resetCamera(); this.textureDirty = this.detailDirty = this.dirty = true;
  }
  uploadMesh() {
    const gl = this.gl, mesh = terrainLODMesh(this.model, this.detail);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer); gl.bufferData(gl.ARRAY_BUFFER, mesh.vertices, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
    this.mesh=mesh;
    this.indexCount = mesh.indices.length;
    this.gridN = mesh.n; this.meshLevels = mesh.levels; this.meshSpacing = mesh.spacing;
  }
  setDetail(detail) {
    if (!['low','medium','high'].includes(detail)) return;
    this.detail = detail;
    if (this.model && !this.lost) this.uploadMesh();
    this.dirty = true; this.changed();
  }
  captureView() {
    return { focus: [...this.focus], yaw: this.yaw, tilt: this.tilt, distance: this.distance,
      orbitSelection: this.orbitSelection, orthographic: this.orthographic, photoView: this.photoView, photoPitch: this.photoPitch,
      photoFov: this.photoFov, photoSource: this.photoSource && {...this.photoSource}, photoSourceKey: this.photoSourceKey };
  }
  restoreView(view) { Object.assign(this, view, { focus: [...view.focus], dirty: true }); }
  resetCamera() {
    this.orbitSelection = null;
    this.photoView = false;
    this.orthographic = false;
    this.yaw = 0; this.tilt = .8; this.distance = 3.8;
    this.focus = [0, this.model ? this.model.heights[(this.model.heights.length-1)/2] / this.model.radius : 0, 0];
    this.dirty = true; this.changed();
  }
  matchMapView(view) {
    const camera = terrainCameraFromMap(this.model, view);
    if (!camera) return;
    this.cancelGestures();
    this.photoView = false;
    this.focus = camera.focus; this.distance = camera.distance;
    this.yaw = 0; this.tilt = Math.PI / 2; this.orthographic = true;
    this.dirty = true; this.changed();
  }
  setPhotoView(source) {
    if (!this.model || !Number.isFinite(source.ground)) return;
    const key = JSON.stringify(source);
    if (!this.photoView) {
      this.cancelGestures(); this.photoPitch = 0;
      this.photoFov = Math.max(15, Math.min(120, source.fov));
    } else if (source.fov !== this.photoSource?.fov) {
      this.photoFov = Math.max(15, Math.min(120, source.fov));
    }
    if (!this.photoView || key !== this.photoSourceKey) this.dirty = true;
    this.photoView = true; this.photoSource = { ...source }; this.photoSourceKey = key;
  }
  resetPhotoView() {
    if (!this.photoView) return;
    this.photoPitch = 0; this.photoFov = Math.max(15, Math.min(120, this.photoSource.fov));
    this.dirty = true; this.changed();
  }
  lookPhoto(dx, dy) {
    this.photoSource.bearing = ((this.photoSource.bearing - dx * .25) % 360 + 360) % 360;
    this.photoPitch = Math.max(-80, Math.min(80, this.photoPitch + dy * .2));
    this.photoLook(this.photoSource.bearing);
    this.dirty = true; this.changed();
  }
  zoom(factor) {
    if (this.photoView) {
      this.photoFov = Math.max(15, Math.min(120,
        360 / Math.PI * Math.atan(Math.tan(this.photoFov * Math.PI / 360) * factor)));
      this.dirty = true; this.changed(); return;
    }
    if (!(Number.isFinite(factor) && factor > 0)) return;
    // Tilting must not introduce a different zoom range: the old .08 floor
    // stopped the camera kilometres away and even reversed close-in zooms.
    const minimum=Math.min(.0001,.25/(this.model?.radius || 2500));
    const requested=Math.max(minimum,Math.min(32,this.distance*factor));
    const distance=factor<1 ? Math.min(this.distance,requested) : Math.max(this.distance,requested);
    const ratio=distance/this.distance, pivot=this.chooseOrbitPivot();
    // Orbiting an off-center marker moves the focus away from that marker.
    // Dolly the entire camera toward the chosen pivot, not that stale focus.
    this.focus=this.focus.map((v,i)=>pivot[i]+(v-pivot[i])*ratio);
    this.distance=distance;
    this.dirty = true; this.changed();
  }
  chooseOrbitPivot() {
    return terrainOrbitPivot(this,this.orbitSource,this.orbitTarget);
  }
  orbit(yawDelta, tiltDelta, pivot = this.chooseOrbitPivot()) {
    if (this.photoView) return;
    // The straight-down entry matches the flat map. Once tilted, use a
    // perspective lens. Put the pivot on the focus plane first so its screen
    // position and apparent scale survive the projection change.
    if (this.orthographic && Math.min(Math.PI/2,this.tilt+tiltDelta) < Math.PI/2-1e-6) {
      const camera=terrainOrbitCamera(this);
      const offset=pivot.map((v,i)=>v-this.focus[i]);
      const depth=offset.reduce((sum,v,i)=>sum+v*camera.forward[i],0);
      this.focus=this.focus.map((v,i)=>v+depth*camera.forward[i]);
      this.orthographic=false;
    }
    const before=terrainOrbitCamera(this);
    this.yaw+=yawDelta;
    this.tilt=Math.max(.12,Math.min(Math.PI/2,this.tilt+tiltDelta));
    const after=terrainOrbitCamera(this), offset=this.focus.map((v,i)=>v-pivot[i]);
    // Rotate the camera AND its look-at point around the chosen pivot. Changing
    // focus to the pivot would snap the map to center before every drag.
    const axes=['right','up','forward'];
    const local=axes.map(axis=>offset.reduce((sum,v,i)=>sum+v*before[axis][i],0));
    this.focus=pivot.map((v,i)=>v+axes.reduce((sum,axis,j)=>sum+local[j]*after[axis][i],0));
    this.dirty=true; this.changed();
  }
  pan(dx, dy) {
    if (this.photoView) return;
    const scale=this.distance/Math.max(1,this.canvas.clientHeight)*.8;
    this.focus[0]=Math.max(-1.3,Math.min(1.3,this.focus[0]-dx*scale*Math.cos(this.yaw)-dy*scale*Math.sin(this.yaw)));
    this.focus[2]=Math.max(-1.3,Math.min(1.3,this.focus[2]+dx*scale*Math.sin(this.yaw)-dy*scale*Math.cos(this.yaw)));
    this.dirty=true; this.changed();
  }
  cancelGestures() {
    for (const id of this.points.keys()) if (this.canvas.hasPointerCapture(id)) this.canvas.releasePointerCapture(id);
    this.points.clear(); this.anchor = null; this.orbitPivot = null; this.orbitTap = null; this.panDrag = false;
  }
  gesture() {
    const p = [...this.points.values()];
    return p.length > 1 ? { x:(p[0].x+p[1].x)/2,y:(p[0].y+p[1].y)/2,
      span:Math.max(1,Math.hypot(p[0].x-p[1].x,p[0].y-p[1].y)), multi:true } : p[0];
  }
  bindGestures() {
    const c = this.canvas;
    c.addEventListener('pointerdown', e => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.preventDefault(); c.setPointerCapture(e.pointerId);
      this.points.set(e.pointerId,{x:e.clientX,y:e.clientY}); this.anchor=this.gesture();
      if (this.points.size === 1) this.panDrag=!this.photoView && e.pointerType==='mouse' && e.shiftKey;
      if (!this.photoView && this.points.size === 1 && !this.panDrag) {
        this.orbitPivot=this.chooseOrbitPivot();
        this.orbitTap={x:e.clientX,y:e.clientY};
      } else this.orbitTap=null;
    });
    c.addEventListener('pointermove', e => {
      if (!this.points.has(e.pointerId)) return;
      e.preventDefault(); this.points.set(e.pointerId,{x:e.clientX,y:e.clientY});
      if(this.orbitTap) {
        if(Math.hypot(e.clientX-this.orbitTap.x,e.clientY-this.orbitTap.y)<=6) return;
        this.orbitTap=null;
      }
      const p=this.gesture(), a=this.anchor;
      if (a) {
        const dx=p.x-a.x, dy=p.y-a.y;
        if (p.multi && a.multi) {
          this.zoom(a.span/p.span);
          if (this.photoView) this.lookPhoto(dx,dy);
          else this.pan(dx,dy);
        } else if (!p.multi && !a.multi) {
          if (this.photoView) this.lookPhoto(dx,dy);
          else if (this.panDrag) this.pan(dx,dy);
          else this.orbit(-dx*.008,dy*.008,this.orbitPivot);
        }
      }
      this.anchor=p; this.dirty=true; this.changed();
    });
    const end=e=>{
      const tap=this.orbitTap; this.orbitTap=null;
      if(e.type==='pointerup' && tap && !this.photoView && this.points.size===1 &&
        Math.hypot(e.clientX-tap.x,e.clientY-tap.y)<=6) {
        const r=c.getBoundingClientRect();
        const hit=terrainOrbitHit(this,this.orbitSource,this.orbitTarget,e.clientX-r.left,e.clientY-r.top,r.width,r.height);
        if(hit) { this.orbitSelection=hit;this.dirty=true;this.changed(); }
      }
      this.points.delete(e.pointerId);
      if (!this.points.size) this.panDrag=false;
      if(c.hasPointerCapture(e.pointerId))c.releasePointerCapture(e.pointerId);this.anchor=this.gesture();
      // Re-evaluate after a two-finger pan/zoom, then hold the pivot steady for
      // the next one-finger orbit so it cannot switch halfway through a drag.
      this.orbitPivot=!this.photoView && this.points.size===1 ? this.chooseOrbitPivot() : null;};
    for (const type of ['pointerup','pointercancel','lostpointercapture'])c.addEventListener(type,end);
    c.addEventListener('wheel',e=>{e.preventDefault();this.zoom(Math.exp(Math.max(-200,Math.min(200,e.deltaY))*.002));},{passive:false});
    c.addEventListener('keydown',e=>{
      if (this.photoView && e.key.startsWith('Arrow')) {
        const delta={ArrowLeft:[20,0],ArrowRight:[-20,0],ArrowUp:[0,15],ArrowDown:[0,-15]}[e.key];
        if(delta){this.lookPhoto(...delta);e.preventDefault();}return;
      }
      if(e.key==='ArrowLeft')this.orbit(-.12,0);
      else if(e.key==='ArrowRight')this.orbit(.12,0);
      else if(e.key==='ArrowUp')this.orbit(0,.08);
      else if(e.key==='ArrowDown')this.orbit(0,-.08);
      else if(e.key==='+'||e.key==='=')this.zoom(.85);
      else if(e.key==='-')this.zoom(1.18);
      else if(e.key==='Home'){if(this.photoView)this.resetPhotoView();else this.resetCamera();}else return;
      e.preventDefault();this.dirty=true;this.changed();
    });
  }
  render(target, observerAltitude) {
    if (this.lost) return;
    this.orbitSource = this.model ? [0,(observerAltitude||0)/this.model.radius,0] : null;
    this.orbitTarget = this.model && target ? terrainPoint(this.model,target.point) : null;
    const gl=this.gl, r=this.canvas.getBoundingClientRect(), dpr=Math.min(3,window.devicePixelRatio||1);
    const w=Math.max(1,Math.round(r.width*dpr)),h=Math.max(1,Math.round(r.height*dpr));
    if (this.canvas.width!==w||this.canvas.height!==h) {this.canvas.width=w;this.canvas.height=h;this.dirty=true;}
    const key=`${observerAltitude}/${target?`${target.point.lat}/${target.point.lon}/${target.point.elev}/${target.selected}`:''}`;
    if(key!==this.lastTarget){this.lastTarget=key;this.dirty=true;}
    if(!this.dirty&&!this.textureDirty&&!this.detailDirty)return;
    this.dirty=false;gl.viewport(0,0,w,h);
    if(this.game?.active)gl.clearColor(.48,.67,.82,1);else gl.clearColor(.035,.055,.08,1);
    gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
    if(!this.model){this.activeCamera=null;return;}
    const gameCamera=this.game?.active ? this.game.camera() : null;
    const photoCamera = !gameCamera && this.photoView ? terrainPhotoCamera(this.model,
      {...this.photoSource,pitch:Math.max(-80,Math.min(80,this.photoPitch+(this.photoSource.sensorPitch || 0))),fov:this.photoFov},w/h) : null;
    this.photoCamera = photoCamera;
    const plans = (gameCamera || photoCamera) ? terrainPerspectiveImageryPlans(this.model, gameCamera || photoCamera, h)
      : terrainImageryPlans(this.model, this, h);
    if (plans.map(p => p.key).join('|') !== this.detailPlans.map(p => p.key).join('|')) {
      for (const old of this.detailPlans) if (!plans.some(p => p.level === old.level))
        this.imagery.releaseView(`detail-${old.level}`);
      this.detailPlans = plans; this.detailPlan = plans.at(-1) || null; this.detailDirty = true;
    }
    gl.activeTexture(gl.TEXTURE0);
    if(this.textureDirty){
      const m=this.model, ctx=this.textureContext, size=this.textureCanvas.width;
      ctx.fillStyle='#51645b';ctx.fillRect(0,0,size,size);
      const result=this.imagery.draw(ctx,{z:m.z,cx:m.cx,cy:m.cy,k:size/(m.half*2),width:size,height:size,dpr:1},'base');
      this.baseImageryStatus=result;
      // Tile completion/retry callbacks request the next upload. Do not upload
      // a 4 MB texture every frame while the network is slow or coverage is missing.
      this.textureDirty=false;
      gl.bindTexture(gl.TEXTURE_2D,this.texture);
      gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,this.textureCanvas);
      gl.generateMipmap(gl.TEXTURE_2D);
    }
    if (this.detailDirty) {
      this.detailImageryStatus = null;
      gl.bindTexture(gl.TEXTURE_2D_ARRAY,this.detailTexture);
      if (this.detailLayers !== plans.length) {
        // Allocate only the levels needed at this zoom; discard fine layers on
        // zoom-out. A transparent placeholder keeps the sampler valid at overview.
        gl.texImage3D(gl.TEXTURE_2D_ARRAY,0,gl.RGBA,plans.length ? 1024 : 1,
          plans.length ? 1024 : 1,Math.max(1,plans.length),0,gl.RGBA,gl.UNSIGNED_BYTE,null);
        this.detailLayers = plans.length;
      }
      for (const [layer, plan] of plans.entries()) {
        this.detailContext.clearRect(0,0,plan.size,plan.size);
        const status = this.imagery.draw(this.detailContext, plan.view, `detail-${plan.level}`);
        if (!this.detailImageryStatus) this.detailImageryStatus = { total: 0, ready: 0, failed: 0 };
        for (const key of ['total','ready','failed']) this.detailImageryStatus[key] += status[key];
        gl.texSubImage3D(gl.TEXTURE_2D_ARRAY,0,0,0,layer,plan.size,plan.size,1,gl.RGBA,gl.UNSIGNED_BYTE,this.detailCanvas);
      }
      gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
      this.detailDirty = false;
    }
    this.imageryStatus = this.detailImageryStatus || this.baseImageryStatus;
    gl.useProgram(this.program);
    // Orthographic framing matches the 2D affine at every terrain elevation.
    // Keep the camera safely above the surface even at a very close 2D zoom.
    const camera=gameCamera || photoCamera || terrainOrbitCamera(this);
    this.activeCamera=camera;
    gl.uniform3fv(this.uniforms.eye,camera.eye);
    gl.uniform3fv(this.uniforms.right,camera.right);
    gl.uniform3fv(this.uniforms.up,camera.up);
    gl.uniform3fv(this.uniforms.forward,camera.forward);
    gl.uniform1f(this.uniforms.focal,camera.focal);
    gl.uniform1f(this.uniforms.clipNear,camera.near);
    gl.uniform1f(this.uniforms.clipFar,camera.far);
    gl.uniform1f(this.uniforms.aspect,w/h);
    gl.uniform2f(this.uniforms.viewport,w,h);
    gl.uniform1f(this.uniforms.halfHeight,camera.halfHeight || 0);
    gl.uniform1i(this.uniforms.imagery,0);
    gl.uniform1i(this.uniforms.detailImagery,1);
    gl.uniform1i(this.uniforms.detailCount,plans.length);
    if (plans.length) gl.uniform4fv(this.uniforms.detailBounds,plans.flatMap(p => p.bounds));
    gl.bindTexture(gl.TEXTURE_2D,this.texture);
    gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_2D_ARRAY,this.detailTexture);gl.activeTexture(gl.TEXTURE0);
    gl.disableVertexAttribArray(2);gl.vertexAttrib3f(2,1,1,1);gl.disableVertexAttribArray(3);gl.vertexAttrib3f(3,0,1,0);
    gl.enable(gl.DEPTH_TEST);gl.uniform1i(this.uniforms.mode,0);
    gl.bindBuffer(gl.ARRAY_BUFFER,this.vertexBuffer);
    gl.enableVertexAttribArray(0);gl.vertexAttribPointer(0,3,gl.FLOAT,false,20,0);
    gl.enableVertexAttribArray(1);gl.vertexAttribPointer(1,2,gl.FLOAT,false,20,12);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,this.indexBuffer);
    gl.drawElements(gl.TRIANGLES,this.indexCount,gl.UNSIGNED_INT,0);
    window.projectAssets?.draw3D(this,{width:w,height:h,dpr});
    if(gameCamera) {
      const avatar=gameAvatar(this.game,this.model.radius);
      gl.bindBuffer(gl.ARRAY_BUFFER,this.avatarBuffer);gl.bufferData(gl.ARRAY_BUFFER,avatar,gl.DYNAMIC_DRAW);
      gl.vertexAttribPointer(0,3,gl.FLOAT,false,36,0);gl.disableVertexAttribArray(1);gl.vertexAttrib2f(1,0,0);
      gl.enableVertexAttribArray(2);gl.vertexAttribPointer(2,3,gl.FLOAT,false,36,12);
      gl.enableVertexAttribArray(3);gl.vertexAttribPointer(3,3,gl.FLOAT,false,36,24);
      gl.uniform1i(this.uniforms.mode,3);gl.drawArrays(gl.TRIANGLES,0,avatar.length/9);
      gl.disableVertexAttribArray(2);gl.disableVertexAttribArray(3);
      const laser=this.game.laser();
      gl.bindBuffer(gl.ARRAY_BUFFER,this.markerBuffer);
      gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([...laser.origin,...laser.end]),gl.DYNAMIC_DRAW);
      gl.vertexAttribPointer(0,3,gl.FLOAT,false,0,0);
      gl.uniform1i(this.uniforms.mode,1);gl.uniform3fv(this.uniforms.color,[1,.08,.05]);
      gl.drawArrays(gl.LINES,0,2);
      if(laser.hit) {
        gl.disable(gl.DEPTH_TEST);gl.uniform1i(this.uniforms.mode,2);
        gl.drawArrays(gl.POINTS,1,1);
      }
      // Selected app targets share the same annotations in Game and orbit views.
      // The live laser remains a preview until the user places a target.
      if(!target?.selected)return;
    }
    // Overlay annotations stay legible even when the simplified surface differs
    // slightly from the exact DEM point used by the profile and readout.
    const origin=[0,(observerAltitude||0)/this.model.radius,0];
    const endpoint=target?terrainPoint(this.model,target.point):origin;
    gl.bindBuffer(gl.ARRAY_BUFFER,this.markerBuffer);
    gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([...origin,...endpoint]),gl.DYNAMIC_DRAW);
    gl.vertexAttribPointer(0,3,gl.FLOAT,false,0,0);gl.disableVertexAttribArray(1);gl.vertexAttrib2f(1,0,0);
    gl.disable(gl.DEPTH_TEST);gl.uniform1i(this.uniforms.mode,1);gl.uniform3fv(this.uniforms.color,[1,1,1]);
    if(target && !photoCamera)gl.drawArrays(gl.LINES,0,2);
    gl.uniform1i(this.uniforms.mode,2);gl.uniform3fv(this.uniforms.color,[.22,.74,.97]);
    if(!photoCamera)gl.drawArrays(gl.POINTS,0,1);
    if(target){gl.uniform3fv(this.uniforms.color,target.selected?[1,.44,.44]:[1,.82,.35]);gl.drawArrays(gl.POINTS,1,1);}
  }
}
if (typeof module !== 'undefined') module.exports={terrainOrbitHit,terrainLODMesh,terrainPerspectiveImageryPlans,terrainMesh,terrainPoint,terrainCameraFromMap,terrainOrbitCamera,terrainCameraBearing,terrainPointVisible,terrainOrbitPivot,terrainImageryPlan,terrainImageryPlans,terrainPhotoCamera,TerrainView};
