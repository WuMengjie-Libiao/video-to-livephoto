// Built only by build-simulator.sh --checks; never part of the shipping target.
import SwiftUI
import AVFoundation
import Photos
import ImageIO

@main
struct SimulatorChecks: App {
    @StateObject private var model = EditorModel()
    var body: some Scene {
        WindowGroup { ContentView(model: model).task { await check() } }
    }
    @MainActor private func check() async {
        let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        func record(_ name: String, _ text: String) { try! text.write(to: documents.appendingPathComponent(name), atomically: true, encoding: .utf8) }
        func require(_ value: Bool, _ reason: String) throws { if !value { throw Failure(reason) } }
        func wait(_ condition: () -> Bool) async throws {
            for _ in 0..<600 { if condition() { return }; try await Task.sleep(nanoseconds: 50_000_000) }
            throw Failure("等待界面状态超时：\(model.error ?? "无错误信息")")
        }
        do {
            var selection = try ClipSelection(duration: 12)
            selection.setStart(2); try require(selection.cover == 2, "封面应跟随起点")
            selection.setEnd(12); selection.setCover(8); selection.setEnd(4)
            try require(selection.cover == 4 && selection.length == 2, "终点应约束封面")
            selection.setStart(0); selection.setEnd(12)
            try require(selection.length == 12, "用户应可选择长片段")
            var short = try ClipSelection(duration: 0.06); short.setStart(2); short.setEnd(-1)
            try require(short.start == 0 && short.end == 0.06, "短视频不能产生负范围")
            for invalid in [0, -1, Double.infinity, Double.nan] {
                var rejected = false
                do { _ = try ClipSelection(duration: invalid) } catch { rejected = true }
                try require(rejected, "非法时长被接受")
            }
            var bounded = try ClipSelection(duration:3600)
            bounded.setEnd(3600); try require(bounded.length==30,"选段最长30秒")
            bounded.setCover(15); bounded.move(to:3500); try require(bounded.cover==3515,"选区整体移动保持封面偏移")
            let large = documents.appendingPathComponent("too-large.mp4")
            FileManager.default.createFile(atPath:large.path,contents:nil)
            let largeHandle=try FileHandle(forWritingTo:large);try largeHandle.truncate(atOffset:UInt64(MediaLimits.inputBytes+1));try largeHandle.close()
            do { _ = try await ImportedMovie.copy(large); throw Failure("超大素材未拒绝") }
            catch { try require(error.localizedDescription.contains("1 GiB"),"超大素材应有准确错误") }
            try FileManager.default.removeItem(at:large)
            let longSource=Bundle.main.url(forResource:"fixture-long",withExtension:"mp4")!
            let exportURL=documents.appendingPathComponent("cancel-before-start.mov")
            let exporter=AVAssetExportSession(asset:AVURLAsset(url:longSource),presetName:AVAssetExportPreset1920x1080)!
            exporter.outputURL=exportURL;exporter.outputFileType = .mov
            let session=ExportOperation(exporter);session.cancel()
            do{try await session.run();throw Failure("先取消后启动仍执行导出")}catch is CancellationError{}
            let cancellation=Task { try await VideoConversion.prepare(longSource,clip:ClipSelection(duration:30),mute:false,aspect:.original) }
            cancellation.cancel()
            do { _ = try await cancellation.value; throw Failure("已取消任务仍生成成片") } catch is CancellationError { }
            var longClip=try ClipSelection(duration:30);longClip.setEnd(30);longClip.setCover(15)
            let interrupted=Task{try await VideoConversion.prepare(longSource,clip:longClip,mute:false,aspect:.original)}
            try await Task.sleep(nanoseconds:100_000_000);interrupted.cancel()
            do{_ = try await interrupted.value;throw Failure("生成中取消未生效")}catch is CancellationError{}
            let thirty=try await VideoConversion.prepare(longSource,clip:longClip,mute:false,aspect:.original)
            try require(abs(thirty.duration-30)<0.08,"30秒资源应完整生成")
            let source = Bundle.main.url(forResource: "fixture", withExtension: "mp4")!
            let permissions = PHPhotoLibrary.authorizationStatus(for: .addOnly)
            model.importFile(source)
            try await wait { model.source != nil && !model.busy }
            try require(model.error == nil && model.frames.count == 8, "视频应成功导入且缩略图可用")
            try require(model.clip?.end == 3, "默认选三秒")
            model.changeEdge(.start, value: 0.8); model.changeEdge(.end, value: 2.4)
            model.seek(1.2); model.setCover()
            try require(abs(model.clip!.cover - 1.2) < 0.001, "手动封面时间")
            model.mute = true
            record("checkpoint", "editor")
            // Host can capture/inspect the native screen before continuing.
            while !FileManager.default.fileExists(atPath: documents.appendingPathComponent("continue").path) { try await Task.sleep(nanoseconds: 100_000_000) }
            model.prepare()
            try await wait { !model.busy }
            guard let first = model.prepared else { throw Failure(model.error ?? "预览未生成") }
            try require(PHPhotoLibrary.authorizationStatus(for: .addOnly) == permissions, "预览不应申请权限")
            try require(abs(first.duration - 1.6) < 0.08, "成片时长应跟随截取")
            let movie = AVURLAsset(url: first.movie)
            try require(try await movie.loadTracks(withMediaType: .audio).isEmpty, "静音输出不含声音轨")
            try require(!(try await movie.loadTracks(withMediaType: .metadata)).isEmpty, "必须有实况时间轨")
            let metadata = try await movie.load(.metadata)
            try require(metadata.contains { $0.identifier == .quickTimeMetadataContentIdentifier }, "必须有配对标识")
            let image = CGImageSourceCreateWithURL(first.still as CFURL, nil)!
            let properties = CGImageSourceCopyPropertiesAtIndex(image, 0, nil)! as NSDictionary
            let size = (properties[kCGImagePropertyPixelWidth] as! Int, properties[kCGImagePropertyPixelHeight] as! Int)
            try require(size.0 <= 240 && size.1 <= 320,"小素材不应放大")
            try require(size.1 > size.0 && abs(Double(size.0) / Double(size.1) - 0.75) < 0.02, "默认封面应保持旋转后的视频比例")
            record("checkpoint", "preview")
            while !FileManager.default.fileExists(atPath: documents.appendingPathComponent("continue-preview").path) { try await Task.sleep(nanoseconds: 100_000_000) }
            let oldDirectory = first.directory
            model.discardPreview()
            try require(model.prepared == nil, "返回不保存")
            // Keep first only for exact-byte comparison; production sheet releases it on dismiss.
            model.changeEdge(.end, value: 2.2); model.mute = false; model.aspectRatio = .square; model.prepare()
            try await wait { !model.busy }
            guard let second = model.prepared else { throw Failure(model.error ?? "修改后预览失败") }
            try require(second.directory != oldDirectory && abs(second.duration - 1.4) < 0.08, "修改后应生成新成片")
            try require(!(try await AVURLAsset(url: second.movie).loadTracks(withMediaType: .audio)).isEmpty, "保留声音输出应有音轨")
            let squareImage = CGImageSourceCreateWithURL(second.still as CFURL, nil)!
            let squareProps = CGImageSourceCopyPropertiesAtIndex(squareImage, 0, nil)! as NSDictionary
            let squareWidth = squareProps[kCGImagePropertyPixelWidth] as! Int
            let squareHeight = squareProps[kCGImagePropertyPixelHeight] as! Int
            try require(squareWidth == squareHeight, "封面应与选择的 1:1 比例一致")
            let squareTrack = try await AVURLAsset(url: second.movie).loadTracks(withMediaType: .video).first!
            let squareSize = try await squareTrack.load(.naturalSize).applying(squareTrack.load(.preferredTransform))
            try require(abs(abs(squareSize.width) - abs(squareSize.height)) < 2, "视频应与封面保持同一比例")
            for (format, expected) in [(OutputAspect.portrait, 9.0 / 16), (.landscape, 16.0 / 9), (.photo, 3.0 / 4)] {
                let output = try await VideoConversion.prepare(model.source!.url, clip: model.clip!, mute: true, aspect: format)
                let sourceImage = CGImageSourceCreateWithURL(output.still as CFURL, nil)!
                let props = CGImageSourceCopyPropertiesAtIndex(sourceImage, 0, nil)! as NSDictionary
                let w = props[kCGImagePropertyPixelWidth] as! Int, h = props[kCGImagePropertyPixelHeight] as! Int
                try require(abs(Double(w) / Double(h) - expected) < 0.03, "封面比例应匹配选择：\(format.title)")
                let track = try await AVURLAsset(url: output.movie).loadTracks(withMediaType: .video).first!
                let dimensions = try await track.load(.naturalSize).applying(track.load(.preferredTransform))
                try require(abs(abs(dimensions.width / dimensions.height) - expected) < 0.03, "动态画面比例应匹配选择：\(format.title)")
            }
            let before = try Data(contentsOf: second.movie)
            model.save(); model.save()
            try require(model.saving, "确认后应进入保存状态")
            try await wait { !model.saving }
            try require(model.error == nil && model.notice != nil && model.prepared == nil, "保存完成后应关闭预览并提示成功")
            try require(try Data(contentsOf: second.movie) == before, "保存必须使用原预览成片")
            record("result", "IPHONE_OK: 30-second output, pre-start/in-flight cancellation, oversized import rejection, video import, thumbnails, trim/cover, orientation, actual PHLivePhoto recognition, no preview permission, mute/audio, return/edit/regenerate and confirmed Photos write in isolated simulator")
        } catch { record("result", "FAILED: \(error.localizedDescription)") }
    }
}
