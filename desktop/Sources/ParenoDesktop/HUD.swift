import Cocoa

enum HUDMode: String {
    case follow
    case fixed
}

final class HUDDragHandle: NSView {
    override func mouseDown(with event: NSEvent) {
        window?.performDrag(with: event)
    }
}

@MainActor
final class CursorHUD: NSObject {
    let panel: NSPanel
    private let effect = NSVisualEffectView()
    private let stack = NSStackView()
    var onCheck: (() -> Void)?
    var onTranslate: (() -> Void)?
    var onExplain: (() -> Void)?
    var onSettings: (() -> Void)?
    var onClose: (() -> Void)?

    private var grip: HUDDragHandle?
    private var checkButton: NSButton?
    private var translateButton: NSButton?
    private var explainButton: NSButton?
    private var settingsButton: NSButton?
    private var closeButton: NSButton?
    var onMove: ((NSPoint) -> Void)?
    private(set) var mode: HUDMode = .follow

    override init() {
        panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 340, height: 38),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        super.init()
        panel.level = .floating
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
        panel.isMovableByWindowBackground = true
        panel.isReleasedWhenClosed = false

        effect.material = .hudWindow
        effect.blendingMode = .behindWindow
        effect.state = .active
        effect.wantsLayer = true
        effect.layer?.cornerRadius = 19
        effect.layer?.masksToBounds = true
        effect.frame = NSRect(x: 0, y: 0, width: 340, height: 38)
        effect.autoresizingMask = [.width, .height]
        panel.contentView = effect

        stack.orientation = .horizontal
        stack.spacing = 4
        stack.alignment = .centerY
        stack.translatesAutoresizingMaskIntoConstraints = false
        effect.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: effect.centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: effect.centerYAnchor)
        ])

        let grip = HUDDragHandle()
        grip.translatesAutoresizingMaskIntoConstraints = false
        grip.widthAnchor.constraint(equalToConstant: 12).isActive = true
        grip.heightAnchor.constraint(equalToConstant: 20).isActive = true
        stack.addArrangedSubview(grip)
        self.grip = grip

        checkButton = addButton(title: L10n.t("mode.check"), symbol: "checkmark.circle", action: #selector(checkTapped))
        let divider = NSBox()
        divider.boxType = .separator
        divider.translatesAutoresizingMaskIntoConstraints = false
        divider.heightAnchor.constraint(equalToConstant: 14).isActive = true
        stack.addArrangedSubview(divider)
        translateButton = addButton(title: L10n.t("mode.translate"), symbol: "character.book.closed", action: #selector(translateTapped))
        let divider2 = NSBox()
        divider2.boxType = .separator
        divider2.translatesAutoresizingMaskIntoConstraints = false
        divider2.heightAnchor.constraint(equalToConstant: 14).isActive = true
        stack.addArrangedSubview(divider2)
        explainButton = addButton(title: L10n.t("mode.explain"), symbol: "questionmark.circle", action: #selector(explainTapped))
        let divider3 = NSBox()
        divider3.boxType = .separator
        divider3.translatesAutoresizingMaskIntoConstraints = false
        divider3.heightAnchor.constraint(equalToConstant: 14).isActive = true
        stack.addArrangedSubview(divider3)
        settingsButton = addIconButton(symbol: "gearshape", tooltip: L10n.t("hud.settings"), action: #selector(settingsTapped))
        closeButton = addIconButton(symbol: "xmark", tooltip: L10n.t("hud.hide"), action: #selector(closeTapped))

        NotificationCenter.default.addObserver(self, selector: #selector(windowMoved), name: NSWindow.didMoveNotification, object: panel)
        applyLanguage()
        resizeToFit()
    }

    func applyLanguage() {
        checkButton?.title = L10n.t("mode.check")
        translateButton?.title = L10n.t("mode.translate")
        explainButton?.title = L10n.t("mode.explain")
        settingsButton?.toolTip = L10n.t("hud.settings")
        closeButton?.toolTip = L10n.t("hud.hide")
        grip?.toolTip = L10n.t("hud.drag")
        resizeToFit()
    }

    private func resizeToFit() {
        panel.layoutIfNeeded()
        stack.layoutSubtreeIfNeeded()
        let width = max(260, stack.fittingSize.width + 24)
        panel.setContentSize(NSSize(width: width, height: 38))
        effect.frame = NSRect(x: 0, y: 0, width: width, height: 38)
    }

    @discardableResult
    private func addButton(title: String, symbol: String, action: Selector) -> NSButton {
        let button = NSButton(title: title, target: self, action: action)
        button.image = NSImage(systemSymbolName: symbol, accessibilityDescription: title)
        button.imagePosition = .imageLeading
        button.imageHugsTitle = true
        button.isBordered = false
        button.font = .systemFont(ofSize: 11, weight: .medium)
        button.contentTintColor = .labelColor
        button.setContentHuggingPriority(.required, for: .horizontal)
        stack.addArrangedSubview(button)
        return button
    }

    @discardableResult
    private func addIconButton(symbol: String, tooltip: String, action: Selector) -> NSButton {
        let button = NSButton(image: NSImage(systemSymbolName: symbol, accessibilityDescription: tooltip) ?? NSImage(), target: self, action: action)
        button.isBordered = false
        button.imagePosition = .imageOnly
        button.contentTintColor = .secondaryLabelColor
        button.toolTip = tooltip
        button.translatesAutoresizingMaskIntoConstraints = false
        button.widthAnchor.constraint(equalToConstant: 24).isActive = true
        stack.addArrangedSubview(button)
        return button
    }

    @objc private func checkTapped() { onCheck?() }
    @objc private func translateTapped() { onTranslate?() }
    @objc private func explainTapped() { onExplain?() }
    @objc private func settingsTapped() { onSettings?() }
    @objc private func closeTapped() { onClose?() }

    @objc private func windowMoved() {
        guard mode == .fixed else { return }
        onMove?(panel.frame.origin)
    }

    func setMode(_ newMode: HUDMode, origin: NSPoint?) {
        mode = newMode
        if newMode == .fixed, let origin {
            panel.setFrameOrigin(origin)
        }
    }

    func showFixed(at origin: NSPoint?) {
        if let origin { panel.setFrameOrigin(origin) }
        if !panel.isVisible { panel.orderFrontRegardless() }
    }

    func update(caret: NSRect?) {
        guard let caret else { hide(); return }
        let size = panel.frame.size
        let screen = NSScreen.screens.first { $0.frame.contains(NSEvent.mouseLocation) } ?? NSScreen.main
        guard let visible = screen?.visibleFrame else { hide(); return }
        var x = caret.minX
        var y = caret.maxY + 6
        if x + size.width > visible.maxX { x = caret.maxX - size.width }
        if y + size.height > visible.maxY { y = caret.minY - size.height - 6 }
        if let field = SelectionService.textInputFrame() {
            y = min(y, field.maxY + 6)
        }
        x = min(max(x, visible.minX + 4), visible.maxX - size.width - 4)
        y = min(max(y, visible.minY + 4), visible.maxY - size.height - 4)
        panel.setFrameOrigin(NSPoint(x: x, y: y))
        if !panel.isVisible { panel.orderFrontRegardless() }
    }

    var origin: NSPoint { panel.frame.origin }
    var frame: NSRect { panel.frame }

    func show(at origin: NSPoint) {
        panel.setFrameOrigin(origin)
        if !panel.isVisible { panel.orderFrontRegardless() }
    }

    func keepVisible() {
        if !panel.isVisible { panel.orderFrontRegardless() }
    }

    func hide() {
        if panel.isVisible { panel.orderOut(nil) }
    }
}
