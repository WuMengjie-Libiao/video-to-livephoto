// 下载可随包分发的 ffmpeg 到 desktop/bin/<platform>-<arch>/
// 用法：npm run fetch:ffmpeg
// Windows 使用 BtbN gpl-shared；macOS 使用 OSXExperts 原生架构静态版。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createHash } from 'node:crypto';
import { extractArchive } from './extract-archive.mjs';

const root = path.resolve(import.meta.dirname, '..');
const platTag = process.platform === 'win32' ? 'win'
  : process.platform === 'darwin' ? 'mac' : 'linux';
const plat = `${platTag}-${process.arch}`;
const dest = path.join(root, 'bin', plat);
const cache = path.join(root, '.cache');

async function download(url, out) {
  console.log(`↓ ${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`下载失败 ${res.status} ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(out, buf);
  console.log(`   ${(buf.length / 1048576).toFixed(1)} MB`);
}

function findFile(dir, name) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const hit = findFile(p, name);
      if (hit) return hit;
    } else if (entry.name === name) {
      return p;
    }
  }
  return null;
}

async function fetchWindows() {
  const api = 'https://api.github.com/repos/BtbN/FFmpeg-Builds/releases/latest';
  const rel = await (await fetch(api, { headers: { 'User-Agent': 'livephoto-build' } })).json();
  const asset = (rel.assets || []).find((a) => /win64-gpl-shared(-\d+\.\d+)?\.zip$/.test(a.name));
  if (!asset) throw new Error('没找到合适的 Windows 构建');
  fs.mkdirSync(cache, { recursive: true });
  const zip = path.join(cache, 'ffmpeg-win64.zip');
  await download(asset.browser_download_url, zip);
  const tmp = path.join(cache, 'ffmpeg-win64');
  extractArchive(zip, tmp);
  const binDir = path.dirname(findFile(tmp, 'ffmpeg.exe'));
  fs.mkdirSync(dest, { recursive: true });
  for (const f of fs.readdirSync(binDir)) {
    if (f === 'ffplay.exe') continue; // 用不到，省 18MB
    fs.copyFileSync(path.join(binDir, f), path.join(dest, f));
  }
}

async function fetchMac() {
  // 使用原生架构静态构建，校验发布方 SHA256。
  const arm = {
    ffmpeg: ['https://www.osxexperts.net/ffmpeg902arm.zip', '762f16b2913b8d3b8fdb8092df12b691053b035b13ae9b88205513c55cb8e71e'],
    ffprobe: ['https://www.osxexperts.net/ffprobe902arm.zip', 'e9d3ad989b11d1ff4e3b0d140df170a6b38f194f83ac77f0e05a127a0f3a0ae4'],
  };
  fs.mkdirSync(cache, { recursive: true });
  fs.mkdirSync(dest, { recursive: true });
  for (const name of ['ffmpeg', 'ffprobe']) {
    const intel = {
      ffmpeg: ['https://www.osxexperts.net/ffmpeg80intel.zip', 'df3f1e3facdc1ae0ad0bd898cdfb072fbc9641bf47b11f172844525a05db8d11'],
      ffprobe: ['https://www.osxexperts.net/ffprobe80intel.zip', '5228e651e2bd67bb55819b27f6138351587b16d2b87446007bf35b7cf930d891'],
    };
    if (!['arm64', 'x64'].includes(process.arch)) throw new Error('不支持此 Mac 架构');
    const [url, hash] = (process.arch === 'arm64' ? arm : intel)[name];
    const zip = path.join(cache, `${name}.zip`);
    await download(url, zip);
    const tmp = path.join(cache, `${name}-x`);
    extractArchive(zip, tmp);
    const bin = findFile(tmp, name);
    if (!bin) throw new Error(`${name} 解压后没找到可执行文件`);
    if (hash && createHash('sha256').update(fs.readFileSync(bin)).digest('hex') !== hash) {
      throw new Error(`${name} SHA256 与发布方不一致`);
    }
    fs.copyFileSync(bin, path.join(dest, name));
    fs.chmodSync(path.join(dest, name), 0o755);
    execFileSync(path.join(dest, name), ['-version'], { stdio: 'pipe' });
  }
}

try {
  if (process.platform === 'win32') await fetchWindows();
  else if (process.platform === 'darwin') await fetchMac();
  else throw new Error('Linux 请自行把 ffmpeg 放进 bin/，或用系统的');

  const total = fs.readdirSync(dest).reduce((s, f) => s + fs.statSync(path.join(dest, f)).size, 0);
  console.log(`\n✅ 已就位：${dest}`);
  console.log(`   ${(total / 1048576).toFixed(1)} MB，打包时会一起塞进安装包`);
  console.log('   校验：', execFileSync(path.join(dest, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'),
    ['-hide_banner', '-version'], { encoding: 'utf8' }).split('\n')[0]);
} catch (e) {
  console.error('❌', e.message);
  console.error('   也可以手动下载 ffmpeg.exe / ffprobe.exe（含依赖 DLL）放进 bin/' + plat + '/');
  process.exit(1);
}
