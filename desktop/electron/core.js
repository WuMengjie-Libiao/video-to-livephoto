// core.js — 转换核心（纯 Node，不依赖 Electron）
// FFmpeg 负责媒体处理；原生桥接负责 Apple 资源及照片图库写入。
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { pipeline } = require('node:stream/promises');
const { run } = require('./media-process');
const limits = require('./media-limits');
const storage = require('./media-storage');
const crypto = require('crypto');

const IS_WIN = process.platform === 'win32';

// ---------------------------------------------------------------- 二进制查找

const binCache = new Map();

// 随包 ffmpeg 的目录名，如 win-x64 / mac-arm64
function platTag() {
  const p = process.platform === 'win32' ? 'win'
    : process.platform === 'darwin' ? 'mac' : 'linux';
  return `${p}-${process.arch}`;
}

function searchPaths(name) {
  const exe = IS_WIN ? `${name}.exe` : name;
  const plat = platTag();
  const dirs = [];
  if (process.env[`LP_${name.toUpperCase()}`]) dirs.push(process.env[`LP_${name.toUpperCase()}`]);
  // 打包后：resources/bin/win-x64/ffmpeg.exe（随包分发的版本，优先级最高）
  const resources = process.lpResourcesDir || process.resourcesPath;
  if (resources) {
    dirs.push(path.join(resources, 'bin', plat, exe));
    dirs.push(path.join(resources, 'bin', exe));
  }
  if (process.execPath) dirs.push(path.join(path.dirname(process.execPath), exe));
  dirs.push(path.join(__dirname, 'bin', plat, exe));
  dirs.push(path.join(__dirname, '..', 'bin', plat, exe));
  dirs.push(path.join(__dirname, exe), path.join(__dirname, 'bin', exe));
  if (process.env.PATH) {
    for (const d of process.env.PATH.split(path.delimiter)) {
      if (d) dirs.push(path.join(d, exe));
    }
  }
  if (IS_WIN && process.env.LOCALAPPDATA) {
    dirs.push(path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', exe));
  }
  dirs.push(`/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`);
  return dirs;
}

function resolveBin(name) {
  if (binCache.has(name)) return binCache.get(name);
  let found = null;
  for (const p of searchPaths(name)) {
    try {
      if (fs.statSync(p).isFile()) { found = p; break; }
    } catch { /* 忽略 */ }
  }
  binCache.set(name, found);
  return found;
}

function need(name) {
  const p = resolveBin(name);
  if (!p) {
    throw new Error(
      `找不到 ${name}。装一下（${IS_WIN ? 'winget install Gyan.FFmpeg' : 'brew install ffmpeg'}），` +
      '或把它放进程序目录 / PATH。');
  }
  return p;
}

// ---------------------------------------------------------------- ffmpeg 调用

async function ff(args, context = {}) {
  return run(need('ffmpeg'), args, context);
}
async function videoInfo(file, context = {}) {
  await limits.checkInput(file);
  const { stdout } = await run(need('ffprobe'),
    ['-v','error','-print_format','json','-show_format','-show_streams',file], { ...context, onProgress:undefined, timeout: 30000 });
  const meta = JSON.parse(stdout.toString());
  const vs = (meta.streams || []).find(s => s.codec_type === 'video');
  if (!vs) throw new Error(`${path.basename(file)} 里没有视频流`);
  let w = Number(vs.width), h = Number(vs.height);
  for (const sd of vs.side_data_list || []) if (Math.abs(Number(sd.rotation)) % 180 === 90) [w,h] = [h,w];
  const duration = Number(meta.format?.duration || vs.duration);
  if (!Number.isFinite(duration) || duration <= 0 || !(w > 0 && h > 0)) throw new Error('无法确定视频时长或尺寸');
  const [num,den] = (vs.avg_frame_rate || '0/1').split('/').map(Number);
  return { duration, width: w, height: h, fps: num / den || 30 };
}
async function extractStill(video, ts, out, height, context = {}) {
  await ff(['-y','-v','error','-ss',ts.toFixed(3),'-i',video,'-frames:v','1',
    '-vf',height ? `scale=-2:${height}:flags=lanczos` : 'null','-pix_fmt','yuvj420p','-q:v','2',out], { ...context, onProgress:undefined, timeout: 15000 });
  if (!fs.existsSync(out) || !fs.statSync(out).size) throw new Error('抽帧失败（时间点可能超出视频长度）');
}
async function encodeVideo({ src, start, duration, out, width, height, mute, crf, crop, fps }, context = {}) {
  const args = ['-y','-v','error','-ss',start.toFixed(3),'-t',duration.toFixed(3),'-i',src,'-map','0:v:0','-map','0:a:0?'];
  if (mute) args.push('-an'); else args.push('-c:a','aac','-b:a','128k','-ac','2','-ar','48000');
  args.push('-vf',`${crop ? `crop=${crop.width}:${crop.height},` : ''}scale=${width}:${height}:flags=lanczos,fps=${Math.min(limits.maxFps,fps)}`,
    '-c:v','libx264','-profile:v','high','-preset','medium','-crf',String(crf),'-pix_fmt','yuv420p','-movflags','+faststart',
    '-progress','pipe:1','-f','mp4',out);
  await ff(args, { ...context, duration, onProgress: context.onProgress || (() => {}), files: [out], timeout: 300000 });
}

// ------------------------------------------------- Motion Photo（单文件 JPEG）

const XMP_NS = Buffer.from('http://ns.adobe.com/xap/1.0/\u0000', 'utf8');

function xmpPacket({ tsUs, videoLen }) {
  return `<?xpacket begin="\ufeff" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="LivePhoto">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:GCamera="http://ns.google.com/photos/1.0/camera/"
    xmlns:Container="http://ns.google.com/photos/1.0/container/"
    xmlns:Item="http://ns.google.com/photos/1.0/container/item/"
    GCamera:MotionPhoto="1"
    GCamera:MotionPhotoVersion="1"
    GCamera:MotionPhotoPresentationTimestampUs="${tsUs}"
    GCamera:MicroVideo="1"
    GCamera:MicroVideoVersion="1"
    GCamera:MicroVideoOffset="${videoLen}"
    GCamera:MicroVideoPresentationTimestampUs="${tsUs}">
   <Container:Directory>
    <rdf:Seq>
     <rdf:li rdf:parseType="Resource">
      <Container:Item Item:Mime="image/jpeg" Item:Semantic="Primary"
        Item:Length="0" Item:Padding="0"/>
     </rdf:li>
     <rdf:li rdf:parseType="Resource">
      <Container:Item Item:Mime="video/mp4" Item:Semantic="MotionPhoto"
        Item:Length="${videoLen}"/>
     </rdf:li>
    </rdf:Seq>
   </Container:Directory>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
}

function insertApp1(jpeg, xml) {
  if (jpeg.length < 2 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error('不是合法 JPEG');
  const payload = Buffer.concat([XMP_NS, Buffer.from(xml, 'utf8')]);
  const seg = Buffer.alloc(4);
  seg.writeUInt16BE(0xffe1, 0);
  seg.writeUInt16BE(payload.length + 2, 2);

  let off = 2;
  while (off + 4 <= jpeg.length && jpeg[off] === 0xff) {
    const marker = jpeg[off + 1];
    const size = jpeg.readUInt16BE(off + 2);
    if ((marker === 0xe0 || marker === 0xe1) && size >= 2) off += 2 + size;
    else break;
  }
  return Buffer.concat([jpeg.subarray(0, off), seg, payload, jpeg.subarray(off)]);
}

async function buildMotionPhoto({ stillFile, videoFile, outFile, tsUs }, context = {}) {
  await limits.checkOutput([stillFile, videoFile]);
  const jpeg = await fs.promises.readFile(stillFile);
  const videoLen = (await fs.promises.stat(videoFile)).size;
  const composed = insertApp1(jpeg, xmpPacket({ tsUs, videoLen }));
  if (composed.length + videoLen > limits.maxOutputBytes) throw new Error('成片超过 50 MiB，请缩短片段');
  await fs.promises.writeFile(outFile, composed, { signal: context.signal });
  await pipeline(fs.createReadStream(videoFile), fs.createWriteStream(outFile, { flags: 'a' }), { signal: context.signal });
}
async function verifyMotionPhoto(file) {
  const handle = await fs.promises.open(file, 'r');
  try {
    const total = (await handle.stat()).size;
    const data = Buffer.alloc(Math.min(total, 65536 + 1024));
    await handle.read(data,0,data.length,0);
    const i = data.indexOf('GCamera:MotionPhotoVersion');
    const start = data.lastIndexOf('<x:xmpmeta', i), end = data.indexOf('</x:xmpmeta>', i);
    if (i < 0 || start < 0 || end < 0 || data.indexOf(XMP_NS) < 0) return { ok: false, reason: 'XMP 段不完整' };
    const xml = data.subarray(start,end).toString('utf8');
    const primary = xml.match(/Semantic="Primary"\s+Item:Length="(\d+)"/);
    const video = xml.match(/Mime="video\/mp4"[\s\S]*?Item:Length="(\d+)"/);
    const videoLen = video ? Number(video[1]) : -1, stillLen = total - videoLen;
    if (!(videoLen > 8 && stillLen > 4)) return { ok:false, reason:'视频边界不合法' };
    const boundary = Buffer.alloc(10); await handle.read(boundary,0,10,stillLen-2);
    const ok = total <= limits.maxOutputBytes && primary?.[1] === '0' && data.readUInt16BE(0) === 0xffd8 &&
      boundary.readUInt16BE(0) === 0xffd9 && boundary.toString('ascii',6,10) === 'ftyp';
    return { ok,total,stillLen,videoLen };
  } finally { await handle.close(); }
}

// ---------------------------------------------------------------- 交付

function clipRange(total, opts = {}) {
  const start = Number(opts.start ?? 0);
  const requested = Number(opts.duration ?? 3);
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(start) || start < 0 || start >= total) {
    throw new Error('起始时间必须在视频时长范围内');
  }
  if (!Number.isFinite(requested) || requested <= 0) throw new Error('片段时长必须大于 0');
  const duration = Math.min(requested, total - start);
  if (duration > limits.maxDuration) throw new Error('片段最长为 30 秒');
  if (duration + 1e-9 < Math.min(limits.minDuration, total)) throw new Error('片段至少为 0.1 秒');
  // 靠近结尾的极短片段仍取中间帧，避免请求越过最后一帧。
  if (opts.cover !== undefined && (!Number.isFinite(opts.cover) || opts.cover < start || opts.cover > start + duration)) {
    throw new Error('封面必须位于保留的片段内');
  }
  const stillTime = opts.cover !== undefined ? opts.cover - start
    : opts.stillAt === 'end' && duration > 0.2 ? duration - 0.1 : duration / 2;
  return { start, duration, stillTime };
}

async function renderClip(src, opts, tmp, context) {
  const info = await videoInfo(src, context);
  const clip = clipRange(info.duration, opts);
  const ratios = { original: null, '1:1': 1, '9:16': 9 / 16, '16:9': 16 / 9, '3:4': 3 / 4 };
  const aspect = opts.aspect ?? 'original';
  if (!Object.hasOwn(ratios, aspect)) throw new Error('不支持所选画面比例');
  const ratio = ratios[aspect];
  let crop;
  if (ratio) {
    const width = Math.floor(Math.min(info.width, info.height * ratio) / 2) * 2;
    const height = Math.floor(Math.min(info.height, info.width / ratio) / 2) * 2;
    if (width < 2 || height < 2) throw new Error('视频画面尺寸太小');
    crop = { width, height };
  }
  const size = limits.outputSize(crop?.width ?? info.width, crop?.height ?? info.height);
  const still = path.join(tmp, 'still.jpg');
  const video = path.join(tmp, 'clip.mp4');
  await encodeVideo({ src, ...clip, out: video, ...size, fps: info.fps, mute: !!opts.mute, crf: 20, crop }, { ...context, directory: tmp });
  // 从实际编码后的片段抽帧，保证封面与输出的时间轴相同。
  context?.onProgress?.({ phase: 'validating' });
  const actual = await videoInfo(video, context);
  const actualDuration = actual.duration;
  if (Math.abs(actualDuration - clip.duration) > 1 / actual.fps + 0.002 || actual.width > size.width || actual.height > size.height || actual.fps > limits.maxFps + 0.01) throw new Error('成片规格验证失败');
  const stillTime = Math.max(0, Math.min(clip.stillTime, actualDuration - 0.05));
  await extractStill(video, stillTime, still, 0, context);
  await limits.checkOutput([still,video]);
  return { still, video, stillTime, duration: actualDuration };
}

async function prepareAppleResources(src, opts, context) {
  const native = require('./native');
  native.needNative();
  await limits.checkSpace(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(storage.root(), 'lp-photo-'));
  try {
    const { still, video, stillTime, duration } = await renderClip(src, opts, directory, context);
    const identifier = crypto.randomUUID().toUpperCase();
    await native.run(['prepare', still, video, directory, identifier, String(stillTime)], { ...context, directory });
    await limits.checkOutput([path.join(directory,'photo.JPG'),path.join(directory,'photo.MOV')]);
    return { directory, identifier, validated: true, video, duration, stillTime,
      still: path.join(directory, 'photo.JPG'), movie: path.join(directory, 'photo.MOV') };
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

async function preparePhoto(src, opts = {}, context = {}) {
  return prepareDelivery(src,{...opts,destination:'photos'},context);
}

async function prepareDeliveryResources(src, opts, context) {
  const name = path.basename(src);
  const stem = path.basename(src, path.extname(src));
  if (opts.destination === 'photos') {
    return { ...await prepareAppleResources(src, opts, context), destination: 'photos', name, stem, mute: !!opts.mute };
  }
  if (opts.destination !== 'file') throw new Error('请选择保存到照片或导出文件');
  await limits.checkSpace(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(storage.root(), 'lp-export-'));
  try {
    const rendered = await renderClip(src, opts, directory, context);
    const output = path.join(directory, 'output.MP.JPG');
    await buildMotionPhoto({ stillFile: rendered.still, videoFile: rendered.video, outFile: output,
      tsUs: Math.round(rendered.stillTime * 1e6) }, context);
    if (!(await verifyMotionPhoto(output)).ok) throw new Error('动态照片文件结构验证失败');
    return { ...rendered, directory, output, name, stem, destination: 'file', mute: !!opts.mute };
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

async function savePrepared(prepared, outdir) {
  if (prepared.destination === 'photos') {
    await require('./native').run(['import', prepared.still, prepared.movie]);
    return { destination: 'photos', saved: true };
  }
  if (typeof outdir !== 'string' || !outdir) throw new Error('请选择导出位置');
  await fs.promises.mkdir(outdir, { recursive: true });
  await limits.checkSpace(outdir, fs.statSync(prepared.output).size);
  for (let index = 1; ; index++) {
    const name = `${prepared.stem}${index === 1 ? '' : ` (${index})`}.MP.JPG`;
    const output = path.join(outdir, name);
    let handle;
    try { handle = await fs.promises.open(output,'wx'); }
    catch (error) { if (error.code === 'EEXIST') continue; throw error; }
    try {
      for await (const data of fs.createReadStream(prepared.output)) await handle.writeFile(data);
      const size = (await handle.stat()).size;
      await handle.close();
      return { destination:'file',path:output,name,size };
    } catch (error) {
      await handle.close();
      await fs.promises.rm(output,{force:true});
      throw error;
    }
  }
}

// Direct core callers retain a one-step operation; the app uses prepare/confirm.
async function processVideo(src, opts, onLog = () => {}) {
  onLog('正在生成成片');
  const prepared = await prepareDelivery(src, opts);
  try {
    onLog('正在保存成片');
    return await savePrepared(prepared, opts.outdir);
  } finally { fs.rmSync(prepared.directory, { recursive: true, force: true }); }
}

async function prepareDelivery(src, opts, context = {}) {
  const signal = AbortSignal.any([context.signal || new AbortController().signal, AbortSignal.timeout(300000)]);
  try { return await prepareDeliveryResources(src,opts,{...context,signal}); }
  catch (error) { if (signal.reason?.name === 'TimeoutError') throw new Error('生成成片超过 5 分钟，已停止'); throw error; }
}

module.exports = {
  resolveBin, need, videoInfo, extractStill, encodeVideo,
  buildMotionPhoto, verifyMotionPhoto, clipRange, preparePhoto, prepareDelivery, savePrepared, processVideo, platTag,
};
