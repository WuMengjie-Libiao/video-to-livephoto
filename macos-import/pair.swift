// 兼容历史的成对文件入口；验证和写入统一交由桌面端的原生组件。
import Foundation
let args = Array(CommandLine.arguments.dropFirst())
guard args.count == 2 else { print("用法：swift macos-import/pair.swift <静图.jpg> <视频.mov>"); exit(2) }
#if arch(arm64)
let architecture = "arm64"
#else
let architecture = "x64"
#endif
let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
let binary = root.appendingPathComponent("desktop/native/bin/\(architecture)/livephoto")
guard FileManager.default.isExecutableFile(atPath: binary.path) else {
    print("先在 desktop 目录运行 npm run build:native，或直接使用桌面应用保存到照片。")
    exit(1)
}
let task = Process()
task.executableURL = binary
task.arguments = ["import"] + args.map { URL(fileURLWithPath: $0).path }
do { try task.run(); task.waitUntilExit(); exit(task.terminationStatus) }
catch { print(error.localizedDescription); exit(1) }
