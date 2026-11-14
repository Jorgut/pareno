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
        grip.toolTip = "拖动小工具"
        stack.addArrangedSubview(grip)

        addButton(title: "检查", symbol: "checkmark.circle", action: #selector(checkTapped))
        let divider = NSBox()
        divider.boxType = .separator
        divider.translatesAutoresizingMaskIntoConstraints = false
        divider.heightAnchor.constraint(equalToConstant: 14).isActive = true
        stack.addArrangedSubview(divider)
        addButton(title: "翻译", symbol: "character.book.closed", action: #selector(translateTapped))
        let divider2 = NSBox()
        divider2.boxType = .separator
        divider2.translatesAutoresizingMaskIntoConstraints = false
        divider2.heightAnchor.constraint(equalToConstant: 14).isActive = true
        stack.addArrangedSubview(divider2)
        addButton(title: "解释", symbol: "questionmark.circle", action: #selector(explainTapped))
        let divider3 = NSBox()
        divider3.boxType = .separator
        divider3.translatesAutoresizingMaskIntoConstraints = false
        divider3.heightAnchor.constraint(equalToConstant: 14).isActive = true
        stack.addArrangedSubview(divider3)
        addIconButton(symbol: "gearshape", tooltip: "设置", action: #selector(settingsTapped))
        addIconButton(symbol: "xmark", tooltip: "隐藏 HUD", action: #selector(closeTapped))

        NotificationCenter.default.addObserver(self, selector: #selector(windowMoved), name: NSWindow.didMoveNotification, object: panel)
    }

    private func addButton(title: String, symbol: String, action: Selector) {
        let button = NSButton(title: title, target: self, action: action)
        button.image = NSImage(systemSymbolName: symbol, accessibilityDescription: title)
        button.imagePosition = .imageLeading
        button.imageHugsTitle = true
        button.isBordered = false
        button.font = .systemFont(ofSize: 11, weight: .medium)
        button.contentTintColor = .labelColor
        button.setContentHuggingPriority(.required, for: .horizontal)
        stack.addArrangedSubview(button)
    }

    private func addIconButton(symbol: String, tooltip: String, action: Selector) {
        let button = NSButton(image: NSImage(systemSymbolName: symbol, accessibilityDescription: tooltip) ?? NSImage(), target: self, action: action)
        button.isBordered = false
        button.imagePosition = .imageOnly
        button.contentTintColor = .secondaryLabelColor
        button.toolTip = tooltip
        button.translatesAutoresizingMaskIntoConstraints = false
        button.widthAnchor.constraint(equalToConstant: 24).isActive = true
        stack.addArrangedSubview(button)
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
