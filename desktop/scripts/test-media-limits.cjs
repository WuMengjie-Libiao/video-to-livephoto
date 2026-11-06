'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const core = require('../electron/core');

test('有效选段在最短时长和30秒之间，源不足时保留余长', () => {
  assert.throws(() => core.clipRange(100, { duration: 30.01 }), /30/);
  assert.throws(() => core.clipRange(100, { duration: 0.01 }), /0.1/);
  assert.equal(core.clipRange(100, { start: 60, duration: 30 }).duration, 30);
  assert.equal(core.clipRange(10, { start: 9.8, duration: 30 }).duration, 10 - 9.8);
  assert.equal(core.clipRange(0.06, { duration: 3 }).duration, 0.06);
});

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { run } = require('../electron/media-process');
const limits = require('../electron/media-limits');

test('横竖屏、正方形和小素材按相同比例规则约束输出', () => {
  assert.deepEqual(limits.outputSize(3840,2160),{width:1920,height:1080});
  assert.deepEqual(limits.outputSize(2160,3840),{width:1080,height:1920});
  assert.deepEqual(limits.outputSize(4000,4000),{width:1080,height:1080});
  assert.deepEqual(limits.outputSize(320,240),{width:320,height:240});
});
test('大文件在探测或读入视频内存前拒绝', async () => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'lp-size-test-'));
  try {
    const file=path.join(dir,'huge.mp4'); await fs.writeFile(file,'');
    await fs.truncate(file,limits.maxInputBytes+1);
    await assert.rejects(core.videoInfo(file),/4 GiB/);
    await fs.truncate(file,limits.maxOutputBytes+1);
    await assert.rejects(core.buildMotionPhoto({stillFile:file,videoFile:file,outFile:path.join(dir,'out.jpg'),tsUs:0}),/50 MiB/);
  } finally { await fs.rm(dir,{recursive:true,force:true}); }
});
test('取消真实子进程后才结束等待，不留下工作进程', async () => {
  const controller=new AbortController();
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'lp-cancel-test-')), pidfile=path.join(dir,'pid');
  try {
    const operation=run(process.execPath,['-e',`require('fs').writeFileSync(process.argv[1],String(process.pid)); setInterval(()=>{},1000)`,pidfile],{signal:controller.signal});
    for(let i=0;i<100;i++){try{await fs.access(pidfile);break;}catch{await new Promise(r=>setTimeout(r,10));}}
    const pid=Number(await fs.readFile(pidfile,'utf8'));
    controller.abort(); await assert.rejects(operation,{name:'AbortError'});
    assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
  } finally {await fs.rm(dir,{recursive:true,force:true});}
});
test('运行中的媒体进程按截止时间结束', async () => {
  await assert.rejects(run(process.execPath,['-e','setInterval(()=>{},1000)'],{timeout:50}),/超时/);
});
