// 开发模式：先起 Vite，再拉起 Electron（不额外依赖 concurrently/wait-on）
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(import.meta.dirname, '..');
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

const vite = spawn(npx, ['vite', '--port', '5173', '--strictPort'], {
  cwd: root, stdio: 'inherit', shell: process.platform === 'win32',
});

function waitPort(port, tries = 60) {
  return new Promise((resolve, reject) => {
    const tick = (n) => {
      const s = net.connect(port, '127.0.0.1');
      s.once('connect', () => { s.destroy(); resolve(); });
      s.once('error', () => {
        s.destroy();
        if (n <= 0) reject(new Error('Vite 端口没起来'));
        else setTimeout(() => tick(n - 1), 500);
      });
    };
    tick(tries);
  });
}

let electron;
try {
  await waitPort(5173);
  const electronBin = path.join(root, 'node_modules', 'electron', 'cli.js');
  const env = { ...process.env, VITE_DEV: '1' };
  // 某些环境会设这个变量，让 Electron 退化成纯 Node（require('electron') 会失效）
  delete env.ELECTRON_RUN_AS_NODE;
  electron = spawn(process.execPath, [electronBin, '.'], {
    cwd: root,
    stdio: 'inherit',
    env,
  });
  electron.on('exit', () => { vite.kill(); process.exit(0); });
} catch (e) {
  console.error(e.message);
  vite.kill();
  process.exit(1);
}

process.on('SIGINT', () => { vite.kill(); electron?.kill(); process.exit(0); });
