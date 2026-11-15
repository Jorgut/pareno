import Cocoa
import SwiftUI
import Combine

enum PanelState {
    case idle
    case loading
    case result
    case error
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
                let client = OllamaClient()
                let models = try await client.models()
                let selected = models.contains(self.modelName) ? self.modelName : (models.first ?? "")
                guard !selected.isEmpty else { throw CheckError.noModel }
                self.modelName = selected
                let checked: CheckResult
                switch requestedMode {
                case .translate:
                    checked = try await Checker.translate(text: self.sourceText, model: selected, client: client)
                case .explain:
                    checked = try await Checker.explain(text: self.sourceText, model: selected, client: client)
                case .check:
                    checked = try await Checker.check(text: self.sourceText, model: selected, client: client)
                }
                self.result = checked
                self.state = .result
            } catch {
                self.error = error.localizedDescription
                self.state = .error
            }
        }
    }
}

struct ResultView: View {
    @ObservedObject var model: PanelModel

    private var height: CGFloat {
        switch model.state {
        case .loading: return 190
        case .error: return 210
        case .result: return 520
        case .idle: return 180
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            header
            sourceBox
            content
            Spacer(minLength: 0)
            footer
        }
        .padding(14)
        .frame(width: 380, height: height, alignment: .topLeading)
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
                    .frame(maxHeight: 220)
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
                    .frame(maxHeight: 170)
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
            contentRect: NSRect(x: 0, y: 0, width: 380, height: 520),
            styleMask: [.borderless, .nonactivatingPanel],
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
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true

        hosting = NSHostingView(rootView: ResultView(model: model))
        panel.contentView = hosting

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

        model.$state.sink { [weak self] state in
            guard let self else { return }
            let height: CGFloat
            switch state {
            case .loading: height = 190
            case .error: height = 210
            case .result: height = 520
            case .idle: height = 180
            }
            self.panel.setContentSize(NSSize(width: 380, height: height))
        }
        .store(in: &cancellables)
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
        var x = hudFrame.midX - size.width / 2
        var y = hudFrame.maxY + 8
        if y + size.height > visible.maxY {
            y = hudFrame.minY - size.height - 8
        }
        x = min(max(x, visible.minX + 8), visible.maxX - size.width - 8)
        y = min(max(y, visible.minY + 8), visible.maxY - size.height - 8)
        panel.setFrameOrigin(NSPoint(x: x, y: y))
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
