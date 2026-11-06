import SwiftUI
import PhotosUI
import AVFoundation

@MainActor
final class EditorModel: ObservableObject {
    @Published private(set) var source: ImportedMovie?
    @Published var clip: ClipSelection?
    @Published private(set) var frames: [UIImage] = []
    @Published private(set) var player: AVPlayer?
    @Published private(set) var position: Double = 0
    @Published private(set) var playing = false
    @Published var aspectRatio: OutputAspect = .original
    @Published private(set) var sourceAspect: CGFloat = 1
    @Published var mute = false { didSet { player?.isMuted = mute } }
    @Published private(set) var busy = false
    @Published private(set) var saving = false
    @Published var prepared: PreparedPhoto?
    @Published var error: String?
    @Published var notice: String?
    private var observation: PlayerObservation?

    func importItem(_ item: PhotosPickerItem) {
        load {
            guard let movie = try await item.loadTransferable(type: ImportedMovie.self) else { throw Failure("未能读取所选视频") }
            return movie
        }
    }
    func importFile(_ url: URL) {
        load {
            let access = url.startAccessingSecurityScopedResource()
            defer { if access { url.stopAccessingSecurityScopedResource() } }
            return try await ImportedMovie.copy(url)
        }
    }
    private func load(_ get: @escaping () async throws -> ImportedMovie) {
        guard !busy, !saving else { return }
        pause(); busy = true; error = nil; notice = nil
        Task {
            do {
                let movie = try await get()
                let asset = AVURLAsset(url: movie.url)
                guard let track = try await asset.loadTracks(withMediaType: .video).first else { throw Failure("所选文件没有视频画面") }
                let size = try await track.load(.naturalSize)
                let transform = try await track.load(.preferredTransform)
                let oriented = CGRect(origin: .zero, size: size).applying(transform).standardized.size
                guard oriented.width > 0, oriented.height > 0 else { throw Failure("无法读取视频画面尺寸") }
                let selection = try ClipSelection(duration: try await asset.load(.duration).seconds)
                detachPlayer(); source = movie
                clip = selection; position = 0; frames = []; sourceAspect = oriented.width / oriented.height; aspectRatio = .original
                let player = AVPlayer(url: movie.url); player.isMuted = mute; self.player = player
                let token = player.addPeriodicTimeObserver(forInterval: CMTime(seconds: 1 / 30, preferredTimescale: 600), queue: .main) { [weak self] time in
                    Task { @MainActor [weak self] in
                        guard let self, let clip = self.clip else { return }
                        self.position = time.seconds
                        if self.playing, time.seconds >= clip.end { self.pause(); self.seek(clip.end) }
                    }
                }
                observation = PlayerObservation(player, token)
                do { frames = try await VideoConversion.frames(movie.url, duration: selection.duration) }
                catch { self.error = "时间线缩略图未能加载：\(error.localizedDescription)" }
            } catch { self.error = error.localizedDescription }
            busy = false
        }
    }
    func seek(_ time: Double) {
        guard let clip else { return }
        position = min(max(0, time), clip.duration)
        player?.seek(to: CMTime(seconds: position, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero)
    }
    func pause() { player?.pause(); playing = false }
    func togglePlayback() {
        guard let clip else { return }
        if playing { pause() }
        else {
            if position < clip.start || position >= clip.end - 0.02 { seek(clip.start) }
            player?.play(); playing = true
        }
    }
    func changeEdge(_ edge: TimelineEdge, value: Double) {
        guard var selection = clip else { return }
        pause()
        switch edge {
        case .start: selection.setStart(value); seek(selection.start)
        case .end: selection.setEnd(value); seek(selection.end)
        case .playhead: seek(value)
        }
        clip = selection
    }
    func setCover() { clip?.setCover(position) }
    func prepare() {
        guard let source, let clip, !busy, !saving else { return }
        pause(); error = nil; notice = nil; busy = true
        let mute = mute, aspectRatio = aspectRatio
        Task {
            do { prepared = try await VideoConversion.prepare(source.url, clip: clip, mute: mute, aspect: aspectRatio) }
            catch { self.error = error.localizedDescription }
            busy = false
        }
    }
    func discardPreview() { prepared = nil }
    func save() {
        guard let photo = prepared, !saving else { return }
        saving = true; error = nil
        Task {
            do {
                try await VideoConversion.save(photo)
                saving = false; discardPreview(); notice = "已保存到照片，长按就能播放"
            } catch { saving = false; self.error = error.localizedDescription }
        }
    }
    private func detachPlayer() {
        pause(); observation = nil; player = nil
    }
}

private final class PlayerObservation {
    let player: AVPlayer
    let token: Any
    init(_ player: AVPlayer, _ token: Any) { self.player = player; self.token = token }
    deinit { player.removeTimeObserver(token) }
}
