'use strict';
const { protocol } = require('electron');
const { mediaResponse } = require('./media-response');
const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');
const core = require('./core');
const execAsync = promisify(execFile);
const entries = new Map();
const byPath = new Map();
let directory;

protocol.registerSchemesAsPrivileged([{ scheme: 'livephoto-media', privileges: {
  standard: true, secure: true, supportFetchAPI: true, stream: true,
} }]);
function entryFor(url) {
  const parsed = new URL(url);
  const entry = parsed.protocol === 'livephoto-media:' && parsed.hostname === 'video' && entries.get(parsed.pathname.slice(1));
  if (!entry) throw new Error('视频预览已失效，请重新添加素材');
  return entry;
}
function register(file, duration) {
  if (byPath.has(file)) return byPath.get(file);
  const id = randomUUID();
  const url = `livephoto-media://video/${id}`;
  entries.set(id, { file, duration, url });
  byPath.set(file, url);
  return url;
}
function registerAsset(file) {
  const id = randomUUID();
  entries.set(id, { file, asset: true });
  return `livephoto-media://video/${id}`;
}
function install() {
  protocol.handle('livephoto-media', request => {
    let entry;
    try { entry = entryFor(request.url); } catch { return new Response('Not found', { status: 404 }); }
    return mediaResponse(entry.proxy || entry.file, request.headers.get('range'), request.method);
  });
}
async function frames(url) {
  const entry = entryFor(url);
  if (!entry.frames) {
    entry.frames = (async () => {
      const images = [];
      for (let i = 0; i < 8; i++) {
        const time = Math.max(0, (entry.duration - 0.1) * i / 7);
        const { stdout } = await execAsync(core.need('ffmpeg'), ['-v','error','-ss',String(time),'-i',entry.file,
          '-frames:v','1','-vf','scale=144:-2','-q:v','6','-f','mjpeg','pipe:1'],
        { encoding: 'buffer', maxBuffer: 4 * 1024 * 1024, windowsHide: true });
        images.push(`data:image/jpeg;base64,${stdout.toString('base64')}`);
      }
      return images;
    })();
    entry.frames.catch(() => { entry.frames = null; });
  }
  return entry.frames;
}
async function transcode(url) {
  const entry = entryFor(url);
  if (!entry.preparing) {
    if (!directory) directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-preview-'));
    const output = path.join(directory, `${randomUUID()}.mp4`);
    const operation = execAsync(core.need('ffmpeg'), ['-y','-v','error','-i',entry.file,
      '-map','0:v:0','-map','0:a:0?','-vf',"scale=w='min(960,iw)':h=-2",'-r','30',
      '-c:v','libx264','-preset','ultrafast','-crf','26','-pix_fmt','yuv420p',
      '-c:a','aac','-ac','2','-movflags','+faststart',output], { windowsHide: true, timeout: 300000 });
    entry.child = operation.child;
    entry.preparing = operation.then(() => { entry.proxy = output; return `${url}?preview=1`; }).catch(error => {
      fs.rmSync(output, { force: true });
      entry.preparing = null;
      throw new Error(`无法准备视频预览：${String(error.stderr || error.message).trim()}`);
    }).finally(() => { entry.child = null; });
  }
  return entry.preparing;
}
function release(url) {
  const entry = entryFor(url);
  entry.child?.kill();
  if (entry.proxy) fs.rmSync(entry.proxy, { force: true });
  byPath.delete(entry.file);
  entries.delete(new URL(url).pathname.slice(1));
}
function cleanup() {
  for (const entry of entries.values()) entry.child?.kill();
  if (directory) fs.rmSync(directory, { recursive: true, force: true });
}
module.exports = { register, registerAsset, install, frames, transcode, release, cleanup };
