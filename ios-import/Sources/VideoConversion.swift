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
    static func copy(_ source: URL) async throws -> ImportedMovie {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("source-\(UUID())")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let url = directory.appendingPathComponent(source.lastPathComponent)
        do { try FileManager.default.copyItem(at: source, to: url); return ImportedMovie(url: url) }
        catch { try? FileManager.default.removeItem(at: directory); throw error }
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
    static func frames(_ url: URL, duration: Double) async throws -> [UIImage] {
        let generator = AVAssetImageGenerator(asset: AVURLAsset(url: url))
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = CGSize(width: 160, height: 160)
        var result: [UIImage] = []
        for index in 0..<8 {
            try Task.checkCancellation()
            let time = CMTime(seconds: duration * (Double(index) + 0.5) / 8, preferredTimescale: 600)
            let image = try await generator.image(at: time)
            result.append(UIImage(cgImage: image.image))
        }
        return result
    }

    static func prepare(_ source: URL, clip: ClipSelection, mute: Bool, aspect: OutputAspect) async throws -> PreparedPhoto {
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
            if aspect != .original {
                let size = try await original.load(.naturalSize)
                let transform = try await original.load(.preferredTransform)
                let bounds = CGRect(origin: .zero, size: size).applying(transform).standardized
                let crop = aspect.cropSize(bounds.size)
                let render = CGSize(width: floor(crop.width / 2) * 2, height: floor(crop.height / 2) * 2)
                guard render.width >= 2, render.height >= 2 else { throw Failure("视频尺寸太小，无法按所选比例裁切") }
                let x = -bounds.minX - (bounds.width - render.width) / 2
                let y = -bounds.minY - (bounds.height - render.height) / 2
                let instruction = AVMutableVideoCompositionInstruction()
                instruction.timeRange = CMTimeRange(start: .zero, duration: range.duration)
                let layer = AVMutableVideoCompositionLayerInstruction(assetTrack: video)
                layer.setTransform(transform.concatenating(CGAffineTransform(translationX: x, y: y)), at: .zero)
                instruction.layerInstructions = [layer]
                let visual = AVMutableVideoComposition()
                visual.instructions = [instruction]; visual.renderSize = render
                let fps = try await original.load(.nominalFrameRate)
                visual.frameDuration = CMTime(seconds: 1 / Double(fps > 0 ? fps : 30), preferredTimescale: 60000)
                exporter.videoComposition = visual
            }
            exporter.outputURL = clipURL
            exporter.outputFileType = .mov
            exporter.shouldOptimizeForNetworkUse = true
            await exporter.export()
            guard exporter.status == .completed else { throw exporter.error ?? Failure("视频截取未完成") }
            try Task.checkCancellation()
            let encoded = AVURLAsset(url: clipURL)
            let duration = try await encoded.load(.duration).seconds
            let track = try await encoded.loadTracks(withMediaType: .video).first
            let rate = try await track?.load(.nominalFrameRate) ?? 30
            let frameLength = 1 / max(1, Double(rate))
            let time = min(max(0, clip.cover - clip.start), max(0, duration - frameLength))
            let generator = AVAssetImageGenerator(asset: encoded)
            generator.appliesPreferredTrackTransform = true
            generator.requestedTimeToleranceBefore = .zero
            generator.requestedTimeToleranceAfter = .zero
            let frame = try await generator.image(at: CMTime(seconds: time, preferredTimescale: 600))
            let stillSource = directory.appendingPathComponent("cover.jpg")
            guard let jpeg = UIImage(cgImage: frame.image).jpegData(compressionQuality: 0.95) else { throw Failure("封面生成失败") }
            try jpeg.write(to: stillSource)
            let still = directory.appendingPathComponent("photo.JPG")
            let movie = directory.appendingPathComponent("photo.MOV")
            let identifier = UUID().uuidString
            try writeStill(stillSource, still, identifier: identifier)
            try await writeMovie(clipURL, movie, identifier: identifier, stillTime: max(0, frame.actualTime.seconds))
            try Task.checkCancellation()
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
