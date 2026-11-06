import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform === 'darwin') {
  const dest = path.join(root, 'native', 'bin', process.arch);
  fs.mkdirSync(dest, { recursive: true });
  execFileSync('xcrun', ['swiftc', '-parse-as-library', '-swift-version', '5', '-O',
    '-target', `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macosx12.0`,
    path.join(root, 'native/LivePhoto.swift'), '-o', path.join(dest, 'livephoto'),
    path.join(root, '../shared/LivePhotoResources.swift'),
    '-Xlinker', '-sectcreate', '-Xlinker', '__TEXT', '-Xlinker', '__info_plist',
    '-Xlinker', path.join(root, 'native/Info.plist')], { stdio: 'inherit' });
  execFileSync('codesign', ['--force', '--sign', '-', path.join(dest, 'livephoto')], { stdio: 'inherit' });
}
