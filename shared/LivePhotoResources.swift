import Foundation
@preconcurrency import AVFoundation
import ImageIO
import UniformTypeIdentifiers
import Photos
#if os(macOS)
import AppKit
#else
import UIKit
#endif

struct Failure: LocalizedError {
    let message: String
    var errorDescription: String? { message }
    init(_ message: String) { self.message = message }
}

func writeStill(_ source: URL, _ destination: URL, identifier: String) throws {
    guard let input = CGImageSourceCreateWithURL(source as CFURL, nil),
          let output = CGImageDestinationCreateWithURL(destination as CFURL, UTType.jpeg.identifier as CFString, 1, nil) else {
        throw Failure("无法创建实况照片封面")
    }
    var props = CGImageSourceCopyPropertiesAtIndex(input, 0, nil) as? [String: Any] ?? [:]
    props[kCGImagePropertyMakerAppleDictionary as String] = ["17": identifier]
    CGImageDestinationAddImageFromSource(output, input, 0, props as CFDictionary)
    guard CGImageDestinationFinalize(output) else { throw Failure("封面写入失败") }
}

// Each pump owns its input/output and completion flag on one serial queue.
// AVFoundation explicitly supports separate queues for independent tracks.
final class TrackPump: @unchecked Sendable {
    let output: AVAssetReaderTrackOutput
    let input: AVAssetWriterInput
    let group: DispatchGroup
    var finished = false
    init(_ output: AVAssetReaderTrackOutput, _ input: AVAssetWriterInput, _ group: DispatchGroup) {
        self.output = output; self.input = input; self.group = group
    }
    func start(index: Int) {
        group.enter()
        input.requestMediaDataWhenReady(on: DispatchQueue(label: "livephoto.track.\(index)")) { [self] in
            guard !finished else { return }
            while input.isReadyForMoreMediaData {
                guard let sample = output.copyNextSampleBuffer() else { finish(); return }
                if !input.append(sample) { finish(); return }
            }
        }
    }
    private func finish() { finished = true; input.markAsFinished(); group.leave() }
}

func writeMovie(_ source: URL, _ destination: URL, identifier: String, stillTime: Double) async throws {
    let asset = AVURLAsset(url: source)
    let tracks = try await asset.loadTracks(withMediaType: .video) + asset.loadTracks(withMediaType: .audio)
    let reader = try AVAssetReader(asset: asset)
    let writer = try AVAssetWriter(outputURL: destination, fileType: .mov)
    let id = AVMutableMetadataItem()
    id.keySpace = .quickTimeMetadata
    id.key = "com.apple.quicktime.content.identifier" as NSString
    id.value = identifier as NSString
    id.dataType = kCMMetadataBaseDataType_UTF8 as String
    writer.metadata = [id]

    var streams: [(AVAssetReaderTrackOutput, AVAssetWriterInput)] = []
    for track in tracks {
        guard let format = try await track.load(.formatDescriptions).first else { throw Failure("视频轨缺少格式信息") }
        let output = AVAssetReaderTrackOutput(track: track, outputSettings: nil)
        let input = AVAssetWriterInput(mediaType: track.mediaType, outputSettings: nil, sourceFormatHint: format)
        input.transform = try await track.load(.preferredTransform)
        guard reader.canAdd(output), writer.canAdd(input) else { throw Failure("视频轨无法封装") }
        reader.add(output)
        writer.add(input)
        streams.append((output, input))
    }
    var desc: CMMetadataFormatDescription?
    let spec: [String: Any] = [
        kCMMetadataFormatDescriptionMetadataSpecificationKey_Identifier as String: "mdta/com.apple.quicktime.still-image-time",
        kCMMetadataFormatDescriptionMetadataSpecificationKey_DataType as String: kCMMetadataBaseDataType_SInt8 as String,
    ]
    let status = CMMetadataFormatDescriptionCreateWithMetadataSpecifications(allocator: kCFAllocatorDefault,
        metadataType: kCMMetadataFormatType_Boxed, metadataSpecifications: [spec] as CFArray, formatDescriptionOut: &desc)
    guard status == noErr, let desc else { throw Failure("无法建立关键帧时间轨") }
    let metadataInput = AVAssetWriterInput(mediaType: .metadata, outputSettings: nil, sourceFormatHint: desc)
    let adaptor = AVAssetWriterInputMetadataAdaptor(assetWriterInput: metadataInput)
    guard writer.canAdd(metadataInput) else { throw Failure("无法写入关键帧时间轨") }
    writer.add(metadataInput)
    guard writer.startWriting(), reader.startReading() else { throw writer.error ?? reader.error ?? Failure("无法开始封装") }
    writer.startSession(atSourceTime: .zero)
    let time = AVMutableMetadataItem()
    time.keySpace = .quickTimeMetadata
    time.key = "com.apple.quicktime.still-image-time" as NSString
    time.value = NSNumber(value: Int8(0))
    time.dataType = kCMMetadataBaseDataType_SInt8 as String
    let range = CMTimeRange(start: CMTime(seconds: stillTime, preferredTimescale: 600), duration: CMTime(value: 1, timescale: 600))
    guard adaptor.append(AVTimedMetadataGroup(items: [time], timeRange: range)) else {
        throw writer.error ?? Failure("关键帧时间写入失败")
    }
    metadataInput.markAsFinished()
    await withTaskCancellationHandler(operation: { await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
        let group = DispatchGroup()
        for (index, stream) in streams.enumerated() {
            TrackPump(stream.0, stream.1, group).start(index: index)
        }
        group.notify(queue: .global()) { continuation.resume() }
    }
    }, onCancel: { reader.cancelReading() })
    if Task.isCancelled { writer.cancelWriting(); throw CancellationError() }
    guard reader.status == .completed else { throw reader.error ?? writer.error ?? Failure("读取视频失败") }
    await writer.finishWriting()
    guard writer.status == .completed else { throw writer.error ?? Failure("视频封装失败") }
}

private final class LivePhotoRequest: @unchecked Sendable {
    private let lock = NSLock()
    private var id: PHLivePhotoRequestID?
    private var continuation: CheckedContinuation<PHLivePhoto, Error>?
    private var cancelled = false
    func start(_ still: URL, _ movie: URL, _ target: CGSize, _ continuation: CheckedContinuation<PHLivePhoto, Error>) {
        lock.lock()
        if cancelled { lock.unlock(); continuation.resume(throwing: CancellationError()); return }
        self.continuation = continuation; lock.unlock()
        let request = PHLivePhoto.request(withResourceFileURLs:[still,movie],placeholderImage:nil,targetSize:target,contentMode:.aspectFit) { photo, info in
            if (info[PHLivePhotoInfoIsDegradedKey] as? Bool) == true { return }
            if let photo { self.finish(.success(photo)) }
            else { self.finish(.failure((info[PHLivePhotoInfoErrorKey] as? Error) ?? Failure("系统未识别出实况照片"))) }
        }
        lock.lock(); id = request; let shouldCancel = cancelled; lock.unlock()
        if shouldCancel { PHLivePhoto.cancelRequest(withRequestID:request) }
    }
    func finish(_ result: Result<PHLivePhoto,Error>) {
        lock.lock(); let callback = continuation; continuation = nil; lock.unlock()
        callback?.resume(with:result)
    }
    func cancel() {
        lock.lock(); cancelled = true; let request = id; lock.unlock()
        if let request { PHLivePhoto.cancelRequest(withRequestID:request) }
        finish(.failure(CancellationError()))
    }
}
func loadLivePhoto(_ still: URL, _ movie: URL, targetSize: CGSize = CGSize(width:200,height:200)) async throws -> PHLivePhoto {
    let request = LivePhotoRequest()
    return try await withTaskCancellationHandler(operation: {
        try await withCheckedThrowingContinuation { request.start(still,movie,targetSize,$0) }
    }, onCancel: { request.cancel() })
}

func validate(_ still: URL, _ movie: URL) async throws {
    _ = try await loadLivePhoto(still, movie)
}

func importPair(_ still: URL, _ movie: URL) async throws {
    try await validate(still, movie)
    try await savePair(still, movie)
}

// Callers must supply already validated resources, held alive until completion.
func savePair(_ still: URL, _ movie: URL) async throws {
    let auth = await PHPhotoLibrary.requestAuthorization(for: .addOnly)
    guard auth == .authorized else { throw Failure("没有照片写入权限。请在设置中允许添加照片，再返回保存。") }
    try await PHPhotoLibrary.shared().performChanges {
        let request = PHAssetCreationRequest.forAsset()
        request.addResource(with: .photo, fileURL: still, options: nil)
        request.addResource(with: .pairedVideo, fileURL: movie, options: nil)
    }
}
