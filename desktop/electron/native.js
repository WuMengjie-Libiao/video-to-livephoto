'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function needNative() {
  if (process.platform !== 'darwin') throw new Error('直接保存到照片需要 macOS');
  const root = process.lpResourcesDir || path.join(__dirname, '..');
  const binary = path.join(root, 'native', 'bin', process.arch, 'livephoto');
  if (!fs.existsSync(binary)) throw new Error('缺少照片组件，请运行 npm run build:native 或重新安装应用');
  return binary;
}
function runSync(args) {
  let output;
  try {
    output = execFileSync(needNative(), args, { encoding: 'utf8', timeout: 180000, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1024 * 1024 });
  } catch (error) {
    throw new Error(error.code === 'ETIMEDOUT' ? '照片处理超时，请确认系统授权窗口后重试' : String(error.stderr || error.message).trim());
  }
  return JSON.parse(output);
}
module.exports = { needNative, runSync };
