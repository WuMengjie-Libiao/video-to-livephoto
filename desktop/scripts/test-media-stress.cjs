'use strict';
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const core=require('../electron/core');
const {run}=require('../electron/media-process');
const storage=require('../electron/media-storage');
(async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lp-stress-'));
  const metrics=[];
  let peak=0;
  const monitor=process.platform==='darwin'?setInterval(()=>{
    const rows=execFileSync('/bin/ps',['-axo','pid=,ppid=,rss='],{encoding:'utf8'}).trim().split('\n').map(x=>x.trim().split(/\s+/).map(Number));
    const ids=new Set([process.pid]); let changed=true;
    while(changed){changed=false;for(const [id,parent] of rows)if(ids.has(parent)&&!ids.has(id)){ids.add(id);changed=true;}}
    peak=Math.max(peak,rows.reduce((n,[id,,rss])=>n+(ids.has(id)?rss:0),0));
  },300):null;
  try{
    for(const fixture of [{name:'raw-1080p30-30s',size:'1920x1080',fps:30,duration:30,raw:true},{name:'4k60-3s',size:'3840x2160',fps:60,duration:3}]){
      const source=path.join(dir,fixture.name+(fixture.raw?'.avi':'.mp4'));
      await run(core.need('ffmpeg'),['-v','error','-f','lavfi','-i',`testsrc2=size=${fixture.size}:rate=${fixture.fps}:duration=${fixture.duration}`,
        '-c:v',fixture.raw?'rawvideo':'libx264',...(fixture.raw?[]:['-preset','ultrafast']),source],{timeout:120000});
      const started=Date.now(); let prepared;
      try{
        prepared=await core.prepareDelivery(source,{destination:fixture.raw?'file':'photos',duration:fixture.duration,cover:fixture.duration/2});
        const info=await core.videoInfo(prepared.video);
        assert.ok(info.fps<=30.01);assert.ok(info.duration<=fixture.duration+1/info.fps+0.002);
        assert.ok(Math.max(info.width,info.height)<=1920 && Math.min(info.width,info.height)<=1080);
        metrics.push({fixture:fixture.name,inputBytes:fs.statSync(source).size,outputBytes:fs.statSync(prepared.output||prepared.movie).size,elapsedSeconds:(Date.now()-started)/1000,...info});
      }finally{if(prepared)fs.rmSync(prepared.directory,{recursive:true,force:true});fs.rmSync(source,{force:true});}
    }
    console.log(JSON.stringify({metrics,sampledProcessTreePeakKiB:peak,scope:'CLI conversion process tree; includes fixture generation; not renderer or device memory'}));
  }finally{clearInterval(monitor);fs.rmSync(dir,{recursive:true,force:true});await storage.cleanup();}
})().catch(error=>{console.error(error);process.exitCode=1;});
