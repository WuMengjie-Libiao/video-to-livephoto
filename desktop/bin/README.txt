随包分发的视频组件存放目录。

在 desktop 运行 npm run fetch:ffmpeg，下载到 bin/win-x64、bin/mac-arm64 或 bin/mac-x64。
Windows 使用 BtbN 的 gpl-shared（包含 libx264）；Mac 使用 OSXExperts 对应架构的静态构建，并检查发布方 SHA256。
Windows 共享构建需要同目录 DLL，不能只复制 ffmpeg.exe。

没有随包组件时使用系统 PATH / Homebrew 中的 FFmpeg 与 ffprobe。启动时会实际执行版本检查。
也可以使用 LP_FFMPEG 和 LP_FFPROBE 环境变量指定绝对路径。
