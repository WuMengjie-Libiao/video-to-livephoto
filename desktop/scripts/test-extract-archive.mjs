import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractArchive } from './extract-archive.mjs';

test('解压时特殊目录名作为路径处理，不执行其中的命令', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'livephoto-archive-'));
  try {
    const source = path.join(root, 'input.txt');
    fs.writeFileSync(source, 'archive contents');
    const special = path.join(root, "folder';throw 'injected");
    fs.mkdirSync(special);
    const zip = path.join(special, 'sample.zip');
    const dest = path.join(special, 'output');
    if (process.platform === 'win32') {
      execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
        'Compress-Archive -LiteralPath $env:LP_TEST_SOURCE -DestinationPath $env:LP_TEST_ZIP'],
        { env: { ...process.env, LP_TEST_SOURCE: source, LP_TEST_ZIP: zip } });
    } else {
      execFileSync('zip', ['-q', zip, 'input.txt'], { cwd: root });
    }
    extractArchive(zip, dest);
    assert.equal(fs.readFileSync(path.join(dest, 'input.txt'), 'utf8'), 'archive contents');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// Both supported archive formats must treat shell punctuation as literal paths.
test('tar.xz 解压保持特殊路径和文件内容', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'livephoto-tar-'));
  try {
    fs.writeFileSync(path.join(root,'input.txt'),'pinned tool archive');
    const special=path.join(root,"folder';throw 'injected");fs.mkdirSync(special);
    const archive=path.join(special,'sample.tar.xz');
    execFileSync('tar',['-cJf',archive,'-C',root,'input.txt']);
    extractArchive(archive,path.join(special,'out'));
    assert.equal(fs.readFileSync(path.join(special,'out/input.txt'),'utf8'),'pinned tool archive');
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
