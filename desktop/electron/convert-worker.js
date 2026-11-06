'use strict';
const { parentPort, workerData } = require('worker_threads');
if (workerData.resourcesPath) process.lpResourcesDir = workerData.resourcesPath;
process.lpWorkRoot = workerData.workRoot;
const core = require('./core');
const controller = new AbortController();
parentPort.on('message', message => { if (message.type === 'cancel') controller.abort(); });
(async () => {
  try {
    const context = { signal: controller.signal, onProgress: progress => parentPort.postMessage({type:'progress',progress}) };
    const result = workerData.command === 'prepare' ? await core.prepareDelivery(workerData.src,workerData.opts,context)
      : workerData.command === 'save' ? await core.savePrepared(workerData.opts.prepared,workerData.opts.outdir)
      : (() => { throw new Error('未知的后台任务'); })();
    parentPort.postMessage({type:'result',result});
  } catch (error) { parentPort.postMessage({type:controller.signal.aborted ? 'cancelled' : 'error',error:error.message}); }
  finally { parentPort.close(); }
})();
