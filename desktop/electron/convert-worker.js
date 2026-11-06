'use strict';
const { parentPort, workerData } = require('worker_threads');
// Electron 的 resourcesPath 不是普通 Node worker 的契约，显式传入打包资源位置。
if (workerData.resourcesPath) {
  process.lpResourcesDir = workerData.resourcesPath;
}
const core = require('./core');
try {
  let result;
  switch (workerData.command) {
    case 'probe': result = { ...core.videoInfo(workerData.src), size: require('fs').statSync(workerData.src).size }; break;
    case 'prepare': result = core.prepareDelivery(workerData.src, workerData.opts); break;
    case 'save': result = core.savePrepared(workerData.opts.prepared, workerData.opts.outdir); break;
    default: throw new Error('未知的后台任务');
  }
  parentPort.postMessage({ type: 'result', result });
} catch (error) {
  parentPort.postMessage({ type: 'error', error: error.message || String(error) });
}
