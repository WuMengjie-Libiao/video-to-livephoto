# iPhone 实况照片

iOS 16 及以上，直接在手机上把视频变成实况照片，无需先在电脑上配对文件。

1. 从「照片」或「文件」选择一段视频。
2. 在视频下方拖动两端，截取自己喜欢的长度；白线控制播放位置，点「设为封面」选择静态画面。
3. 底部「原比例」默认保留视频方向和比例；可选择 1:1、9:16、16:9 或 3:4，画面将居中裁切，编辑画面会同步显示构图。按需关闭声音，点「预览」。这里播放的是已经生成、经过系统识别的实况照片，可以点击播放或长按画面。
4. 不满意就「返回调整」。满意后点「确认保存到照片」，首次保存才请求添加照片权限。

处理全程在本地。确认保存使用预览时生成的同一组资源，不再次编码；返回或关闭预览会释放临时文件。一次处理一段视频，换视频会重新选择片段。

## 本机开发与安装

项目保持原有的 `LivePhotoImporter` 目标名、bundle ID 和 iOS 16 部署要求；显示名称改为「实况照片」。

```bash
cd ios-import
brew install xcodegen
xcodegen generate
open LivePhotoImporter.xcodeproj
```

在 Xcode 选择自己的开发团队和连接的 iPhone，启用自动签名后运行。CI 构建会单独关闭签名以生成未签名产物；未签名 IPA 不能直接安装。

仓库的 **Actions → Build iOS IPA** 可以构建未签名 IPA。

## 验证

选段不变量（不需要模拟器）：

```bash
xcrun swiftc Sources/ClipSelection.swift Tests/SelectionCheck.swift -o /tmp/photolive-selection-check
/tmp/photolive-selection-check
```

常规 Xcode 测试：

```bash
xcodegen generate
xcodebuild -project LivePhotoImporter.xcodeproj -scheme LivePhotoImporter \
  -destination 'platform=iOS Simulator,name=iPhone 16' test
```

`./scripts/build-simulator.sh` 可以直接编译 Apple Silicon 模拟器应用；`--checks` 编入专用的集成检查入口（不属于发行目标）。完整模拟器检查：

```bash
# 使用独立测试模拟器，名称必须以 PhotoLive 开头；不要使用个人测试图库。
xcrun simctl create 'PhotoLive iPhone' com.apple.CoreSimulator.SimDeviceType.iPhone-16 \
  com.apple.CoreSimulator.SimRuntime.iOS-18-6
python3 scripts/test-simulator.py <上一步返回的设备ID>
```

检查使用 `../desktop/bin/mac-arm64/ffmpeg` 制作合成视频；在应用内验证导入、剪辑、封面和静音，保存截图到 `../.shots`，只写入指定模拟器的照片图库。先以未授权状态检查预览，再授予测试应用写入权限并重启测试入口完成保存阶段；这是 `simctl` 修改权限会结束应用的测试限制。不会触及 Mac 的个人照片图库。

用户已验证 iOS 导出功能可用。本机还在 iOS 18.6 模拟器验证选段、封面、旋转、静音/音轨、系统实况识别、预览不申请写入权限、返回调整、重新生成和确认写入。实际 iPhone 编码性能、相册长按体验、iCloud 同步和聊天软件分享仍需进一步验证；不保证能用作动态锁屏壁纸。

配对逻辑位于 `../shared/LivePhotoResources.swift`，与 Mac 共用。界面与状态在 `Sources` 中，视频剪辑由 AVFoundation 完成，不依赖 FFmpeg、网络或第三方媒体库。

当前本机 Xcode 的目标枚举提示缺少 iOS 26.5 平台组件，常规 `xcodebuild test` 未能启动。已使用当前 Apple SDK 直接编译，完成 iOS 18.6 模拟器运行检查，并单独编译 arm64 真机二进制；这不等同于 Xcode 测试套件已运行。
