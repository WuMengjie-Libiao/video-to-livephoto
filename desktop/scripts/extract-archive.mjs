import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

export function extractArchive(zip, outDir) {
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  if (process.platform === 'win32') {
    execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      'Expand-Archive -LiteralPath $env:LP_ARCHIVE_PATH -DestinationPath $env:LP_ARCHIVE_DEST -Force'], {
      stdio: 'inherit', env: { ...process.env, LP_ARCHIVE_PATH: zip, LP_ARCHIVE_DEST: outDir },
    });
  } else {
    execFileSync('unzip', ['-q', '-o', zip, '-d', outDir], { stdio: 'inherit' });
  }
}
