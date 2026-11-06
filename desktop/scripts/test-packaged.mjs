import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
if (process.platform !== 'darwin') throw new Error('此检查需要 macOS 应用包');
const root = process.cwd();
const appDir = path.join(root, 'release', process.arch === 'arm64' ? 'mac-arm64' : 'mac', 'LivePhoto.app');
const resources = path.join(appDir, 'Contents/Resources');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'livephoto-package-'));
const src = path.join(dir, 'source.mp4');
execFileSync(path.join(resources, `bin/mac-${process.arch}/ffmpeg`), ['-v','error','-f','lavfi','-i','testsrc2=size=320x240:rate=30:duration=1','-c:v','libx264',src]);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.LP_FFMPEG; delete env.LP_FFPROBE;
const child = spawn(path.join(appDir,'Contents/MacOS/LivePhoto'), ['--remote-debugging-port=9333'], { env, stdio: 'ignore' });
let socket;
try {
  let pages;
  for (let i=0;i<100;i++) {
    try { pages = await (await fetch('http://127.0.0.1:9333/json/list')).json(); if (pages.some(p=>p.type==='page')) break; } catch {}
    await new Promise(r=>setTimeout(r,100));
  }
  const page = pages.find(p=>p.type==='page');
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
  let seq=0; const pending=new Map();
  socket.onmessage=e=>{const msg=JSON.parse(e.data);if(pending.has(msg.id)){pending.get(msg.id)(msg);pending.delete(msg.id);}};
  const evaluate=async expression=>{
    const id=++seq;
    const reply=new Promise(resolve=>pending.set(id,resolve));
    socket.send(JSON.stringify({id,method:'Runtime.evaluate',params:{expression,awaitPromise:true,returnByValue:true}}));
    const result=await reply;
    if(result.result.exceptionDetails) throw new Error(JSON.stringify(result.result.exceptionDetails));
    return result.result.result.value;
  };
  const environment = await evaluate('window.api.envCheck()');
  assert.equal(environment.ok,true,JSON.stringify(environment));
  assert.equal(environment.canSavePhotos,true);
  const probed = await evaluate(`window.api.probeVideos(${JSON.stringify([src])})`);
  const files = probed.map(f => ({ ...f, clip: { start: 0, end: 1, cover: 0.5 } }));
  assert.equal(files[0].ok,true,JSON.stringify(files));
  const playback = await evaluate(`new Promise((resolve, reject) => {
    const video = document.createElement('video');
    const timer = setTimeout(() => reject(new Error('打包视频预览超时')), 10000);
    video.preload = 'auto'; video.muted = true;
    video.onerror = () => { clearTimeout(timer); reject(new Error(video.error.message)); };
    video.onloadeddata = () => {
      video.onseeked = () => {
        clearTimeout(timer);
        resolve({ time: video.currentTime, end: video.seekable.end(0) });
        video.remove();
      };
      video.currentTime = 0.5;
    };
    document.body.append(video);
    video.src = ${JSON.stringify(files[0].previewUrl)};
  })`);
  assert.ok(Math.abs(playback.time - 0.5) < 0.04 && playback.end > 0.9);

  const batch = await evaluate(`window.api.prepareDelivery(${JSON.stringify({files,opts:{},destination:'file',outdir:dir})})`);
  assert.equal(batch.items[0].ok, true);
  const rendered = await evaluate(`new Promise((resolve, reject) => {
    const image = new Image();
    const video = document.createElement('video');
    const timer = setTimeout(() => reject(new Error('成片资源加载超时')), 10000);
    let count = 0;
    const loaded = () => {
      if (++count === 2) {
        clearTimeout(timer);
        resolve({ width: image.naturalWidth, duration: video.duration });
        video.remove();
      }
    };
    image.onload = loaded; video.onloadeddata = loaded;
    image.onerror = video.onerror = () => { clearTimeout(timer); reject(new Error('成片资源加载失败')); };
    video.preload = 'auto'; video.muted = true;
    document.body.append(video);
    image.src = ${JSON.stringify(batch.items[0].stillUrl)};
    video.src = ${JSON.stringify(batch.items[0].videoUrl)};
  })`);
  assert.ok(rendered.width > 0 && Math.abs(rendered.duration - 1) < 0.05);

  assert.equal(fs.existsSync(path.join(dir, 'source.MP.JPG')), false);
  const result = await evaluate(`window.api.saveDelivery(${JSON.stringify(batch.id)})`);
  await evaluate(`window.api.releaseDelivery(${JSON.stringify(batch.id)})`);
  assert.equal(result[0].ok,true,JSON.stringify(result));
  assert.ok(fs.existsSync(result[0].path));
  process.lpResourcesDir = resources;
  const core = require('../electron/core');
  const pair = await core.preparePhoto(src, { duration: 1 });
  try { assert.equal(pair.validated, true); }
  finally { fs.rmSync(pair.directory, { recursive: true, force: true }); }
  console.log('PACKAGED_OK: bundled FFmpeg/ffprobe/native helper executed; preview seek, staged poster/video, confirmed delivery and Apple validation passed');
} finally { socket?.close(); child.kill(); fs.rmSync(dir,{recursive:true,force:true}); }
