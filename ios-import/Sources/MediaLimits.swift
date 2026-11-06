import Foundation
import CoreGraphics

enum MediaLimits {
    private static let cleaned: Void = {
        let directory = FileManager.default.temporaryDirectory
        if let files = try? FileManager.default.contentsOfDirectory(at:directory,includingPropertiesForKeys:nil) {
            for file in files where file.lastPathComponent.hasPrefix("source-") || file.lastPathComponent.hasPrefix("prepared-") {
                // These prefixes are app-owned. Failed cleanup leaves disk use visible to the space checks.
                try? FileManager.default.removeItem(at:file)
            }
        }
    }()
    static func prepareStorage() { _ = cleaned }
    static let defaultLength = 3.0, maximumLength = 30.0, minimumLength = 0.1
    static let inputBytes: Int64 = 1_073_741_824
    static let outputBytes: Int64 = 50 * 1_048_576
    static let workBytes: Int64 = 256 * 1_048_576
    static let reserveBytes: Int64 = 512 * 1_048_576
    static func outputSize(_ size: CGSize) -> CGSize {
        let scale = min(1, 1920 / max(size.width,size.height), 1080 / min(size.width,size.height))
        return CGSize(width: floor(size.width*scale/2)*2, height: floor(size.height*scale/2)*2)
    }
    static func size(_ url: URL) throws -> Int64 {
        let values = try url.resourceValues(forKeys: [.fileSizeKey])
        guard let size = values.fileSize else { throw Failure("无法确定文件大小") }
        return Int64(size)
    }
    static func checkSpace(_ directory: URL, additional: Int64 = workBytes) throws {
        let attributes = try FileManager.default.attributesOfFileSystem(forPath: directory.path)
        guard let free = attributes[.systemFreeSize] as? NSNumber else { throw Failure("无法检查剩余空间") }
        guard free.int64Value >= reserveBytes + additional else { throw Failure("手机空间不足，请释放空间后重试") }
    }
    static func checkOutput(_ urls: [URL]) throws {
        if try urls.reduce(Int64(0), { try $0 + size($1) }) > outputBytes { throw Failure("成片超过 50 MiB，请缩短片段") }
    }
}

final class MediaCancellation: @unchecked Sendable {
    private let lock = NSLock()
    private var cancelled = false
    func cancel() { lock.lock(); cancelled = true; lock.unlock() }
    func check() throws { lock.lock(); let value = cancelled; lock.unlock(); if value { throw CancellationError() } }
}

func mediaTimeout<T>(_ seconds: Double, operation: @escaping @Sendable () async throws -> T) async throws -> T {
    try Task.checkCancellation()
    return try await withThrowingTaskGroup(of: T.self) { group in
        group.addTask { try await operation() }
        group.addTask { try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000)); throw Failure("媒体处理超时，请缩短片段或更换素材") }
        defer { group.cancelAll() }
        return try await group.next()!
    }
}

