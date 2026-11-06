import Foundation

struct ClipSelection: Equatable {
    let duration: Double
    private(set) var start: Double = 0
    private(set) var end: Double
    private(set) var cover: Double
    var length: Double { end - start }
    private var minimum: Double { min(MediaLimits.minimumLength, duration) }

    init(duration: Double) throws {
        guard duration.isFinite, duration > 0 else { throw Failure("视频没有可用的时长") }
        self.duration = duration
        end = min(MediaLimits.defaultLength, duration)
        cover = end / 2
    }
    mutating func setStart(_ value: Double) {
        start = min(max(max(0,end-MediaLimits.maximumLength), value), end - minimum)
        setCover(cover)
    }
    mutating func setEnd(_ value: Double) {
        end = max(min(min(duration,start+MediaLimits.maximumLength), value), start + minimum)
        setCover(cover)
    }
    mutating func move(to value: Double) {
        let next = min(max(0,value),duration-length), delta = next-start
        start = next; end += delta; cover += delta
    }
    func validate() throws {
        guard start.isFinite, end.isFinite, cover.isFinite, start >= 0, end <= duration,
              length + 1e-9 >= minimum, length <= MediaLimits.maximumLength,
              cover >= start, cover <= end else { throw Failure("选段必须在视频内，最长 30 秒") }
    }
    mutating func setCover(_ value: Double) { cover = min(max(start, value), end) }
}
