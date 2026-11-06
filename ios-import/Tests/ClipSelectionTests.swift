import XCTest
@testable import LivePhotoImporter

final class ClipSelectionTests: XCTestCase {
    func testTrimKeepsCoverInsideAndAllowsWholeVideo() throws {
        var clip = try ClipSelection(duration: 12)
        XCTAssertEqual(clip.end, 3)
        clip.setStart(2)
        XCTAssertEqual(clip.cover, 2)
        clip.setEnd(12)
        clip.setCover(8)
        clip.setEnd(4)
        XCTAssertEqual(clip.cover, 4)
        clip.setStart(0)
        XCTAssertEqual(clip.length, 4)
        clip.setEnd(12)
        XCTAssertEqual(clip.length, 12)
    }
    func testShortVideoAndCrossedHandlesRemainValid() throws {
        var clip = try ClipSelection(duration: 0.06)
        clip.setStart(1)
        clip.setEnd(-2)
        XCTAssertEqual(clip.start, 0)
        XCTAssertEqual(clip.end, 0.06)
        XCTAssertTrue((clip.start...clip.end).contains(clip.cover))
        for duration in [0, -1, Double.infinity, Double.nan] {
            XCTAssertThrowsError(try ClipSelection(duration: duration))
        }
    }
}
