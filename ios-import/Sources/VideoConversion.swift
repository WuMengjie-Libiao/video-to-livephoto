import Foundation
@preconcurrency import AVFoundation
import Photos
import UIKit
import CoreTransferable
import UniformTypeIdentifiers

// Picker URLs are temporary and may point outside our container. Own a local copy
// before the provider callback/security scope ends; no persistent library access.
final class ImportedMovie: Transferable, Sendable {
    let url: URL
    init(url: URL) { self.url = url }
    deinit { remove() }
    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(importedContentType: .movie) { received in
            try await copy(received.file)
        }
    }
    static func copy(_ source: URL, progress: @escaping @Sendable (Double?) -> Void = { _ in }) async throws -> ImportedMovie {
        MediaLimits.prepareStorage()
        let cancellation = MediaCancellation()
        return try await withTaskCancellationHandler(operation: {
            try await withCheckedThrowingContinuation { continuation in
                DispatchQueue.global(qos: .userInitiated).async {
                    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("source-\(UUID())")
                    do {
                        try cancellation.check()
                        let known = try source.resourceValues(forKeys: [.fileSizeKey]).fileSize
                        if let known, known > MediaLimits.inputBytes { throw Failure("原视频超过 1 GiB，请先裁剪素材") }
                        try MediaLimits.checkSpace(FileManager.default.temporaryDirectory, additional: Int64(known ?? 0)+MediaLimits.workBytes)
                        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                        let url = directory.appendingPathComponent(source.lastPathComponent)
                        FileManager.default.createFile(atPath: url.path, contents: nil)
                        let input = try FileHandle(forReadingFrom: source), output = try FileHandle(forWritingTo: url)
                        defer { try? input.close(); try? output.close() }
                        var total: Int64 = 0
                        while let data = try input.read(upToCount: 1_048_576), !data.isEmpty {
                            try cancellation.check(); total += Int64(data.count)
                            if total > MediaLimits.inputBytes { throw Failure("原视频超过 1 GiB，请先裁剪素材") }
                            try MediaLimits.checkSpace(directory)
                            try output.write(contentsOf: data)
                            progress(known.flatMap { $0 > 0 ? Double(total)/Double($0) : nil })
                        }
                        try cancellation.check()
                        try output.close()
                        continuation.resume(returning: ImportedMovie(url: url))
                    } catch {
                        try? FileManager.default.removeItem(at: directory)
                        continuation.resume(throwing: error)
                    }
                }
            }
        }, onCancel: { cancellation.cancel() })
    }
    private func remove() { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
}

final class PreparedPhoto: Identifiable {
    let id = UUID()
    let directory: URL
    let still: URL
    let movie: URL
    let livePhoto: PHLivePhoto
    let duration: Double
    let mute: Bool
    init(directory: URL, still: URL, movie: URL, livePhoto: PHLivePhoto, duration: Double, mute: Bool) {
        self.directory = directory; self.still = still; self.movie = movie
        self.livePhoto = livePhoto; self.duration = duration; self.mute = mute
    }
    deinit { try? FileManager.default.removeItem(at: directory) }
}

// Runs away from the view's MainActor. All rendering owns temporary files and
// cleans up failures; only save() crosses the Photos write boundary.
enum VideoConversion {
    static func frames(_ url: URL, duration: Double, start: Double = 0) async throws -> [UIImage] {
        let generator = AVAssetImageGenerator(asset: AVURLAsset(url: url))
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = CGSize(width: 160, height: 160)
        var result: [UIImage] = []
        for index in 0..<8 {
            try Task.checkCancellation()
            let time = CMTime(seconds: start + duration * (Double(index) + 0.5) / 8, preferredTimescale: 600)
            let image = try await mediaTimeout(15) { try await withTaskCancellationHandler(operation: { try await generator.image(at: time) }, onCancel: { generator.cancelAllCGImageGeneration() }) }
            result.append(UIImage(cgImage: image.image))
        }
        return result
    }

    static func prepare(_ source: URL, clip: ClipSelection, mute: Bool, aspect: OutputAspect,
                        progress: @escaping @Sendable (String, Double?) -> Void = { _,_ in }) async throws -> PreparedPhoto {
        try await mediaTimeout(300) { try await render(source,clip:clip,mute:mute,aspect:aspect,progress:progress) }
    }
    private static func render(_ source: URL, clip: ClipSelection, mute: Bool, aspect: OutputAspect,
                               progress: @escaping @Sendable (String, Double?) -> Void) async throws -> PreparedPhoto {
        try Task.checkCancellation()
        MediaLimits.prepareStorage()
        try clip.validate()
        guard try MediaLimits.size(source) <= MediaLimits.inputBytes else { throw Failure("原视频超过 1 GiB，请先裁剪素材") }
        try MediaLimits.checkSpace(FileManager.default.temporaryDirectory)
        progress("正在生成成片",nil)
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("prepared-\(UUID())")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        do {
            let asset = AVURLAsset(url: source)
            let composition = AVMutableComposition()
            guard let original = try await asset.loadTracks(withMediaType: .video).first,
                  let video = composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid) else {
                throw Failure("没有可用的视频画面")
            }
            let range = CMTimeRange(start: CMTime(seconds: clip.start, preferredTimescale: 600),
                                    duration: CMTime(seconds: clip.length, preferredTimescale: 600))
            try video.insertTimeRange(range, of: original, at: .zero)
            video.preferredTransform = try await original.load(.preferredTransform)
            if !mute, let originalAudio = try await asset.loadTracks(withMediaType: .audio).first {
                guard let audio = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) else {
                    throw Failure("无法添加声音轨道")
                }
                let available = CMTimeRangeGetIntersection(range, otherRange: try await originalAudio.load(.timeRange))
                if available.duration.seconds > 0 {
                    try audio.insertTimeRange(available, of: originalAudio, at: available.start - range.start)
                }
            }
            let clipURL = directory.appendingPathComponent("clip.mov")
            guard let exporter = AVAssetExportSession(asset: composition, presetName: AVAssetExportPreset1920x1080) else {
                throw Failure("这个视频无法转换，请换一个视频试试")
            }
            let natural = try await original.load(.naturalSize)
            let transform = try await original.load(.preferredTransform)
            let bounds = CGRect(origin: .zero, size: natural).applying(transform).standardized
            let crop = aspect.cropSize(bounds.size)
            let render = MediaLimits.outputSize(crop)
            guard render.width >= 2, render.height >= 2 else { throw Failure("视频尺寸太小") }
            let translation = CGAffineTransform(translationX: -bounds.minX-(bounds.width-crop.width)/2,
                                                y: -bounds.minY-(bounds.height-crop.height)/2)
            let scale = CGAffineTransform(scaleX: render.width/crop.width, y: render.height/crop.height)
            let instruction = AVMutableVideoCompositionInstruction()
            instruction.timeRange = CMTimeRange(start:.zero,duration:range.duration)
            let layer = AVMutableVideoCompositionLayerInstruction(assetTrack:video)
            layer.setTransform(transform.concatenating(translation).concatenating(scale),at:.zero)
            instruction.layerInstructions = [layer]
            let visual = AVMutableVideoComposition()
            visual.instructions = [instruction]; visual.renderSize = render
            let sourceRate = try await original.load(.nominalFrameRate)
            visual.frameDuration = CMTime(seconds:1/Double(min(30,sourceRate > 0 ? sourceRate : 30)),preferredTimescale:60000)
            exporter.videoComposition = visual
            exporter.outputURL = clipURL
            exporter.outputFileType = .mov
            exporter.shouldOptimizeForNetworkUse = true
            let session = ExportOperation(exporter)
            let monitoring = Task {
                var previous: Float = -1
                var lastAdvance = Date()
                do {
                    while !Task.isCancelled {
                        try await Task.sleep(nanoseconds: 500_000_000)
                        let fraction = await session.progress()
                        if fraction > previous { previous = fraction; lastAdvance = Date() }
                        if Date().timeIntervalSince(lastAdvance) > 60 { throw Failure("编码持续 60 秒无进展，已停止") }
                        if FileManager.default.fileExists(atPath: clipURL.path) { try MediaLimits.checkOutput([clipURL]) }
                        try MediaLimits.checkSpace(directory,additional:0)
                        progress("正在生成成片",Double(fraction))
                    }
                } catch is CancellationError { }
                catch { session.cancel(); throw error }
            }
            var exportError: Error?
            do { try await session.run() } catch { exportError = error }
            monitoring.cancel(); try await monitoring.value
            if let exportError { throw exportError }
            try Task.checkCancellation()
            progress("正在验证成片",nil)
            try Task.checkCancellation()
            let encoded = AVURLAsset(url: clipURL)
            let duration = try await encoded.load(.duration).seconds
            let track = try await encoded.loadTracks(withMediaType: .video).first
            guard let track else { throw Failure("成片缺少视频画面") }
            let encodedSize = try await track.load(.naturalSize)
            let encodedTransform = try await track.load(.preferredTransform)
            let actualSize = CGRect(origin:.zero,size:encodedSize).applying(encodedTransform).standardized.size
            guard actualSize.width <= render.width+1, actualSize.height <= render.height+1 else { throw Failure("成片画面尺寸验证失败") }
            let rate = try await track.load(.nominalFrameRate)
            let frameLength = 1 / max(1, Double(rate))
            guard abs(duration-clip.length) <= frameLength + 0.002, rate <= 30.01 else { throw Failure("成片时长或帧率验证失败") }
            let time = min(max(0, clip.cover - clip.start), max(0, duration - frameLength))
            let generator = AVAssetImageGenerator(asset: encoded)
            generator.appliesPreferredTrackTransform = true
            generator.requestedTimeToleranceBefore = .zero
            generator.requestedTimeToleranceAfter = .zero
            let frame = try await withTaskCancellationHandler(operation: { try await generator.image(at: CMTime(seconds: time, preferredTimescale: 600)) }, onCancel: { generator.cancelAllCGImageGeneration() })
            let stillSource = directory.appendingPathComponent("cover.jpg")
            guard let jpeg = UIImage(cgImage: frame.image).jpegData(compressionQuality: 0.95) else { throw Failure("封面生成失败") }
            try jpeg.write(to: stillSource)
            let still = directory.appendingPathComponent("photo.JPG")
            let movie = directory.appendingPathComponent("photo.MOV")
            let identifier = UUID().uuidString
            try writeStill(stillSource, still, identifier: identifier)
            try await writeMovie(clipURL, movie, identifier: identifier, stillTime: max(0, frame.actualTime.seconds))
            try Task.checkCancellation()
            try MediaLimits.checkOutput([still,movie])
            let livePhoto = try await loadLivePhoto(still, movie, targetSize: CGSize(width: 1200, height: 1200))
            try Task.checkCancellation()
            return PreparedPhoto(directory: directory, still: still, movie: movie, livePhoto: livePhoto, duration: duration, mute: mute)
        } catch {
            try? FileManager.default.removeItem(at: directory)
            throw error
        }
    }

    static func save(_ photo: PreparedPhoto) async throws {
        try await savePair(photo.still, photo.movie)
    }
}

// All export-session start/cancel/progress access is serialized. A cancelled
// session must never be started: AVFoundation raises an Objective-C exception.
final class ExportOperation: @unchecked Sendable {
    private let queue = DispatchQueue(label:"livephoto.export")
    private let exporter: AVAssetExportSession
    private var cancelled = false, started = false, finished = false
    init(_ exporter: AVAssetExportSession) { self.exporter = exporter }
    func cancel() { queue.async { self.cancelled = true; if self.started && !self.finished { self.exporter.cancelExport() } } }
    func progress() async -> Float { await withCheckedContinuation { callback in queue.async { callback.resume(returning:self.exporter.progress) } } }
    func run() async throws {
        try await withTaskCancellationHandler(operation: {
            try await withCheckedThrowingContinuation { (callback: CheckedContinuation<Void,Error>) in
                queue.async {
                    if self.cancelled { callback.resume(throwing:CancellationError()); return }
                    self.started = true
                    self.exporter.exportAsynchronously {
                        self.queue.async {
                            self.finished = true
                            if self.cancelled { callback.resume(throwing:CancellationError()) }
                            else if self.exporter.status == .completed { callback.resume() }
                            else { callback.resume(throwing:self.exporter.error ?? Failure("视频截取未完成")) }
                        }
                    }
                }
            }
        }, onCancel:{ self.cancel() })
    }
}
