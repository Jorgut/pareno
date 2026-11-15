import Cocoa
import SwiftUI
import Combine

enum PanelState {
    case idle
    case loading
    case result
    case error
}

enum TailEdge {
    case none, top, bottom, left, right
}

enum CheckMode: String, CaseIterable {
    case check
    case translate
    case explain

    var title: String { L10n.t("mode.\(rawValue)") }
}

@MainActor
final class PanelModel: ObservableObject {
    @Published var sourceText = ""
    @Published var state: PanelState = .idle
    @Published var result: CheckResult?
    @Published var error = ""
    @Published var needsPermission = false
    @Published var modelName = ""
    @Published var mode: CheckMode = .check
    @Published var variant: Variant = .natural
    @Published var tailEdge: TailEdge = .none

    enum Variant: String, CaseIterable {
        case natural
        case minimal

        var title: String { L10n.t("variant.\(rawValue)") }
    }

    var onReplace: ((String) -> Void)?
    var onCopy: ((String) -> Void)?
    var onClose: (() -> Void)?
    var onOpenSettings: (() -> Void)?

    var improvedText: String {
        guard let result else { return "" }
        return variant == .natural ? result.natural : result.minimal
    }

    var explainPayload: String {
        guard let result else { return "" }
        return [result.why, result.better, result.example]
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .joined(separator: "\n\n")
    }

    var copyPayload: String { mode == .explain ? explainPayload : improvedText }

    func replace() {
        guard mode != .explain, state == .result, !improvedText.isEmpty else { return }
        onReplace?(improvedText)
    }

    func copy() {
        guard state == .result, !copyPayload.isEmpty else { return }
        onCopy?(copyPayload)
    }

    func close() { onClose?() }

    func setMode(_ newMode: CheckMode) {
        guard mode != newMode else { return }
        mode = newMode
        if !sourceText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, state == .result || state == .error {
            run()
        }
    }

    func run() {
        guard !sourceText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            error = L10n.t("error.noText")
            needsPermission = false
            state = .error
            return
        }
        state = .loading
        result = nil
        needsPermission = false
        error = ""
        let requestedMode = mode
        Task {
            do {
                let provider = AIProvider(rawValue: UserDefaults.standard.string(forKey: Prefs.provider) ?? "auto") ?? .auto
                let outcome = try await AIService.run(
                    mode: requestedMode,
                    text: self.sourceText,
                    provider: provider,
                    model: self.modelName
                )
                self.result = outcome.result
                self.modelName = outcome.source
                self.state = .result
            } catch {
                self.error = error.localizedDescription
                self.state = .error
            }
        }
    }
}

struct TailShape: Shape {
    let edge: TailEdge

    func path(in rect: CGRect) -> Path {
        let w = rect.width
        let h = rect.height
        let r = min(4, min(w, h) * 0.28)
        var path = Path()

        switch edge {
        case .bottom, .top:
            let flip = edge == .top
            func y(_ value: CGFloat) -> CGFloat { flip ? h - value : value }
            path.move(to: CGPoint(x: 0, y: y(0)))
            path.addLine(to: CGPoint(x: w, y: y(0)))
            path.addQuadCurve(to: CGPoint(x: w * 0.58, y: y(h - r)), control: CGPoint(x: w * 0.78, y: y(h * 0.55)))
            path.addQuadCurve(to: CGPoint(x: w * 0.42, y: y(h - r)), control: CGPoint(x: w * 0.50, y: y(h * 1.04)))
            path.addQuadCurve(to: CGPoint(x: 0, y: y(0)), control: CGPoint(x: w * 0.22, y: y(h * 0.55)))
        case .right:
            path.move(to: CGPoint(x: 0, y: 0))
            path.addLine(to: CGPoint(x: 0, y: h))
            path.addQuadCurve(to: CGPoint(x: w - r, y: h * 0.58), control: CGPoint(x: w * 0.55, y: h * 0.82))
            path.addQuadCurve(to: CGPoint(x: w - r, y: h * 0.42), control: CGPoint(x: w * 1.04, y: h * 0.50))
            path.addQuadCurve(to: CGPoint(x: 0, y: 0), control: CGPoint(x: w * 0.55, y: h * 0.18))
        case .left:
            path.move(to: CGPoint(x: w, y: 0))
            path.addLine(to: CGPoint(x: w, y: h))
            path.addQuadCurve(to: CGPoint(x: r, y: h * 0.58), control: CGPoint(x: w * 0.45, y: h * 0.82))
            path.addQuadCurve(to: CGPoint(x: r, y: h * 0.42), control: CGPoint(x: -w * 0.04, y: h * 0.50))
            path.addQuadCurve(to: CGPoint(x: w, y: 0), control: CGPoint(x: w * 0.45, y: h * 0.18))
        case .none:
            break
        }
        path.closeSubpath()
        return path
    }
}

struct ResultView: View {
    @ObservedObject var model: PanelModel

    var body: some View {
        cardBody
            .padding(16)
            .frame(minWidth: 340, maxWidth: .infinity, minHeight: 200, maxHeight: .infinity, alignment: .topLeading)
    }

    private var cardBody: some View {
        VStack(alignment: .leading, spacing: 10) {
            header
            sourceBox
            content
            Spacer(minLength: 0)
            footer
        }
        .padding(14)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .strokeBorder(Color.white.opacity(0.10), lineWidth: 1)
        )
        .overlay(alignment: tailAlignment) {
            if model.tailEdge != .none {
                let side = model.tailEdge == .left || model.tailEdge == .right
                let size = side ? CGSize(width: 15, height: 35) : CGSize(width: 35, height: 15)
                ZStack {
                    TailShape(edge: model.tailEdge)
                        .fill(.regularMaterial)
                    TailShape(edge: model.tailEdge)
                        .stroke(Color.white.opacity(0.08), lineWidth: 1)
                    Rectangle()
                        .fill(.regularMaterial)
                        .frame(width: side ? 4 : 34, height: side ? 34 : 4)
                        .offset(coverOffset)
                }
                .frame(width: size.width, height: size.height)
                .offset(tailOffset)
            }
        }
    }

    private var coverOffset: CGSize {
        switch model.tailEdge {
        case .bottom: return CGSize(width: 0, height: -1)
        case .top: return CGSize(width: 0, height: 1)
        case .left: return CGSize(width: 1, height: 0)
        case .right: return CGSize(width: -1, height: 0)
        case .none: return .zero
        }
    }

    private var tailOffset: CGSize {
        switch model.tailEdge {
        case .bottom: return CGSize(width: 0, height: 8)
        case .top: return CGSize(width: 0, height: -8)
        case .left: return CGSize(width: -8, height: 0)
        case .right: return CGSize(width: 8, height: 0)
        case .none: return .zero
        }
    }

    private var header: some View {
        HStack(spacing: 8) {
            Text("P")
                .font(.system(size: 11, weight: .bold, design: .serif))
                .foregroundStyle(Color(red: 0.17, green: 0.14, blue: 0.08))
                .frame(width: 20, height: 20)
                .background(
                    LinearGradient(
                        colors: [Color(red: 0.93, green: 0.82, blue: 0.58), Color(red: 0.78, green: 0.64, blue: 0.37)],
                        startPoint: .topLeading, endPoint: .bottomTrailing
                    ),
                    in: RoundedRectangle(cornerRadius: 6, style: .continuous)
                )
            Text("Pareno Desktop").font(.system(size: 13, weight: .semibold))
            Spacer()
            Picker("", selection: Binding(
                get: { model.mode },
                set: { model.setMode($0) }
            )) {
                ForEach(CheckMode.allCases, id: \.self) { mode in
                    Text(mode.title).tag(mode)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .frame(width: 190)
            Button {
                model.close()
            } label: {
                Image(systemName: "xmark.circle.fill").font(.system(size: 14))
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
        }
    }

    private var tailAlignment: Alignment {
        switch model.tailEdge {
        case .top: return .top
        case .bottom: return .bottom
        case .left: return .leading
        case .right: return .trailing
        case .none: return .center
        }
    }

    private var sourceBox: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(L10n.t("panel.source"))
                .font(.system(size: 10))
                .foregroundStyle(.secondary)
            Text(model.sourceText.isEmpty ? L10n.t("panel.noSelection") : model.sourceText)
                .font(.system(size: 12))
                .lineLimit(3)
                .textSelection(.enabled)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(9)
        .background(Color.primary.opacity(0.05), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
    }

    @ViewBuilder
    private var content: some View {
        switch model.state {
        case .idle:
            EmptyView()
        case .loading:
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text(model.mode == .translate ? L10n.t("panel.translating") : model.mode == .explain ? L10n.t("panel.explaining") : L10n.t("panel.checking"))
                    .font(.system(size: 12))
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        case .error:
            VStack(alignment: .leading, spacing: 8) {
                Text(model.error)
                    .font(.system(size: 12))
                    .foregroundStyle(.red)
                    .textSelection(.enabled)
                if model.needsPermission {
                    Button(L10n.t("panel.openAccessibility")) { model.onOpenSettings?() }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                }
            }
        case .result:
            if let result = model.result {
                if model.mode == .check {
                    if result.issues.isEmpty {
                        Text(L10n.t("panel.noIssues")).font(.system(size: 12)).foregroundStyle(.secondary)
                    } else {
                        ScrollView {
                            VStack(alignment: .leading, spacing: 7) {
                                ForEach(result.issues) { issue in
                                    VStack(alignment: .leading, spacing: 2) {
                                        HStack(spacing: 5) {
                                            Text(issue.label)
                                                .font(.system(size: 9, weight: .semibold))
                                                .foregroundStyle(tagColor(issue.type))
                                                .padding(.horizontal, 5)
                                                .padding(.vertical, 1)
                                                .background(tagColor(issue.type).opacity(0.14))
                                                .clipShape(Capsule())
                                            Text(issue.source).strikethrough().font(.system(size: 11))
                                            Text("→").font(.system(size: 10)).foregroundStyle(.secondary)
                                            Text(issue.replacement).font(.system(size: 11, weight: .medium))
                                        }
                                        if !issue.reason.isEmpty {
                                            Text(issue.reason).font(.system(size: 10)).foregroundStyle(.secondary)
                                        }
                                    }
                                }
                            }
                        }
                        .frame(maxHeight: 150)
                    }
                }
                if model.mode == .explain {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 9) {
                            if !result.why.isEmpty { explainBlock(L10n.t("panel.why"), result.why, highlight: false) }
                            if !result.better.isEmpty { explainBlock(L10n.t("panel.better"), result.better, highlight: true) }
                            if !result.example.isEmpty { explainBlock(L10n.t("panel.example"), result.example, highlight: false) }
                        }
                    }
                    .frame(maxHeight: .infinity)
                } else {
                    HStack(spacing: 8) {
                        Picker("", selection: $model.variant) {
                            ForEach(PanelModel.Variant.allCases, id: \.self) { variant in
                                Text(model.mode == .translate ? L10n.t(variant == .natural ? "variant.naturalTranslation" : "variant.faithfulTranslation") : variant.title)
                                    .tag(variant)
                            }
                        }
                        .pickerStyle(.segmented)
                        .labelsHidden()
                        .frame(width: 180)
                        if model.mode == .check, !result.explanation.isEmpty {
                            Text(result.explanation).font(.system(size: 10)).foregroundStyle(.secondary).lineLimit(1)
                        }
                    }
                    ScrollView {
                        Text(model.improvedText.isEmpty ? L10n.t("panel.noContent") : model.improvedText)
                            .font(.system(size: 12))
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(9)
                    }
                    .frame(maxHeight: .infinity)
                    .background(Color.primary.opacity(0.045), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
                }
            }
        }
    }

    private func tagColor(_ type: String) -> Color {
        switch type {
        case "grammar": return Color(red: 0.86, green: 0.65, blue: 0.63)
        case "vocabulary": return Color(red: 0.85, green: 0.74, blue: 0.47)
        default: return Color(red: 0.64, green: 0.74, blue: 0.68)
        }
    }

    private func explainBlock(_ title: String, _ text: String, highlight: Bool) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.system(size: 9, weight: .semibold))
                .foregroundStyle(.secondary)
                .textCase(.uppercase)
            Text(text)
                .font(.system(size: 12))
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(8)
                .background(
                    highlight ? Color.accentColor.opacity(0.10) : Color.primary.opacity(0.045),
                    in: RoundedRectangle(cornerRadius: 8, style: .continuous)
                )
        }
    }

    private var footer: some View {
        HStack(spacing: 8) {
            if model.mode == .explain {
                Button(L10n.t("panel.copyExplanation")) { model.copy() }
                    .buttonStyle(.borderedProminent)
                    .tint(Color(red: 0.85, green: 0.74, blue: 0.47))
                    .controlSize(.small)
                    .disabled(model.state != .result)
            } else {
                Button(model.mode == .translate ? L10n.t("panel.replaceTranslation") : L10n.t("panel.replace")) { model.replace() }
                    .buttonStyle(.borderedProminent)
                    .tint(Color(red: 0.85, green: 0.74, blue: 0.47))
                    .controlSize(.small)
                    .disabled(model.state != .result)
                Button(L10n.t("panel.copy")) { model.copy() }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .disabled(model.state != .result)
            }
            Spacer()
            Text(model.modelName).font(.system(size: 10)).foregroundStyle(.secondary).lineLimit(1)
        }
    }
}

final class ResizeGripView: NSView {
    weak var panel: NSWindow?
    private var startFrame = NSRect.zero
    private var startPoint = NSPoint.zero

    override func draw(_ dirtyRect: NSRect) {
        NSColor.secondaryLabelColor.withAlphaComponent(0.55).setStroke()
        let path = NSBezierPath()
        path.lineWidth = 1
        for index in 0..<3 {
            let offset = CGFloat(4 + index * 4)
            path.move(to: NSPoint(x: bounds.maxX - offset, y: 2))
            path.line(to: NSPoint(x: bounds.maxX - 2, y: offset))
        }
        path.stroke()
    }

    override func resetCursorRects() {
        addCursorRect(bounds, cursor: .crosshair)
    }

    override func mouseDown(with event: NSEvent) {
        guard let panel else { return }
        startFrame = panel.frame
        startPoint = NSEvent.mouseLocation
    }

    override func mouseDragged(with event: NSEvent) {
        guard let panel else { return }
        let point = NSEvent.mouseLocation
        let dx = point.x - startPoint.x
        let dy = point.y - startPoint.y
        let minWidth = panel.minSize.width
        let minHeight = panel.minSize.height
        let width = max(minWidth, startFrame.width + dx)
        let height = max(minHeight, startFrame.height + dy)
        var frame = startFrame
        frame.size = NSSize(width: width, height: height)
        frame.origin.y = startFrame.maxY - height
        panel.setFrame(frame, display: true)
        saveSize()
    }

    private func saveSize() {
        guard let panel else { return }
        UserDefaults.standard.set(Double(panel.frame.width), forKey: Prefs.cardWidth)
        UserDefaults.standard.set(Double(panel.frame.height), forKey: Prefs.cardHeight)
    }

    override func mouseUp(with event: NSEvent) {
        saveSize()
    }
}

@MainActor
final class ResultPanelController: NSObject, NSWindowDelegate {
    let panel: NSPanel
    let model = PanelModel()
    var sourceElement: AXUIElement?
    var sourceApp: NSRunningApplication?
    private var hosting: NSHostingView<ResultView>!
    private var cancellables: Set<AnyCancellable> = []

    var attachedToHUD: Bool {
        UserDefaults.standard.object(forKey: Prefs.cardAttached) as? Bool ?? true
    }

    override init() {
        panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 380, height: 420),
            styleMask: [.borderless, .nonactivatingPanel, .resizable],
            backing: .buffered,
            defer: false
        )
        super.init()
        panel.isFloatingPanel = true
        panel.level = NSWindow.Level(rawValue: NSWindow.Level.floating.rawValue + 1)
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
        panel.isMovableByWindowBackground = true
        panel.contentMinSize = NSSize(width: 320, height: 220)
        panel.minSize = NSSize(width: 320, height: 220)
        let savedWidth = UserDefaults.standard.double(forKey: Prefs.cardWidth)
        let savedHeight = UserDefaults.standard.double(forKey: Prefs.cardHeight)
        if savedWidth >= 320, savedHeight >= 220 {
            panel.setContentSize(NSSize(width: savedWidth, height: savedHeight))
        }
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true

        hosting = NSHostingView(rootView: ResultView(model: model))
        panel.contentView = hosting
        let grip = ResizeGripView(frame: NSRect(x: hosting.bounds.width - 18, y: 0, width: 18, height: 18))
        grip.panel = panel
        grip.autoresizingMask = [.minXMargin, .maxYMargin]
        hosting.addSubview(grip)
        NotificationCenter.default.addObserver(
            forName: Notification.Name("NSWindowDidEndLiveResizeNotification"), object: panel, queue: .main
        ) { [weak self] _ in
            self?.saveCardSize()
        }

        model.onReplace = { [weak self] text in
            guard let self else { return }
            if let element = self.sourceElement, SelectionService.setSelectedText(text, on: element) {
                self.panel.orderOut(nil)
                return
            }
            self.panel.orderOut(nil)
            self.sourceApp?.activate(options: [.activateIgnoringOtherApps])
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
                SelectionService.paste(text)
            }
        }
        model.onCopy = { text in
            let pasteboard = NSPasteboard.general
            pasteboard.clearContents()
            pasteboard.setString(text, forType: .string)
        }
        model.onClose = { [weak self] in self?.panel.orderOut(nil) }
        model.onOpenSettings = { SelectionService.openAccessibilitySettings() }

    }

    func show(text: String, mode: CheckMode, modelName: String, element: AXUIElement?, app: NSRunningApplication?, caret: NSRect?, hudFrame: NSRect? = nil) {
        sourceElement = element
        sourceApp = app
        model.sourceText = text
        model.mode = mode
        model.modelName = modelName
        model.result = nil
        model.error = ""
        model.state = .loading
        model.tailEdge = .none
        place(caret: caret)
        if attachedToHUD, let hudFrame { placeAboveHUD(hudFrame) }
        panel.orderFrontRegardless()
        model.run()
    }

    func showMessage(_ message: String, needsPermission: Bool = false) {
        sourceElement = nil
        sourceApp = nil
        model.sourceText = ""
        model.result = nil
        model.needsPermission = needsPermission
        model.error = message
        model.state = .error
        place(caret: SelectionService.caretRect())
        panel.orderFrontRegardless()
    }

    func saveCardSize() {
        UserDefaults.standard.set(Double(panel.frame.width), forKey: Prefs.cardWidth)
        UserDefaults.standard.set(Double(panel.frame.height), forKey: Prefs.cardHeight)
    }

    func refreshLanguage() {
        hosting.rootView = ResultView(model: model)
    }

    func followHUD(_ hudFrame: NSRect) {
        guard attachedToHUD, panel.isVisible else { return }
        placeAboveHUD(hudFrame)
    }

    func placeAboveHUD(_ hudFrame: NSRect) {
        let size = panel.frame.size
        guard let visible = NSScreen.screens.first(where: { $0.frame.intersects(hudFrame) })?.visibleFrame else { return }
        var width = min(size.width, visible.width - 16)
        var height = min(size.height, visible.height - 16)
        var x = hudFrame.midX - width / 2
        var y = hudFrame.maxY + 8

        let availableAbove = (visible.maxY - 8) - (hudFrame.maxY + 8)
        if availableAbove >= 220 {
            height = min(height, availableAbove)
            y = hudFrame.maxY + 8
            model.tailEdge = .bottom
        } else {
            let availableBelow = (hudFrame.minY - 8) - (visible.minY + 8)
            if availableBelow >= 220 {
                height = min(height, availableBelow)
                y = hudFrame.minY - height - 8
                model.tailEdge = .top
            } else {
                y = visible.midY - height / 2
                if hudFrame.maxX + 8 + width <= visible.maxX {
                    x = hudFrame.maxX + 8
                    model.tailEdge = .left
                } else {
                    x = hudFrame.minX - width - 8
                    model.tailEdge = .right
                }
            }
        }

        height = max(220, height)
        x = min(max(x, visible.minX + 8), visible.maxX - width - 8)
        y = min(max(y, visible.minY + 8), visible.maxY - height - 8)
        panel.setFrame(NSRect(x: x, y: y, width: width, height: height), display: true)
    }

    private func place(caret: NSRect?) {
        let size = panel.frame.size
        let screen = NSScreen.screens.first { $0.frame.contains(NSEvent.mouseLocation) } ?? NSScreen.main
        guard let visible = screen?.visibleFrame else { return }
        var origin: NSPoint
        if let caret {
            origin = NSPoint(x: caret.maxX + 8, y: caret.minY - size.height - 8)
            if origin.x + size.width > visible.maxX { origin.x = max(visible.minX + 8, caret.minX - size.width - 8) }
            if origin.y < visible.minY { origin.y = caret.maxY + 8 }
        } else {
            origin = NSPoint(x: visible.midX - size.width / 2, y: visible.midY - size.height / 2)
        }
        origin.x = min(max(origin.x, visible.minX + 8), visible.maxX - size.width - 8)
        origin.y = min(max(origin.y, visible.minY + 8), visible.maxY - size.height - 8)
        panel.setFrameOrigin(origin)
    }
}
