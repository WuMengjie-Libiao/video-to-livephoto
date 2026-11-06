#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
APP_DIR="$PWD/build/simulator/LivePhoto.app"
SDK_PATH=$(xcrun --sdk iphonesimulator --show-sdk-path)
if [[ "${1:-}" == "--checks" ]]; then
  set -- -D SIMULATOR_CHECKS Tests/SimulatorChecks.swift
  APP_DIR="$PWD/build/simulator-checks/LivePhoto.app"
else
  set --
fi
mkdir -p "$APP_DIR"
SDKROOT="$SDK_PATH" xcrun --sdk iphonesimulator swiftc -parse-as-library -swift-version 5 -g \
  -sdk "$SDK_PATH" -target arm64-apple-ios16.0-simulator \
  "$@" Sources/*.swift ../shared/LivePhotoResources.swift \
  -o "$APP_DIR/LivePhoto"
python3 - "$APP_DIR/Info.plist" <<'PY'
import plistlib,sys
with open(sys.argv[1], 'wb') as f:
    plistlib.dump(dict(CFBundleIdentifier='com.suikii.livephoto.importer', CFBundleExecutable='LivePhoto',
        CFBundleName='LivePhoto', CFBundleDisplayName='实况照片', CFBundlePackageType='APPL',
        CFBundleVersion='1', CFBundleShortVersionString='0.1.0', MinimumOSVersion='16.0',
        CFBundleDevelopmentRegion='zh_CN', CFBundleLocalizations=['zh-Hans','en'],
        LSRequiresIPhoneOS=True, UIDeviceFamily=[1], UILaunchScreen={},
        UISupportedInterfaceOrientations=['UIInterfaceOrientationPortrait','UIInterfaceOrientationLandscapeLeft','UIInterfaceOrientationLandscapeRight'],
        NSPhotoLibraryAddUsageDescription='将你确认的实况照片保存到相册'), f)
PY
codesign --force --sign - "$APP_DIR"
echo "$APP_DIR"
