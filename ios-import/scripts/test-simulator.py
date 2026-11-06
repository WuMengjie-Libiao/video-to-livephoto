#!/usr/bin/env python3
"""Native integration checks on an explicitly isolated PhotoLive simulator."""
import argparse
import json
import pathlib
import subprocess
import time

ROOT = pathlib.Path(__file__).resolve().parents[2]
BUNDLE = 'com.suikii.livephoto.importer'
parser = argparse.ArgumentParser()
parser.add_argument('device', help='UDID of an isolated simulator whose name starts with PhotoLive')
args = parser.parse_args()

def run(*command, capture=False):
    return subprocess.run(command, cwd=ROOT, check=True, text=True,
                          stdout=subprocess.PIPE if capture else None).stdout

def sim(*command, capture=False):
    return run('xcrun', 'simctl', *command, capture=capture)

inventory = json.loads(sim('list', 'devices', '--json', capture=True))
device = next((d for group in inventory['devices'].values() for d in group if d['udid'] == args.device), None)
if not device or not device['name'].startswith('PhotoLive'):
    raise SystemExit('Use a dedicated PhotoLive test simulator; this check writes only to its Photos library.')
if device['state'] != 'Booted':
    sim('boot', args.device)
sim('bootstatus', args.device, '-b')
run(str(ROOT / 'ios-import/scripts/build-simulator.sh'), '--checks')
app = ROOT / 'ios-import/build/simulator-checks/LivePhoto.app'
ffmpeg = ROOT / 'desktop/bin/mac-arm64/ffmpeg'
base = ROOT / 'ios-import/build/fixture-base.mp4'
run(str(ffmpeg), '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30:duration=4',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-c:v', 'libx264', '-c:a', 'aac', '-shortest', '-y', str(base))
run(str(ffmpeg), '-v', 'error', '-i', str(base), '-c', 'copy', '-metadata:s:v:0', 'rotate=90', '-y', str(app / 'fixture.mp4'))
run('codesign', '--force', '--sign', '-', str(app))
# A first install has no running process. A second run replaces only this test app.
subprocess.run(['xcrun', 'simctl', 'terminate', args.device, BUNDLE], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
sim('install', args.device, str(app))
sim('privacy', args.device, 'reset', 'photos-add', BUNDLE)
documents = pathlib.Path(sim('get_app_container', args.device, BUNDLE, 'data', capture=True).strip()) / 'Documents'
for marker in ['checkpoint', 'continue', 'continue-preview', 'result']:
    (documents / marker).unlink(missing_ok=True)
sim('ui', args.device, 'appearance', 'light')
sim('ui', args.device, 'content_size', 'large')
sim('launch', args.device, BUNDLE)

def wait_for(file, value=None):
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        failure = documents / 'result'
        if failure.exists() and failure.read_text().startswith('FAILED'):
            raise SystemExit(failure.read_text())
        if file.exists() and (value is None or file.read_text() == value):
            return file.read_text()
        time.sleep(0.1)
    raise SystemExit(f'Timed out waiting for {file.name}: {value}')

shots = ROOT / '.shots'
shots.mkdir(exist_ok=True)
wait_for(documents / 'checkpoint', 'editor')
sim('io', args.device, 'screenshot', str(shots / 'iphone-editor.png'))
sim('ui', args.device, 'appearance', 'dark')
sim('ui', args.device, 'content_size', 'accessibility-extra-large')
time.sleep(0.4)
sim('io', args.device, 'screenshot', str(shots / 'iphone-editor-large-dark.png'))
sim('ui', args.device, 'content_size', 'large')
(documents / 'continue').touch()
wait_for(documents / 'checkpoint', 'preview')
time.sleep(0.4)
sim('io', args.device, 'screenshot', str(shots / 'iphone-preview-dark.png'))
# No Photos write permission was granted before the actual live preview existed.
sim('privacy', args.device, 'grant', 'photos-add', BUNDLE)
(documents / 'continue-preview').touch()
# simctl terminates apps when permissions change; restart the harness with the
# existing checkpoints to exercise the same confirmation flow with write access.
sim('launch', args.device, BUNDLE)
print(wait_for(documents / 'result'))
