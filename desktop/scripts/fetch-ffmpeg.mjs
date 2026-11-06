// Download the exact redistributable tools used for this release, with their notices.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createHash } from 'node:crypto';
import { extractArchive } from './extract-archive.mjs';
const root=path.resolve(import.meta.dirname,'..');
const release=JSON.parse(fs.readFileSync(path.join(import.meta.dirname,'ffmpeg-release.json'),'utf8'));
const platform=`${process.platform==='win32'?'win':process.platform==='darwin'?'mac':'linux'}-${process.arch}`;
const artifact=release.artifacts[platform];
if(!artifact)throw new Error(`不支持自动下载 ${platform}；请使用本机 FFmpeg`);
const cache=path.join(root,'.cache');fs.mkdirSync(cache,{recursive:true});
const archive=path.join(cache,artifact.filename);
const url=`https://github.com/${release.repository}/releases/download/${release.tag}/${artifact.filename}`;
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
if(!fs.existsSync(archive)||hash(archive)!==artifact.sha256){
  console.log(`下载 FFmpeg ${release.version}: ${url}`);
  const response=await fetch(url,{signal:AbortSignal.timeout(120000)});
  if(!response.ok)throw new Error(`工具下载失败：${response.status}`);
  fs.writeFileSync(archive,Buffer.from(await response.arrayBuffer()));
}
if(hash(archive)!==artifact.sha256)throw new Error('FFmpeg 压缩包校验失败');
const extracted=path.join(cache,`ffmpeg-${platform}-extracted`);
extractArchive(archive,extracted);
function find(directory,name){
  for(const entry of fs.readdirSync(directory,{withFileTypes:true})){
    const file=path.join(directory,entry.name);
    if(entry.isDirectory()){const result=find(file,name);if(result)return result;}
    else if(entry.name===name)return file;
  }
}
const dest=path.join(root,'bin',platform);fs.mkdirSync(dest,{recursive:true});
for(const [name,expected] of Object.entries(artifact.binary_sha256)){
  const file=find(extracted,name);
  if(!file||hash(file)!==expected)throw new Error(`${name} 校验失败`);
  const target=path.join(dest,name);fs.copyFileSync(file,target);
  if(process.platform!=='win32')fs.chmodSync(target,0o755);
  const version=execFileSync(target,['-version'],{encoding:'utf8'}).split('\n')[0];
  if(!version.includes(release.version))throw new Error(`${name} 版本不匹配`);
  console.log(version);
}
const notices=find(extracted,'THIRD_PARTY_NOTICES.txt');
if(!notices)throw new Error('发行工具缺少第三方许可说明');
fs.copyFileSync(notices,path.join(dest,'THIRD_PARTY_NOTICES.txt'));
const sourceBase=`https://github.com/${release.repository}/releases/download/${release.tag}/`;
fs.writeFileSync(path.join(dest,'SOURCE.md'),`# FFmpeg ${release.version}\n\n构建及许可：${sourceBase}manifest.json\n\n对应源码、构建材料和许可文件：\n\n${artifact.source_files.map(name=>`- [${name}](${sourceBase}${name})`).join('\n')}\n`);
console.log(`已校验并安装工具与许可材料：${dest}`);
