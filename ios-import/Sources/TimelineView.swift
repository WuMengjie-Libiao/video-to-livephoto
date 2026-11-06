import SwiftUI
import UIKit

enum TimelineEdge { case start, end, playhead, selection }

struct TimelineView: UIViewRepresentable {
    let clip: ClipSelection
    let position: Double
    let frames: [UIImage]
    let onChange: (TimelineEdge, Double) -> Void
    func makeUIView(context: Context) -> TimelineControl { TimelineControl() }
    func updateUIView(_ view: TimelineControl, context: Context) {
        view.clip = clip; view.position = position; view.images = frames; view.onChange = onChange
        view.setNeedsLayout()
    }
}

// Recognize only horizontal pans, so swiping vertically across the filmstrip
// continues scrolling the editor. Enlarged hit zones are independent of paint.
final class TimelineControl: UIView, UIGestureRecognizerDelegate {
    var clip: ClipSelection?
    var position: Double = 0
    var images: [UIImage] = []
    var onChange: ((TimelineEdge, Double) -> Void)?
    private let strip = UIStackView()
    private let leftShade = UIView(), rightShade = UIView(), selection = UIView()
    private let startHandle = UIView(), endHandle = UIView(), playhead = UIView(), cover = UIView()
    private var dragging: TimelineEdge = .playhead
    private var anchor: Double = 0
    private let inset: CGFloat = 24
    private var railWidth: CGFloat { max(1, bounds.width - 2 * inset) }
    private lazy var startElement = TimelineAccessibility(container: self, edge: .start, name: "片段起点")
    private lazy var endElement = TimelineAccessibility(container: self, edge: .end, name: "片段终点")
    private lazy var positionElement = TimelineAccessibility(container: self, edge: .playhead, name: "播放位置")

    override init(frame: CGRect) {
        super.init(frame: frame)
        strip.clipsToBounds = true; strip.layer.cornerRadius = 6
        strip.distribution = .fillEqually; strip.isUserInteractionEnabled = false
        addSubview(strip)
        for _ in 0..<8 {
            let image = UIImageView(); image.contentMode = .scaleAspectFill; image.clipsToBounds = true
            strip.addArrangedSubview(image)
        }
        for shade in [leftShade, rightShade] { shade.backgroundColor = UIColor.black.withAlphaComponent(0.65); addSubview(shade) }
        selection.layer.borderWidth = 2; selection.layer.borderColor = UIColor.white.cgColor
        addSubview(selection)
        for handle in [startHandle, endHandle] {
            handle.backgroundColor = UIColor.white; handle.layer.cornerRadius = 4
            handle.layer.borderColor = UIColor(white: 0.55, alpha: 1).cgColor; handle.layer.borderWidth = 0.5
            let line = UIView(); line.backgroundColor = UIColor(white: 0.28, alpha: 1); line.tag = 1; handle.addSubview(line)
            addSubview(handle)
        }
        playhead.backgroundColor = .white; playhead.layer.shadowOpacity = 0.4; playhead.layer.shadowRadius = 2
        addSubview(playhead)
        cover.backgroundColor = UIColor(red: 0.65, green: 0.85, blue: 0.87, alpha: 1); cover.layer.cornerRadius = 3; addSubview(cover)
        for view in subviews { view.isUserInteractionEnabled = false }
        let pan = UIPanGestureRecognizer(target: self, action: #selector(pan(_:)))
        pan.maximumNumberOfTouches = 1; pan.delegate = self; addGestureRecognizer(pan)
        let tap = UITapGestureRecognizer(target: self, action: #selector(tap(_:)))
        tap.require(toFail: pan); addGestureRecognizer(tap)
        isAccessibilityElement = false
        accessibilityElements = [startElement, positionElement, endElement]
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    private var viewStart: Double = 0
    private var panning = false
    private var viewSpan: Double { min(40,clip?.duration ?? 1) }
    private func x(_ time: Double) -> CGFloat { inset + CGFloat((time-viewStart)/viewSpan)*railWidth }
    override func layoutSubviews() {
        super.layoutSubviews()
        guard let clip else { return }
        if !panning { viewStart = min(max(0,clip.start-5),max(0,clip.duration-viewSpan)) }
        let y: CGFloat = 14, h: CGFloat = 52
        strip.frame = CGRect(x: inset, y: y, width: railWidth, height: h)
        for (i, view) in strip.arrangedSubviews.enumerated() { (view as! UIImageView).image = i < images.count ? images[i] : nil }
        let a = x(clip.start), b = x(clip.end)
        leftShade.frame = CGRect(x: inset, y: y, width: a - inset, height: h)
        rightShade.frame = CGRect(x: b, y: y, width: bounds.width - inset - b, height: h)
        selection.frame = CGRect(x: a, y: y - 2, width: b - a, height: h + 4)
        startHandle.frame = CGRect(x: a - 12, y: y - 3, width: 12, height: h + 6)
        endHandle.frame = CGRect(x: b, y: y - 3, width: 12, height: h + 6)
        for handle in [startHandle, endHandle] { handle.viewWithTag(1)?.frame = CGRect(x: 5, y: 19, width: 2, height: 20) }
        playhead.frame = CGRect(x: x(position) - 1, y: 6, width: 2, height: h + 18)
        cover.frame = CGRect(x: x(clip.cover) - 3, y: y + h + 7, width: 6, height: 6)
        for (element, value) in [(startElement, clip.start), (endElement, clip.end), (positionElement, position)] {
            element.accessibilityFrameInContainerSpace = CGRect(x: x(value) - 22, y: 0, width: 44, height: bounds.height)
            element.accessibilityValue = String(format: "%.2f 秒", value)
        }
    }
    override func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        guard let pan = gestureRecognizer as? UIPanGestureRecognizer else { return true }
        let translation = pan.translation(in: self)
        return abs(translation.x) > abs(translation.y)
    }
    @objc private func tap(_ gesture: UITapGestureRecognizer) {
        guard clip != nil else { return }
        let fraction = min(max(0, (gesture.location(in: self).x - inset) / railWidth), 1)
        onChange?(.playhead, viewStart + Double(fraction)*viewSpan)
    }
    @objc private func pan(_ gesture: UIPanGestureRecognizer) {
        guard let clip else { return }
        if gesture.state == .began {
            let initialX = gesture.location(in: self).x - gesture.translation(in: self).x
            let a = abs(initialX - x(clip.start)), b = abs(initialX - x(clip.end))
            if min(a, b) < 24 { dragging = a <= b ? .start : .end }
            else if initialX > x(clip.start), initialX < x(clip.end) { dragging = .selection }
            else { dragging = .playhead }
            panning = true
            switch dragging { case .start: anchor = clip.start; case .end: anchor = clip.end
            case .selection: anchor = clip.start
            case .playhead: anchor = viewStart + min(max(0, Double((initialX - inset) / railWidth)), 1)*viewSpan }
        }
        if gesture.state == .began || gesture.state == .changed || gesture.state == .ended {
            onChange?(dragging, anchor + Double(gesture.translation(in: self).x / railWidth) * viewSpan)
        }
        if gesture.state == .ended || gesture.state == .cancelled { panning = false; setNeedsLayout() }
    }
}

private final class TimelineAccessibility: UIAccessibilityElement {
    weak var control: TimelineControl?
    let edge: TimelineEdge
    init(container: TimelineControl, edge: TimelineEdge, name: String) {
        control = container; self.edge = edge
        super.init(accessibilityContainer: container)
        accessibilityLabel = name; accessibilityTraits = .adjustable
        accessibilityHint = "向上或向下轻扫以微调"
    }
    override func accessibilityIncrement() { adjust(0.1) }
    override func accessibilityDecrement() { adjust(-0.1) }
    private func adjust(_ step: Double) {
        guard let control, let clip = control.clip else { return }
        let value: Double
        switch edge { case .start: value = clip.start; case .end: value = clip.end; case .playhead: value = control.position; case .selection: value = clip.start }
        control.onChange?(edge, value + step)
    }
}
