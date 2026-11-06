'use strict';
const { protocol } = require('electron');
const { mediaResponse } = require('./media-response');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');
const core = require('./core');
const limits = require('./media-limits');
const storage = require('./media-storage');
const { run, cancelError } = require('./media-process');
const entries = new Map(), byPath = new Map();
let directory;
protocol.registerSchemesAsPrivileged([{ scheme:'livephoto-media', privileges:{standard:true,secure:true,supportFetchAPI:true,stream:true} }]);
function entryFor(url) {
  const parsed = new URL(url);
  const entry = parsed.protocol === 'livephoto-media:' && parsed.hostname === 'video' && entries.get(parsed.pathname.slice(1));
  if (!entry) throw new Error('视频预览已失效，请重新添加素材');
  return entry;
}
function registerAsset(file) { const id = randomUUID(); entries.set(id,{file,asset:true}); return `livephoto-media://video/${id}`; }
function register(file,info) {
  if (byPath.has(file)) return byPath.get(file);
  const url = registerAsset(file), entry = entryFor(url);
  Object.assign(entry,{...info,url,asset:false}); byPath.set(file,url); return url;
}
function install() {
  protocol.handle('livephoto-media',request => {
    let entry; try { entry = entryFor(request.url); } catch { return new Response('Not found',{status:404}); }
    return mediaResponse(entry.file,request.headers.get('range'),request.method,stream=>{
      entry.streams ||= new Set();entry.streams.add(stream);stream.once('close',()=>entry.streams.delete(stream));
    });
  });
}
async function frames(url,range) {
  const entry = entryFor(url);
  const from = range?.start ?? 0, to = range?.end ?? Math.min(40,entry.duration);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to > entry.duration || to <= from) throw new Error('时间线范围不合法');
  const key = `${from}:${to}`;
  if (entry.framesKey !== key) { entry.framesController?.abort(); entry.frames = null; entry.framesKey = key; }
  if (!entry.frames) {
    const controller = new AbortController(); entry.framesController = controller;
    const operation = (async () => {
      const images = [];
      for (let i = 0; i < 8; i++) {
        const time = Math.max(0,from + Math.max(0,to-from-0.1)*i/7);
        const {stdout} = await run(core.need('ffmpeg'),['-v','error','-ss',String(time),'-i',entry.file,
          '-frames:v','1','-vf','scale=144:-2','-q:v','6','-f','mjpeg','pipe:1'],
          {signal:controller.signal,background:true,timeout:15000});
        images.push(`data:image/jpeg;base64,${stdout.toString('base64')}`);
      }
      return images;
    })();
    entry.frames = operation;
    operation.catch(() => { if (entry.frames === operation) entry.frames = null; });
  }
  return entry.frames;
}
async function stopProxy(entry) {
  entry.controller?.abort();
  if (entry.preparing) await entry.preparing.catch(() => {});
  if (entry.proxy) { const proxy=entry.proxy;entry.proxy=null;await release(proxy.url);await fs.promises.rm(proxy.file,{force:true}); }
}
async function transcode(url, range) {
  const entry = entryFor(url);
  const clip = core.clipRange(entry.duration,{start:range?.start ?? 0,duration:(range?.end ?? Math.min(3,entry.duration))-(range?.start ?? 0)});
  const start = Math.max(0,clip.start-1), end = Math.min(entry.duration,clip.start+clip.duration+1);
  // Serialize replacement, including rapid requests arriving while cleanup is pending.
  const generation = (entry.generation || 0)+1; entry.generation = generation;
  const previous = entry.replacing || Promise.resolve();
  entry.controller?.abort();
  const operation = previous.catch(() => {}).then(async () => {
    await stopProxy(entry);
    if (entry.generation !== generation) throw cancelError();
    if (!entries.has(new URL(url).pathname.slice(1))) throw new Error('视频预览已失效');
    const controller = new AbortController(); entry.controller = controller;
    await limits.checkSpace(os.tmpdir());
    if (!directory) directory = fs.mkdtempSync(path.join(storage.root(),'lp-preview-'));
    const output = path.join(directory,`${randomUUID()}.mp4`);
    const size = limits.outputSize(entry.width,entry.height,960,960);
    const preparing = (async () => {
      try {
        await run(core.need('ffmpeg'),['-y','-v','error','-ss',String(start),'-t',String(end-start),'-i',entry.file,
          '-map','0:v:0','-map','0:a:0?','-vf',`scale=${size.width}:${size.height},fps=30`,
          '-c:v','libx264','-preset','ultrafast','-crf','26','-pix_fmt','yuv420p','-c:a','aac','-ac','2','-movflags','+faststart',output],
          {signal:controller.signal,timeout:120000,files:[output]});
        controller.signal.throwIfAborted();
        const proxyUrl = registerAsset(output); entry.proxy = {url:proxyUrl,file:output};
        return {url:proxyUrl,offset:start,end};
      } catch (error) { await fs.promises.rm(output,{force:true}); throw error; }
    })();
    entry.preparing = preparing;
    try { return await preparing; } finally { if (entry.preparing === preparing) entry.preparing = null; }
  });
  entry.replacing = operation;
  return operation;
}
async function pause(url) { const entry = entryFor(url); entry.generation = (entry.generation || 0)+1; entry.framesController?.abort(); await stopProxy(entry);
  await entry.replacing?.catch(() => {}); }
async function release(url) {
  const entry = entryFor(url);
  entries.delete(new URL(url).pathname.slice(1));
  byPath.delete(entry.file); entry.framesController?.abort();
  await Promise.all([...(entry.streams || [])].filter(stream=>!stream.closed).map(stream=>new Promise(resolve=>{stream.once('close',resolve);stream.destroy();})));
  await stopProxy(entry);
}
async function cleanup() {
  await Promise.all([...entries.values()].filter(e=>e.url).map(e=>pause(e.url)));
  if (directory) await fs.promises.rm(directory,{recursive:true,force:true});
}
module.exports = {register,registerAsset,install,frames,transcode,pause,release,cleanup};
