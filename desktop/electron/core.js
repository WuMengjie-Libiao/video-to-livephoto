// core.js — 转换核心（纯 Node，不依赖 Electron）
// FFmpeg 负责媒体处理；原生桥接负责 Apple 资源及照片图库写入。
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
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

function ff(args) {
  return execFileSync(need('ffmpeg'), args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 256 * 1024 * 1024,
    encoding: 'buffer',
    windowsHide: true,
  });
}

function probe(file) {
  const out = execFileSync(need('ffprobe'),
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
    { encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  return JSON.parse(out);
}

function videoInfo(file) {
  const meta = probe(file);
  const vs = (meta.streams || []).find((s) => s.codec_type === 'video');
  if (!vs) throw new Error(`${path.basename(file)} 里没有视频流`);
  let w = Number(vs.width) || 0;
  let h = Number(vs.height) || 0;
  let rot = 0;
  for (const sd of vs.side_data_list || []) {
    if (sd.rotation) rot = Math.abs(Number(sd.rotation));
  }
  if (rot % 180 === 90) [w, h] = [h, w];
  const dur = Number(meta.format?.duration || vs.duration || 0);
  return { duration: dur, width: w, height: h };
}

function extractStill(video, ts, out, height) {
  const vf = height ? `scale=-2:${height}:flags=lanczos` : 'null';
  ff(['-y', '-v', 'error', '-ss', ts.toFixed(3), '-i', video, '-frames:v', '1',
    '-vf', vf, '-pix_fmt', 'yuvj420p', '-q:v', '2', out]);
  if (!fs.existsSync(out) || fs.statSync(out).size < 1024) throw new Error('抽帧失败（时间点可能超出视频长度）');
}

function encodeVideo({ src, start, duration, out, height, mute, crf, crop }) {
  const args = ['-y', '-v', 'error', '-ss', start.toFixed(3), '-t', duration.toFixed(3), '-i', src,
    '-map', '0:v:0', '-map', '0:a:0?'];
  if (mute) args.push('-an');
  else args.push('-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-ar', '48000');
  args.push('-vf', `${crop ? `crop=${crop.width}:${crop.height},` : ''}scale=-2:${height}:flags=lanczos`, '-c:v', 'libx264', '-profile:v', 'high',
    '-preset', 'medium', '-crf', String(crf), '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-f', 'mp4', out);
  ff(args);
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

function buildMotionPhoto({ stillFile, videoFile, outFile, tsUs }) {
  const jpeg0 = fs.readFileSync(stillFile);
  const video = fs.readFileSync(videoFile);
  const composed = insertApp1(jpeg0, xmpPacket({ tsUs, videoLen: video.length }));
  fs.writeFileSync(outFile, Buffer.concat([composed, video]));
}

function verifyMotionPhoto(file) {
  const data = fs.readFileSync(file);
  const i = data.indexOf('GCamera:MotionPhotoVersion');
  if (i < 0) return { ok: false, reason: '没有找到 XMP MotionPhoto 标记' };
  const start = data.lastIndexOf('<x:xmpmeta', i);
  const end = data.indexOf('</x:xmpmeta>', i);
  if (start < 0 || end < 0 || data.indexOf(XMP_NS) < 0) return { ok: false, reason: 'XMP 段不完整' };
  const xml = data.subarray(start, end).toString('utf8');
  const primary = xml.match(/Semantic="Primary"\s+Item:Length="(\d+)"/);
  const video = xml.match(/Mime="video\/mp4"[\s\S]*?Item:Length="(\d+)"/);
  const videoLen = video ? Number(video[1]) : -1;
  const total = data.length;
  const stillLen = total - videoLen;
  const ok = primary?.[1] === '0' && videoLen > 8 && stillLen > 4 &&
    data.readUInt16BE(0) === 0xffd8 && data.readUInt16BE(stillLen - 2) === 0xffd9 &&
    data.toString('ascii', stillLen + 4, stillLen + 8) === 'ftyp';
  return { ok, total, stillLen, videoLen };
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
  // 靠近结尾的极短片段仍取中间帧，避免请求越过最后一帧。
  if (opts.cover !== undefined && (!Number.isFinite(opts.cover) || opts.cover < start || opts.cover > start + duration)) {
    throw new Error('封面必须位于保留的片段内');
  }
  const stillTime = opts.cover !== undefined ? opts.cover - start
    : opts.stillAt === 'end' && duration > 0.2 ? duration - 0.1 : duration / 2;
  return { start, duration, stillTime };
}

function renderClip(src, opts, tmp) {
  const info = videoInfo(src);
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
  const height = Math.floor(Math.min(1080, crop?.height ?? info.height) / 2) * 2;
  const still = path.join(tmp, 'still.jpg');
  const video = path.join(tmp, 'clip.mp4');
  encodeVideo({ src, ...clip, out: video, height, mute: !!opts.mute, crf: 20, crop });
  // 从实际编码后的片段抽帧，保证封面与输出的时间轴相同。
  const actualDuration = videoInfo(video).duration;
  const stillTime = Math.max(0, Math.min(clip.stillTime, actualDuration - 0.05));
  extractStill(video, stillTime, still, 0);
  return { still, video, stillTime, duration: actualDuration };
}

function preparePhoto(src, opts = {}) {
  const native = require('./native');
  native.needNative();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-photo-'));
  try {
    const { still, video, stillTime, duration } = renderClip(src, opts, directory);
    const identifier = crypto.randomUUID().toUpperCase();
    native.runSync(['prepare', still, video, directory, identifier, String(stillTime)]);
    return { directory, identifier, validated: true, video, duration, stillTime,
      still: path.join(directory, 'photo.JPG'), movie: path.join(directory, 'photo.MOV') };
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

function prepareDelivery(src, opts) {
  const name = path.basename(src);
  const stem = path.basename(src, path.extname(src));
  if (opts.destination === 'photos') {
    return { ...preparePhoto(src, opts), destination: 'photos', name, stem, mute: !!opts.mute };
  }
  if (opts.destination !== 'file') throw new Error('请选择保存到照片或导出文件');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-export-'));
  try {
    const rendered = renderClip(src, opts, directory);
    const output = path.join(directory, 'output.MP.JPG');
    buildMotionPhoto({ stillFile: rendered.still, videoFile: rendered.video, outFile: output,
      tsUs: Math.round(rendered.stillTime * 1e6) });
    if (!verifyMotionPhoto(output).ok) throw new Error('动态照片文件结构验证失败');
    return { ...rendered, directory, output, name, stem, destination: 'file', mute: !!opts.mute };
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

function savePrepared(prepared, outdir) {
  if (prepared.destination === 'photos') {
    require('./native').runSync(['import', prepared.still, prepared.movie]);
    return { destination: 'photos', saved: true };
  }
  if (typeof outdir !== 'string' || !outdir) throw new Error('请选择导出位置');
  fs.mkdirSync(outdir, { recursive: true });
  for (let index = 1; ; index++) {
    const name = `${prepared.stem}${index === 1 ? '' : ` (${index})`}.MP.JPG`;
    const output = path.join(outdir, name);
    try {
      fs.copyFileSync(prepared.output, output, fs.constants.COPYFILE_EXCL);
      return { destination: 'file', path: output, name, size: fs.statSync(output).size };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
}

// Direct core callers retain a one-step operation; the app uses prepare/confirm.
function processVideo(src, opts, onLog = () => {}) {
  onLog('正在生成成片');
  const prepared = prepareDelivery(src, opts);
  try {
    onLog('正在保存成片');
    return savePrepared(prepared, opts.outdir);
  } finally { fs.rmSync(prepared.directory, { recursive: true, force: true }); }
}

module.exports = {
  resolveBin, need, videoInfo, extractStill, encodeVideo,
  buildMotionPhoto, verifyMotionPhoto, clipRange, preparePhoto, prepareDelivery, savePrepared, processVideo, platTag,
};
