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
    @Published private(set) var phase = "正在获取视频"
    @Published private(set) var fraction: Double?
    private var framesTask: Task<Void,Never>?
    private var operation: Task<Void,Never>?
    private var requestID = UUID()
    func cancel() { operation?.cancel(); phase = "正在取消…" }
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
            let id = self.requestID
            return try await ImportedMovie.copy(url,progress:{ value in
                Task { @MainActor [weak self] in
                    guard let self, self.requestID == id, self.busy,
                          self.phase == "正在获取视频" || self.phase == "正在复制视频" else { return }
                    self.phase = "正在复制视频"; self.fraction = value
                }
            })
        }
    }
    private func load(_ get: @escaping () async throws -> ImportedMovie) {
        guard !busy, !saving else { return }
        framesTask?.cancel(); pause(); busy = true; error = nil; notice = nil; phase = "正在获取视频"; fraction = nil
        let id = UUID(); requestID = id
        operation = Task {
            do {
                let movie = try await get()
                try Task.checkCancellation()
                phase = "正在读取视频"
                let asset = AVURLAsset(url: movie.url)
                let metadata = try await mediaTimeout(30) {
                    try await withTaskCancellationHandler(operation: {
                        guard let track = try await asset.loadTracks(withMediaType:.video).first else { throw Failure("所选文件没有视频画面") }
                        let size = try await track.load(.naturalSize), transform = try await track.load(.preferredTransform)
                        let oriented = CGRect(origin:.zero,size:size).applying(transform).standardized.size
                        guard oriented.width > 0, oriented.height > 0 else { throw Failure("无法读取视频画面尺寸") }
                        return (oriented,try await asset.load(.duration).seconds)
                    }, onCancel:{ asset.cancelLoading() })
                }
                let oriented = metadata.0, selection = try ClipSelection(duration:metadata.1)
                try Task.checkCancellation()
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
                do { frames = try await VideoConversion.frames(movie.url, duration: min(40,selection.duration)) }
                catch is CancellationError { }
                catch { self.error = "时间线缩略图未能加载：\(error.localizedDescription)" }
            } catch is CancellationError { }
            catch { self.error = error.localizedDescription }
            if requestID == id { busy = false; operation = nil }
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
        case .selection: selection.move(to:value); seek(selection.start)
        }
        clip = selection
        if edge != .playhead { refreshFrames() }
    }
    private func refreshFrames() {
        guard let source, let clip else { return }
        let previous = framesTask; previous?.cancel()
        let span = min(40,clip.duration), start = min(max(0,clip.start-5),max(0,clip.duration-min(40,clip.duration)))
        framesTask = Task {
            await previous?.value
            do {
                try await Task.sleep(nanoseconds:300_000_000)
                let images = try await VideoConversion.frames(source.url,duration:span,start:start)
                try Task.checkCancellation(); frames = images
            } catch is CancellationError { }
            catch { if !Task.isCancelled { self.error = "时间线缩略图未能加载：\(error.localizedDescription)" } }
        }
    }
    func setCover() { clip?.setCover(position) }
    func prepare() {
        guard let source, let clip, !busy, !saving else { return }
        framesTask?.cancel(); pause(); error = nil; notice = nil; busy = true; phase = "正在生成成片"; fraction = nil
        let id = UUID(); requestID = id
        let mute = mute, aspectRatio = aspectRatio
        operation = Task {
            do {
                let photo = try await VideoConversion.prepare(source.url,clip:clip,mute:mute,aspect:aspectRatio,progress:{ [weak self] label,value in
                    Task { @MainActor in if self?.requestID == id { self?.phase = label; self?.fraction = value } }
                })
                try Task.checkCancellation(); prepared = photo
            }
            catch is CancellationError { }
            catch { if !Task.isCancelled { self.error = error.localizedDescription } }
            if requestID == id { busy = false; operation = nil }
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
