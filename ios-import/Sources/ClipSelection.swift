import Foundation

struct ClipSelection: Equatable {
    let duration: Double
    private(set) var start: Double = 0
    private(set) var end: Double
    private(set) var cover: Double
    var length: Double { end - start }
    private var minimum: Double { min(0.1, duration) }

    init(duration: Double) throws {
        guard duration.isFinite, duration > 0 else { throw Failure("视频没有可用的时长") }
        self.duration = duration
        end = min(3, duration)
        cover = end / 2
    }
    mutating func setStart(_ value: Double) {
        start = min(max(0, value), end - minimum)
        setCover(cover)
    }
    mutating func setEnd(_ value: Double) {
        end = max(min(duration, value), start + minimum)
        setCover(cover)
    }
    mutating func setCover(_ value: Double) { cover = min(max(start, value), end) }
}
