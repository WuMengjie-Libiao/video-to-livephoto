# 视频 → 实况照片

把一小段视频留成实况照片。全部在本机处理，不需要账号或上传素材。

## 使用方式

在 macOS 12 或更新版本上选择视频，观看预览，拖动下方时间线两端选择片段，点击「设为封面」选定当前画面，然后点击 **预览并保存**。预览实际成片的封面、播放效果和声音，满意后再确认保存。批量视频可以逐张查看，返回调整后会重新生成。程序自动完成资源生成、系统识别验证和照片图库写入，每个视频在图库里对应一张实况照片，不需要模板、ExifTool 或手工配对。

首次保存需要允许添加照片。开启 iCloud 照片后，可同步到使用同一 Apple 账户的 iPhone；同步由系统负责。拒绝权限或保存失败时，界面会报告失败，不会把生成临时文件当成已保存。

也可以选择 **文件夹**，点击「预览并导出」，确认后每个视频导出一个 `名称.MP.JPG` 动态照片文件（Motion Photo）。已有同名文件会保留，新文件自动编号。Windows 默认使用文件导出。

**跨设备说明**：文件导出需要接收方的相册或应用支持 Motion Photo，不能保证任意应用或设备都识别。微信、抖音等平台的上传、分享、下载兼容性需要分别实测。Apple 图库路径使用系统支持的静图与配对视频资源，由应用自动处理，不暴露为三个散文件。

## 本机运行

需要 Node.js 20.11 或更高版本。开发 Mac 原生组件需要 Xcode Command Line Tools；打包后的应用不需要 Xcode 或 Swift。

```bash
cd desktop
npm ci
npm run fetch:ffmpeg
npm run dev
```

也可以使用系统安装的 FFmpeg 与 ffprobe。应用会执行组件检查，不仅检查文件是否存在。随包工具优先使用；可通过 `LP_FFMPEG` / `LP_FFPROBE` 指定绝对路径。

`fetch:ffmpeg` 在 Windows 下载 BtbN 的共享构建，在 Mac 下载 OSXExperts 对应架构的静态构建（校验发布方 SHA256）。它们是第三方 FFmpeg 分发，工具落在 `desktop/bin/<平台-架构>/`，不提交到 Git。分发包含 FFmpeg 的安装包时应遵循所选构建的许可证。

```bash
npm run start       # 编译原生组件、构建界面并打开应用
npm run build:mac   # 构建当前架构的 macOS dmg / zip
npm run build:win   # Windows portable / 安装包
npm run build:slim  # Windows 不内置 FFmpeg 的精简版
```

## 实现与边界

- React + Electron 剪辑式工作台：视频预览、缩略图时间线、起止拖柄、播放线及封面选择。每个视频独立保留选段；播放在选段终点停止，支持方向键微调。
- 本地视频通过支持字节范围的专用协议播放；播放器无法解码时才生成临时 H.264 预览副本，转换始终读取原视频。移除素材或退出应用时清理预览副本。
- FFmpeg 负责裁剪、H.264/AAC 编码和抽帧。默认 3 秒，可调整；默认保持原比例，也可逐段选择 1:1、9:16、16:9 或 3:4，使用居中裁切。素材剩余不足时使用实际余长；非法起点直接报错。
- 转换和素材探测在后台 worker 中执行，批量串行处理；主进程继续响应窗口和进度。
- Mac 使用 ImageIO 写封面配对标识，AVFoundation 写 MOV 内容标识及 `still-image-time` 时间轨，再用 `PHLivePhoto` 等待最终验证结果，通过 PhotoKit 保存。
- 导出前的成片只在临时目录生成，确认后交付同一份成片，不再重新编码。关闭预览会释放这些中间资源；预览阶段不写照片图库或导出目录。
- 原始视频不覆盖。Apple 中间素材在临时目录，处理结束后清理；文件导出通过排他写入避免覆盖旧结果。
- 仅请求照片添加权限，不承诺完成需要读取权限的相册回读。只有 PhotoKit 写入成功才报告保存成功。
- 目前最高输出高度 1080，不放大原始素材；只输出 JPEG 封面；不保证锁屏壁纸动画、HDR 保留、跨应用分享识别。
- 当前没有取消或断点续传；关闭应用可能中断处理。照片写入失败后可重试；已经保存成功的照片不会被自动删除。

## 验证

```bash
cd desktop
npm run build:native
npm run test:core
npm run build:ui
npm run test:desktop # 实际 Electron 的素材读取、进度、导出与窗口布局
```

测试自动合成含音轨的短片，不依赖未入库视频。覆盖时间范围、源文件保护、重名导出、单文件结构、静音和内嵌视频解码；在 Mac 还生成 Apple 配对资源、检查 MOV 内容标识/元数据轨、要求 `PHLivePhoto` 验证通过并拒绝不匹配资源。自动测试不写入个人照片图库。

iPhone 版本已在隔离模拟器完成系统实况识别和相册写入验证。Android 15 模拟器已验证编辑、预览、保存和生成文件结构。Windows 改动已在 Mac 的 Electron 中验证，尚未在 Windows 系统运行。Mac 的个人照片图库写入、真实手机安装体验、Android 各品牌图库识别、iCloud 同步、微信/抖音分享结果仍需实际设备验证。

## 目录

```text
desktop/
  src/                       React 工作台
  electron/core.js           片段处理与交付
  electron/convert-worker.js 后台任务
  electron/native.js         原生程序桥接
  native/LivePhoto.swift     Apple 素材生成、验证与照片写入
  scripts/                   开发、工具下载、原生构建与测试
macos-import/                历史成对文件的命令行导入入口
ios-import/                  iPhone 本地视频剪辑、实况预览与保存
android/                     Android 版源码与构建说明
legacy-python/               早期参考实现，不参与桌面应用
```

MIT License · 见 [LICENSE](LICENSE)

## iPhone 版

手机可以直接选视频、拖动时间线截取、选择封面和声音，先预览实际实况照片，再确认保存到相册。支持 iOS 16 及以上；本地构建、签名和验证说明见 [iPhone 版说明](ios-import/README.md)。手机端使用原生 SwiftUI 与 PhotosUI；桌面界面也补充了窄屏、触控、安全区和全屏预览布局，桌面安装包本身仍是 Electron 应用。
