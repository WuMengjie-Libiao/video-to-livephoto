import CoreGraphics

enum OutputAspect: String, CaseIterable, Identifiable {
    case original, square, portrait, landscape, photo
    var id: String { rawValue }
    var title: String {
        switch self { case .original: return "原比例"; case .square: return "1:1"; case .portrait: return "9:16"; case .landscape: return "16:9"; case .photo: return "3:4" }
    }
    var value: CGFloat? {
        switch self { case .original: return nil; case .square: return 1; case .portrait: return 9 / 16; case .landscape: return 16 / 9; case .photo: return 3 / 4 }
    }
    func cropSize(_ source: CGSize) -> CGSize {
        guard let value else { return source }
        if source.width / source.height > value { return CGSize(width: source.height * value, height: source.height) }
        return CGSize(width: source.width, height: source.width / value)
    }
}
