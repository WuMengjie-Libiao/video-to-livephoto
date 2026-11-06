'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
function root() {
  if (process.lpWorkRoot) return process.lpWorkRoot;
  for (const entry of fs.readdirSync(os.tmpdir())) {
    const match = /^photolive-work-(\d+)-[0-9a-f-]+$/.exec(entry);
    if (!match) continue;
    let inactive = false;
    try { process.kill(Number(match[1]),0); } catch(error) { inactive = error.code === 'ESRCH'; }
    if (inactive) fs.rmSync(path.join(os.tmpdir(),entry),{recursive:true,force:true});
  }
  process.lpWorkRoot = path.join(os.tmpdir(),`photolive-work-${process.pid}-${randomUUID()}`);
  fs.mkdirSync(process.lpWorkRoot);
  return process.lpWorkRoot;
}
async function cleanup() { if (process.lpWorkRoot) await fs.promises.rm(process.lpWorkRoot,{recursive:true,force:true}); }
module.exports = {root,cleanup};
