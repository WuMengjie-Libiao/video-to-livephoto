'use strict';
const fs = require('fs');
const path = require('path');
const { run: runProcess } = require('./media-process');

function needNative() {
  if (process.platform !== 'darwin') throw new Error('直接保存到照片需要 macOS');
  const root = process.lpResourcesDir || path.join(__dirname, '..');
  const binary = path.join(root, 'native', 'bin', process.arch, 'livephoto');
  if (!fs.existsSync(binary)) throw new Error('缺少照片组件，请运行 npm run build:native 或重新安装应用');
  return binary;
}
async function run(args, context = {}) {
  const { stdout } = await runProcess(needNative(), args, { ...context,
    onProgress:undefined, timeout: args[0] === 'import' ? 0 : 300000, maxBuffer: 1024 * 1024 });
  return JSON.parse(stdout.toString());
}
module.exports = { needNative, run };
