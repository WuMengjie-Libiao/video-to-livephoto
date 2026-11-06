'use strict';
const fs = require('node:fs/promises');
const MiB = 1024 * 1024;
const limits = Object.freeze({ defaultDuration: 3, maxDuration: 30, minDuration: 0.1,
  maxInputBytes: 4 * 1024 * MiB, maxOutputBytes: 50 * MiB, workBytes: 256 * MiB,
  reserveBytes: 512 * MiB, maxLongEdge: 1920, maxShortEdge: 1080, maxFps: 30 });
function outputSize(width, height, longEdge = limits.maxLongEdge, shortEdge = limits.maxShortEdge) {
  if (!(width >= 2 && height >= 2)) throw new Error('视频画面尺寸太小');
  const scale = Math.min(1, longEdge / Math.max(width, height), shortEdge / Math.min(width, height));
  return { width: Math.floor(width * scale / 2) * 2, height: Math.floor(height * scale / 2) * 2 };
}
async function checkSpace(directory, additional = limits.workBytes) {
  const stat = await fs.statfs(directory);
  if (stat.bavail * stat.bsize < additional + limits.reserveBytes) throw new Error('磁盘空间不足，请释放空间后重试');
}
async function checkInput(file) {
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size === 0) throw new Error('视频文件为空或不可读取');
  if (stat.size > limits.maxInputBytes) throw new Error('原视频超过 4 GiB，请先裁剪素材');
  return stat;
}
async function checkOutput(files) {
  const stats = await Promise.all(files.map(file => fs.stat(file)));
  if (stats.reduce((n, s) => n + s.size, 0) > limits.maxOutputBytes) throw new Error('成片超过 50 MiB，请缩短片段');
}
module.exports = { ...limits, outputSize, checkSpace, checkInput, checkOutput };
