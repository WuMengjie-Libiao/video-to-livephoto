'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const limits = require('./media-limits');
let active = 0, generating = 0;
const queue = [];
const closing = new AbortController(), pendingOperations = new Set();
function cancelError() { return Object.assign(new Error('已取消'), { name: 'AbortError', code: 'CANCELLED' }); }
function drain() {
  for (let i = 0; active < 2 && i < queue.length;) {
    const job = queue[i];
    if (generating && job.background) { i++; continue; }
    queue.splice(i, 1); active++; job.start();
  }
}
function setGenerating(value) { generating += value ? 1 : -1; drain(); }
function run(binary, args, options = {}) {
  const signal = AbortSignal.any([options.signal || new AbortController().signal,closing.signal]);
  const { timeout = 30000, background = false, onProgress, duration, files = [], directory,
    maxBuffer = 4 * 1024 * 1024, stallMs = onProgress ? 60000 : 0 } = options;
  const operation = new Promise((resolve, reject) => {
    let child, timer, monitor, forceTimer, failure, stdout = [], stderr = '', bytes = 0, pending = '', lastProgress = Date.now();
    const abort = () => stop(cancelError());
    const stop = error => {
      if (failure) return;
      failure = error;
      if (child) { child.kill(); forceTimer = setTimeout(() => child.kill('SIGKILL'), 2000); }
      else { const i = queue.indexOf(job); if (i >= 0) queue.splice(i, 1); finish(); }
    };
    const finish = () => {
      clearTimeout(timer); clearTimeout(forceTimer); clearInterval(monitor); signal?.removeEventListener('abort', abort);
      if (child) { active--; drain(); }
      if (failure) reject(failure); else resolve({ stdout: Buffer.concat(stdout), stderr });
    };
    const job = { background, start() {
      if (signal?.aborted) { active--; reject(cancelError()); drain(); return; }
      try { child = spawn(binary, args, { stdio: ['ignore','pipe','pipe'], windowsHide: true }); }
      catch (error) { active--; signal?.removeEventListener('abort', abort); reject(error); drain(); return; }
      if (timeout > 0) timer = setTimeout(() => stop(new Error('媒体处理超时，请缩短片段或更换素材')),timeout);
      monitor = setInterval(() => {
        if (stallMs && Date.now() - lastProgress > stallMs) stop(new Error('编码持续 60 秒无进展，已停止'));
        try {
          let total = 0;
          for (const file of files) { if (fs.existsSync(file)) total += fs.statSync(file).size; }
          if (total > limits.maxOutputBytes) stop(new Error('成片超过 50 MiB，请缩短片段'));
          if (directory) {
            const work = fs.readdirSync(directory).reduce((n, file) => n + fs.statSync(require('node:path').join(directory,file)).size, 0);
            if (work > limits.workBytes) stop(new Error('临时文件超过处理预算，请缩短片段'));
            const disk = fs.statfsSync(directory);
            if (disk.bavail * disk.bsize < limits.reserveBytes) stop(new Error('磁盘空间不足，请释放空间后重试'));
          }
        } catch (error) { stop(error); }
      }, 500);
      child.stdout.on('data', data => {
        if (onProgress) {
          pending += data.toString();
          const lines = pending.split('\n'); pending = lines.pop();
          for (const line of lines) if (line.startsWith('out_time_us=')) {
            const seconds = Number(line.slice(12)) / 1e6;
            if (seconds > (job.seconds || 0)) { job.seconds = seconds; lastProgress = Date.now(); }
            onProgress({ phase: 'encoding', fraction: Math.min(1, seconds / duration) });
          }
        } else { bytes += data.length; if (bytes > maxBuffer) stop(new Error('媒体组件返回数据过大')); else stdout.push(data); }
      });
      child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-65536); });
      child.on('error', error => { failure ||= error; });
      child.on('close', code => { if (code !== 0 && !failure) failure = new Error(stderr.trim() || `媒体组件退出（${code}）`); finish(); });
    } };
    if (signal?.aborted) { reject(cancelError()); return; }
    signal?.addEventListener('abort', abort, { once: true });
    queue.push(job); drain();
  });
  pendingOperations.add(operation);operation.then(()=>pendingOperations.delete(operation),()=>pendingOperations.delete(operation));
  return operation;
}
async function shutdown() { closing.abort(); await Promise.allSettled([...pendingOperations]); }
module.exports = { run, setGenerating, cancelError, shutdown };
