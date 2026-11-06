import SwiftUI
import PhotosUI
import AVKit

#if !SIMULATOR_CHECKS
@main
struct LivePhotoImporterApp: App {
    @StateObject private var model = EditorModel()
    var body: some Scene { WindowGroup { ContentView(model: model) } }
}

#endif

private let livePhotoTint = Color(red: 0.65, green: 0.85, blue: 0.87)
private let editorBackground = Color(red: 0.17, green: 0.18, blue: 0.19)
private let editorSurface = Color(red: 0.21, green: 0.22, blue: 0.23)

struct ContentView: View {
    @ObservedObject var model: EditorModel
    @State private var selection: PhotosPickerItem?
    @State private var showFiles = false
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        NavigationStack {
            GeometryReader { geometry in
                ScrollView {
                    if let clip = model.clip, let player = model.player {
                        VStack(alignment: .leading, spacing: 0) {
                            GeometryReader { canvas in
                                PlayerSurface(player: player)
                                    .aspectRatio(model.aspectRatio.value ?? model.sourceAspect, contentMode: .fit)
                                    .clipped()
                                    .frame(width: canvas.size.width, height: canvas.size.height)
                            }
                                .frame(height: max(170, min(geometry.size.height * 0.49, 480)))
                                .background(.black).clipShape(RoundedRectangle(cornerRadius: 8))
                                .accessibilityLabel("视频预览")
                            HStack {
                                playerTime(clip).frame(maxWidth: .infinity, alignment: .leading)
                                playButton
                                Color.clear.frame(maxWidth: .infinity).frame(height: 1)
                            }.padding(.vertical, 6)
                            Rectangle().fill(.white.opacity(0.12)).frame(height: 1)
                            VStack(alignment: .leading, spacing: 4) {
                                HStack {
                                    Text("剪辑").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                                    Spacer()
                                    Text("\(clip.length, specifier: "%.1f") 秒")
                                        .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                                }.padding(.top, 12)
                                TimelineView(clip: clip, position: model.position, frames: model.frames, onChange: model.changeEdge)
                                    .frame(height: 86)
                                HStack {
                                    Text(time(clip.start)); Spacer(); Text(time(clip.end))
                                }.font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                            }
                            if let notice = model.notice {
                                Label(notice, systemImage: "checkmark.circle.fill")
                                    .foregroundStyle(.tint).font(.callout).accessibilityIdentifier("savedNotice")
                            }
                        }.padding(.horizontal, 16).padding(.top, 8).padding(.bottom, 18).frame(maxWidth: 700).frame(maxWidth: .infinity)
                    } else {
                        VStack(spacing: 18) {
                            Image(systemName: "livephoto").font(.system(size: 48, weight: .light)).foregroundStyle(livePhotoTint)
                                .padding(.bottom, 8)
                            Text("留住喜欢的那一刻").font(.title2.weight(.semibold))
                            Text("选一段喜欢的画面，让回忆动起来。").font(.callout).foregroundStyle(.secondary)
                            PhotosPicker(selection: $selection, matching: .videos, preferredItemEncoding: .current) {
                                Label("选择视频", systemImage: "plus").foregroundStyle(.black).frame(minHeight: 32).padding(.horizontal, 12)
                            }.buttonStyle(.borderedProminent)
                            Button("从文件中选择") { showFiles = true }.frame(minHeight: 44)
                            Text("只在手机上处理").font(.caption).foregroundStyle(.secondary)
                        }.multilineTextAlignment(.center).padding(24)
                            .frame(maxWidth: .infinity, minHeight: max(300, geometry.size.height - 30))
                    }
                }
                .safeAreaInset(edge: .bottom, spacing: 0) {
                    if let clip = model.clip {
                        HStack(spacing: 0) {
                            coverButton(clip).frame(maxWidth: .infinity)
                            Menu {
                                Picker("画面比例", selection: $model.aspectRatio) {
                                    ForEach(OutputAspect.allCases) { aspect in Text(aspect.title).tag(aspect) }
                                }
                            } label: {
                                VStack(spacing: 5) {
                                    Image(systemName: "aspectratio").font(.system(size: 16))
                                    Text(model.aspectRatio.title).font(.caption2)
                                }.frame(minWidth: 60, minHeight: 48)
                            }.accessibilityLabel("画面比例：\(model.aspectRatio.title)").frame(maxWidth: .infinity)
                            Button { model.mute.toggle() } label: {
                                VStack(spacing: 5) {
                                    Image(systemName: model.mute ? "speaker.slash" : "speaker.wave.2")
                                        .font(.system(size: 16))
                                    Text(model.mute ? "声音已关" : "声音开启").font(.caption2)
                                }.frame(minWidth: 60, minHeight: 48)
                            }.accessibilityLabel(model.mute ? "开启声音" : "关闭声音").frame(maxWidth: .infinity)
                        }.foregroundStyle(.primary).padding(.top, 8).padding(.bottom, 4)
                            .background(editorSurface)
                            .overlay(alignment: .top) { Rectangle().fill(.white.opacity(0.10)).frame(height: 1) }
                    }
                }
            }
            .background(editorBackground)
            .navigationTitle("实况照片").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) { Text("实况照片").font(.subheadline.weight(.semibold)) }
                if model.source != nil {
                    ToolbarItem(placement: .navigationBarTrailing) {
                        Menu {
                            PhotosPicker(selection: $selection, matching: .videos, preferredItemEncoding: .current) { Label("从照片选择", systemImage: "photo.on.rectangle") }
                            Button { showFiles = true } label: { Label("从文件选择", systemImage: "folder") }
                        } label: { Image(systemName: "ellipsis").frame(width: 44, height: 44).accessibilityLabel("换个视频") }
                    }
                    ToolbarItem(placement: .navigationBarTrailing) {
                        Button(action: model.prepare) {
                            Text("预览").font(.caption.weight(.semibold))
                                .foregroundStyle(.black)
                                .padding(.horizontal, 12).padding(.vertical, 6)
                                .background(livePhotoTint, in: RoundedRectangle(cornerRadius: 8))
                                .frame(minHeight: 44)
                        }.accessibilityIdentifier("preparePhoto")
                    }
                }
            }
            .disabled(model.busy || model.saving)
            .overlay {
                if model.busy {
                    ZStack {
                        Color(.systemBackground).opacity(0.94).ignoresSafeArea()
                        VStack(spacing: 20) {
                            ProgressView().controlSize(.large)
                            Text(model.source == nil ? "正在打开视频…" : "正在准备画面…").font(.headline)
                            Text("视频留在手机上，无需上传").font(.callout).foregroundStyle(.secondary)
                        }.padding(24)
                    }.accessibilityIdentifier("workingOverlay")
                }
            }
        }
        .tint(livePhotoTint)
        .preferredColorScheme(.dark)
        .onChange(of: selection) { item in if let item { model.importItem(item); selection = nil } }
        .onChange(of: scenePhase) { phase in if phase != .active { model.pause() } }
        .fileImporter(isPresented: $showFiles, allowedContentTypes: [.movie]) { result in
            switch result {
            case .success(let url): model.importFile(url)
            case .failure(let error): model.error = error.localizedDescription
            }
        }
        .sheet(item: $model.prepared) { photo in PhotoReview(photo: photo, model: model) }
        .alert("暂时无法完成", isPresented: Binding(get: { model.prepared == nil && model.error != nil }, set: { if !$0 { model.error = nil } })) {
            Button("知道了", role: .cancel) { model.error = nil }
        } message: { Text(model.error ?? "") }
    }
    private var playButton: some View {
        Button(action: model.togglePlayback) {
            Image(systemName: model.playing ? "pause.fill" : "play.fill")
                .font(.system(size: 16)).foregroundStyle(.primary).frame(width: 44, height: 44)
        }.accessibilityLabel(model.playing ? "暂停" : "播放选段")
    }
    private func playerTime(_ clip: ClipSelection) -> some View {
        Text("\(time(model.position)) / \(time(clip.duration))")
            .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
    }
    private func coverButton(_ clip: ClipSelection) -> some View {
        Button(action: model.setCover) {
            VStack(spacing: 6) {
                Image(systemName: "photo").font(.system(size: 16))
                Text("设为封面").font(.caption2)
            }.frame(minWidth: 60, minHeight: 48)
        }
            .disabled(model.position < clip.start || model.position > clip.end)
    }
    private func time(_ value: Double) -> String {
        String(format: "%d:%04.1f", Int(max(0, value)) / 60, max(0, value).truncatingRemainder(dividingBy: 60))
    }
}

struct PlayerSurface: UIViewRepresentable {
    let player: AVPlayer
    func makeUIView(context: Context) -> PlayerLayerView { PlayerLayerView() }
    func updateUIView(_ view: PlayerLayerView, context: Context) {
        view.playerLayer.player = player; view.playerLayer.videoGravity = .resizeAspectFill
    }
}
final class PlayerLayerView: UIView {
    override class var layerClass: AnyClass { AVPlayerLayer.self }
    var playerLayer: AVPlayerLayer { layer as! AVPlayerLayer }
}

struct PhotoReview: View {
    let photo: PreparedPhoto
    @ObservedObject var model: EditorModel
    @State private var playback = 0
    var body: some View {
        NavigationStack {
            GeometryReader { geometry in
                ScrollView {
                    VStack(spacing: 20) {
                        LivePhotoSurface(photo: photo.livePhoto, playback: playback)
                            .frame(height: max(180, min(geometry.size.height * 0.65, 520)))
                            .background(.black).clipShape(RoundedRectangle(cornerRadius: 14))
                            .accessibilityLabel("实况照片预览")
                        Button { playback += 1 } label: { Label("播放实况", systemImage: "play.fill").frame(minHeight: 44) }
                        Text("也可以长按画面，看看动起来的效果。")
                            .font(.callout).foregroundStyle(.secondary).multilineTextAlignment(.center)
                        Text("\(photo.duration, specifier: "%.1f") 秒 · \(photo.mute ? "无声音" : "保留声音")")
                            .font(.caption).foregroundStyle(.secondary)
                        if model.saving { ProgressView("正在保存…") }
                    }.padding(20).frame(maxWidth: 700).frame(maxWidth: .infinity)
                }

            }
            .background(editorBackground)
            .navigationTitle("预览效果").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) { Text("预览效果").font(.subheadline.weight(.semibold)) }
                ToolbarItem(placement: .cancellationAction) { Button("返回", action: model.discardPreview).frame(minHeight: 44) }
                ToolbarItem(placement: .confirmationAction) {
                    Button(action: model.save) {
                        Text(model.saving ? "保存中…" : "保存")
                            .font(.caption.weight(.semibold)).foregroundStyle(.black)
                            .padding(.horizontal, 12).padding(.vertical, 6)
                            .background(livePhotoTint, in: RoundedRectangle(cornerRadius: 8))
                            .frame(minHeight: 44)
                    }.accessibilityIdentifier("confirmSave")
                }
            }
            .disabled(model.saving).interactiveDismissDisabled(model.saving)
            .alert("保存未完成", isPresented: Binding(get: { model.error != nil }, set: { if !$0 { model.error = nil } })) {
                Button("知道了", role: .cancel) { model.error = nil }
            } message: { Text(model.error ?? "") }
        }.tint(livePhotoTint)
    }
}

struct LivePhotoSurface: UIViewRepresentable {
    let photo: PHLivePhoto
    let playback: Int
    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeUIView(context: Context) -> PHLivePhotoView {
        let view = PHLivePhotoView(); view.contentMode = .scaleAspectFit; view.livePhoto = photo; return view
    }
    func updateUIView(_ view: PHLivePhotoView, context: Context) {
        if context.coordinator.playback != playback {
            context.coordinator.playback = playback; view.startPlayback(with: .full)
        }
    }
    static func dismantleUIView(_ view: PHLivePhotoView, coordinator: Coordinator) { view.stopPlayback() }
    final class Coordinator { var playback = 0 }
}
