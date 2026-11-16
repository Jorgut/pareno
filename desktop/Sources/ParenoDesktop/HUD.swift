import Cocoa

enum HUDMode: String {
    case follow
    case fixed
}

final class HUDDragHandle: NSView {
    override func mouseDown(with event: NSEvent) {
        window?.performDrag(with: event)
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        // Same R3 geometry as the app icon, scaled into the HUD handle.
        let scale: CGFloat = 13.2 / 45.75
        let baseY: CGFloat = 3.4
        let ivory = NSColor(calibratedRed: 0.96, green: 0.94, blue: 0.89, alpha: 0.94)
        let gold = NSColor(calibratedRed: 0.85, green: 0.73, blue: 0.45, alpha: 1)
        let bars: [(CGFloat, CGFloat, CGFloat)] = [
            (13.75, 52, 8.5),
            (27.75, 46, 8.5),
            (41.75, 40, 8.5)
        ]
        ivory.setFill()
        for (top, width, height) in bars {
            let y = baseY + (45.75 - (top - 13.75) - height) * scale
            let barHeight = height * scale
            NSBezierPath(
                roundedRect: NSRect(x: 1, y: y, width: width * scale, height: barHeight),
                xRadius: barHeight / 2,
                yRadius: barHeight / 2
            ).fill()
        }
        gold.setFill()
        NSBezierPath(
            rect: NSRect(x: 1 + (51 - 6) * scale, y: baseY, width: 7 * scale, height: 20.5 * scale)
        ).fill()
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
    private var activeMode: CheckMode?
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
        grip.widthAnchor.constraint(equalToConstant: 18).isActive = true
        grip.heightAnchor.constraint(equalToConstant: 20).isActive = true
        stack.addArrangedSubview(grip)
        self.grip = grip

        let brandDivider = NSBox()
        brandDivider.boxType = .separator
        brandDivider.translatesAutoresizingMaskIntoConstraints = false
        brandDivider.heightAnchor.constraint(equalToConstant: 14).isActive = true
        stack.addArrangedSubview(brandDivider)

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
        applyButtonStyles()
        resizeToFit()
    }

    func setActiveMode(_ mode: CheckMode?) {
        activeMode = mode
        applyButtonStyles()
    }

    private func applyButtonStyles() {
        let gold = NSColor(calibratedRed: 0.95, green: 0.84, blue: 0.60, alpha: 1)
        let buttons: [(NSButton?, CheckMode)] = [
            (checkButton, .check), (translateButton, .translate), (explainButton, .explain)
        ]
        for (button, mode) in buttons {
            guard let button else { continue }
            let active = activeMode == mode
            button.wantsLayer = true
            button.layer?.cornerRadius = 9
            button.layer?.backgroundColor = active
                ? NSColor(calibratedRed: 0.85, green: 0.73, blue: 0.45, alpha: 0.22).cgColor
                : NSColor.clear.cgColor
            button.contentTintColor = active ? gold : .labelColor
            button.toolTip = "\(mode.title) · \(L10n.t("hud.collapseHint"))"
            button.setAccessibilityValue(active ? "on" : "off")
            button.setAccessibilityHelp(L10n.t("hud.collapseHint"))
        }
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
    private func addButton(title: String, symbol: String? = nil, image: NSImage? = nil, action: Selector) -> NSButton {
        let button = NSButton(title: title, target: self, action: action)
        if let image {
            button.image = image
        } else if let symbol {
            button.image = NSImage(systemSymbolName: symbol, accessibilityDescription: title)
        }
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

    func update(caret: NSRect?, field: NSRect? = nil) {
        guard let caret else { hide(); return }
        let size = panel.frame.size
        let caretCenter = NSPoint(x: caret.midX, y: caret.midY)
        let screen = NSScreen.screens.first { $0.frame.contains(caretCenter) } ?? NSScreen.main
        guard let visible = screen?.visibleFrame else { hide(); return }
        let gap: CGFloat = 8
        let upperLimit = field.map { min($0.maxY, visible.maxY) } ?? visible.maxY
        var origin: NSPoint?

        // 1. Above the whole focused input, not just above the caret.
        // This keeps the HUD out of multi-line fields and chat composers,
        // where placing it above the caret covers the previous text line.
        if let field {
            let x = min(max(field.minX + 6, caret.minX), visible.maxX - size.width - 4)
            let aboveField = NSPoint(x: x, y: field.maxY + gap)
            if aboveField.y + size.height <= visible.maxY - 4,
               aboveField.y >= visible.minY + 4 {
                origin = aboveField
            }
        }

        // 2. Right of the whole field, vertically centered on the caret.
        if origin == nil, let field {
            let right = NSPoint(x: field.maxX + gap, y: caret.midY - size.height / 2)
            if right.x + size.width <= visible.maxX - 4,
               right.y >= visible.minY + 4,
               right.y + size.height <= visible.maxY - 4 {
                origin = right
            }
        }

        // 3. Left of the whole field.
        if origin == nil, let field {
            let left = NSPoint(x: field.minX - size.width - gap, y: caret.midY - size.height / 2)
            if left.x >= visible.minX + 4,
               left.y >= visible.minY + 4,
               left.y + size.height <= visible.maxY - 4 {
                origin = left
            }
        }

        // 4. Above the caret, only after the field-level placements fail.
        let above = NSPoint(x: caret.minX, y: caret.maxY + gap)
        if origin == nil, above.y + size.height <= upperLimit + 0.5, above.y >= visible.minY + 4 {
            origin = above
        }

        // 5. Bottom dock, last resort.
        if origin == nil {
            origin = NSPoint(x: visible.midX - size.width / 2, y: visible.minY + 12)
        }

        var point = origin ?? NSPoint(x: caret.minX, y: caret.maxY + gap)
        point.x = min(max(point.x, visible.minX + 4), visible.maxX - size.width - 4)
        point.y = min(max(point.y, visible.minY + 4), visible.maxY - size.height - 4)
        panel.setFrameOrigin(point)
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
