// Standalone domain regression: swiftc Sources/ClipSelection.swift SelectionCheck.swift
import Foundation
struct Failure: Error { let message: String; init(_ message: String) { self.message = message } }
@main struct SelectionCheck {
    static func main() throws {
        var clip = try ClipSelection(duration: 12)
        precondition(clip.end == 3)
        clip.setStart(2); precondition(clip.cover == 2)
        clip.setEnd(12); clip.setCover(8); clip.setEnd(4)
        precondition(clip.cover == 4)
        clip.setStart(0); clip.setEnd(12); precondition(clip.length == 12)
        var short = try ClipSelection(duration: 0.06)
        short.setStart(1); short.setEnd(-2)
        precondition(short.start == 0 && short.end == 0.06)
        for invalid in [0, -1, Double.infinity, Double.nan] {
            var rejected = false
            do { _ = try ClipSelection(duration: invalid) } catch { rejected = true }
            precondition(rejected)
        }
        print("SELECTION_OK: trim/cover invariants, full duration, sub-frame video and invalid inputs")
    }
}
