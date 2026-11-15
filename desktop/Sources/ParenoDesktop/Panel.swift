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
                let provider = AIProvider(rawValue: UserDefaults.standard.string(forKey: Prefs.provider) ?? "ollama") ?? .auto
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
        VStack(alignment: .leading, spacing: 10) {
            header
            sourceBox
            content
            Spacer(minLength: 0)
            footer
        }
        .padding(14)
        .frame(minWidth: 340, maxWidth: .infinity, minHeight: 200, maxHeight: .infinity, alignment: .topLeading)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .strokeBorder(Color.white.opacity(0.10), lineWidth: 1)
        )
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
final class TailWindowController {
    private let panel: NSPanel

    init() {
        panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 35, height: 15),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.isFloatingPanel = true
        panel.level = NSWindow.Level(rawValue: NSWindow.Level.floating.rawValue + 2)
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.ignoresMouseEvents = true
        panel.contentView = NSHostingView(rootView: TailView(edge: .none))
    }

    func update(edge: TailEdge, cardFrame: NSRect) {
        guard edge != .none else { hide(); return }
        let side = edge == .left || edge == .right
        let size = side ? NSSize(width: 15, height: 35) : NSSize(width: 35, height: 15)
        var origin: NSPoint
        switch edge {
        case .bottom: origin = NSPoint(x: cardFrame.midX - 17.5, y: cardFrame.minY - size.height)
        case .top: origin = NSPoint(x: cardFrame.midX - 17.5, y: cardFrame.maxY)
        case .left: origin = NSPoint(x: cardFrame.minX - size.width, y: cardFrame.midY - 17.5)
        case .right: origin = NSPoint(x: cardFrame.maxX, y: cardFrame.midY - 17.5)
        case .none: return
        }
        panel.setFrame(NSRect(origin: origin, size: size), display: true)
        if !(panel.contentView is NSHostingView<TailView>) {
            panel.contentView = NSHostingView(rootView: TailView(edge: edge))
        } else {
            (panel.contentView as? NSHostingView<TailView>)?.rootView = TailView(edge: edge)
        }
        panel.orderFrontRegardless()
    }

    func hide() {
        if panel.isVisible { panel.orderOut(nil) }
    }
}

struct TailView: View {
    let edge: TailEdge
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        TailShape(edge: edge)
            .fill(scheme == .dark
                  ? Color(red: 0.169, green: 0.157, blue: 0.137)
                  : Color(red: 0.97, green: 0.96, blue: 0.94))
    }
}

@MainActor
final class ResultPanelController: NSObject, NSWindowDelegate {
    let panel: NSPanel
    let model = PanelModel()
    private let tailWindow = TailWindowController()
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
        panel.hasShadow = false

        hosting = NSHostingView(rootView: ResultView(model: model))
        panel.contentView = hosting
        let grip = ResizeGripView()
        grip.panel = panel
        grip.translatesAutoresizingMaskIntoConstraints = false
        hosting.addSubview(grip)
        NSLayoutConstraint.activate([
            grip.trailingAnchor.constraint(equalTo: hosting.trailingAnchor, constant: -6),
            grip.bottomAnchor.constraint(equalTo: hosting.bottomAnchor, constant: -6),
            grip.widthAnchor.constraint(equalToConstant: 18),
            grip.heightAnchor.constraint(equalToConstant: 18)
        ])
        NotificationCenter.default.addObserver(
            forName: Notification.Name("NSWindowDidEndLiveResizeNotification"), object: panel, queue: .main
        ) { [weak self] _ in
            self?.saveCardSize()
        }

        model.onReplace = { [weak self] text in
            guard let self else { return }
            if let element = self.sourceElement, SelectionService.setSelectedText(text, on: element) {
                self.panel.orderOut(nil)
                self.tailWindow.hide()
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
        model.onClose = { [weak self] in
            self?.panel.orderOut(nil)
            self?.tailWindow.hide()
        }
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
        syncTail()
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
        model.tailEdge = .none
        tailWindow.hide()
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
        syncTail()
    }

    private func syncTail() {
        guard panel.isVisible else { tailWindow.hide(); return }
        tailWindow.update(edge: model.tailEdge, cardFrame: panel.frame)
    }

    func placeAboveHUD(_ hudFrame: NSRect) {
        let size = panel.frame.size
        guard let visible = NSScreen.screens.first(where: { $0.frame.intersects(hudFrame) })?.visibleFrame else { return }
        var width = min(size.width, visible.width - 16)
        var height = min(size.height, visible.height - 16)
        var x = hudFrame.midX - width / 2
        var y = hudFrame.maxY + 18

        let availableAbove = (visible.maxY - 8) - (hudFrame.maxY + 18)
        if availableAbove >= 220 {
            height = min(height, availableAbove)
            y = hudFrame.maxY + 18
            model.tailEdge = .bottom
        } else if hudFrame.maxX + 18 + width <= visible.maxX {
            // Never drop below the HUD: that is where the IME candidate window lives.
            y = hudFrame.midY - height / 2
            x = hudFrame.maxX + 18
            model.tailEdge = .left
        } else if hudFrame.minX - 18 - width >= visible.minX {
            y = hudFrame.midY - height / 2
            x = hudFrame.minX - width - 18
            model.tailEdge = .right
        } else {
            // No side room: keep it above the HUD and shrink to the available strip.
            height = max(120, availableAbove)
            y = hudFrame.maxY + 18
            model.tailEdge = .bottom
        }

        height = min(max(120, height), visible.height - 16)
        x = min(max(x, visible.minX + 8), visible.maxX - width - 8)
        y = min(max(y, visible.minY + 8), visible.maxY - height - 8)
        panel.setFrame(NSRect(x: x, y: y, width: width, height: height), display: true)
        syncTail()
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
