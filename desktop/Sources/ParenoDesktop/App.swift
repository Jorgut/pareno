import Cocoa
import Carbon.HIToolbox

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private var panel: ResultPanelController!
    private var hotKeyRef: EventHotKeyRef?
    private var hotKeyHandler: EventHandlerRef?
    private var demoMode: Bool { CommandLine.arguments.contains("--demo") }
    private var models: [String] = []
    private var lastError = ""
    private var currentModel: String = UserDefaults.standard.string(forKey: "ParenoDesktopModel") ?? ""
    private var hud: CursorHUD!
    private var hudTimer: Timer?
    private var hudEnabled = UserDefaults.standard.object(forKey: Prefs.visible) as? Bool
        ?? UserDefaults.standard.object(forKey: Prefs.legacyVisible) as? Bool ?? true
    private var settingsWindow: SettingsWindowController?
    private var lastDockPolicy = false
    private var settingsObserver: NSObjectProtocol?
    private var hudMode: HUDMode = {
        let raw = UserDefaults.standard.string(forKey: "ParenoDesktopHUDMode") ?? "follow"
        return HUDMode(rawValue: raw) ?? .follow
    }()
    private var cachedContext: (text: String, element: AXUIElement, caret: NSRect, time: Date)?
    private var lastTextActivity = Date.distantPast
    private var lastClickPoint: NSPoint?
    private var lastClickTime = Date.distantPast
    private var activityMonitors: [Any] = []
    private var lastHUDOrigin: NSPoint?
    private var fixedOrigin: NSPoint? {
        get {
            guard let raw = UserDefaults.standard.string(forKey: "ParenoDesktopHUDOrigin") else { return nil }
            let parts = raw.split(separator: ",").compactMap { Double($0) }
            guard parts.count == 2 else { return nil }
            return NSPoint(x: parts[0], y: parts[1])
        }
        set {
            if let newValue {
                UserDefaults.standard.set("\(newValue.x),\(newValue.y)", forKey: "ParenoDesktopHUDOrigin")
            } else {
                UserDefaults.standard.removeObject(forKey: "ParenoDesktopHUDOrigin")
            }
        }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        panel = ResultPanelController()
        let defaults = UserDefaults.standard
        if defaults.object(forKey: Prefs.visible) == nil,
           let legacy = defaults.object(forKey: Prefs.legacyVisible) as? Bool {
            defaults.set(legacy, forKey: Prefs.visible)
        }
        settingsWindow = SettingsWindowController()
        if CommandLine.arguments.contains("--settings") {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
                self?.settingsWindow?.show()
            }
        }
        applyDockPolicy()
        applyAppearance()
        settingsObserver = NotificationCenter.default.addObserver(
            forName: .parenoSettingsChanged, object: nil, queue: .main
        ) { [weak self] _ in
            self?.applyDockPolicy()
            self?.applyAppearance()
            self?.reloadPreferences()
            self?.rebuildMenu()
            self?.updateHUD()
        }
        hud = CursorHUD()
        hud.onCheck = { [weak self] in self?.runTask(.check) }
        hud.onTranslate = { [weak self] in self?.runTask(.translate) }
        hud.onExplain = { [weak self] in self?.runTask(.explain) }
        hud.onSettings = { [weak self] in self?.openSettings() }
        hud.onClose = { [weak self] in self?.hideHUD() }
        hud.onMove = { [weak self] origin in self?.fixedOrigin = origin }
        hud.setMode(hudMode, origin: fixedOrigin)
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let button = statusItem.button {
            button.image = NSImage(systemSymbolName: "text.badge.checkmark", accessibilityDescription: "Pareno Desktop")
            button.image?.isTemplate = true
            button.toolTip = "Pareno Desktop · 选中文字后 ⌥⌘G"
        }
        rebuildMenu()
        installHotkey()
        log("launched trusted=\(SelectionService.isTrusted)")
        if !SelectionService.isTrusted && !demoMode {
            SelectionService.requestTrust()
        }
        refreshModels()
        installActivityMonitors()
        startHUDTimer()
        if demoMode {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
                self?.panel.showMessage("面板测试：在任意 App 选中文字后按 ⌥⌘G。若没有反应，请在系统设置里给 Pareno Desktop 辅助功能权限。")
            }
        }
        if CommandLine.arguments.contains("--settings") {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
                self?.settingsWindow?.show()
            }
        }
        if CommandLine.arguments.contains("--hud-demo") {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
                let mouse = NSEvent.mouseLocation
                self?.hud.update(caret: NSRect(x: mouse.x, y: mouse.y, width: 2, height: 16))
            }
        }
    }

    private func rebuildMenu() {
        let menu = NSMenu()
        let check = NSMenuItem(title: "检查选区  ⌥⌘G", action: #selector(checkSelection), keyEquivalent: "")
        check.target = self
        menu.addItem(check)
        let settingsItem = NSMenuItem(title: "设置…", action: #selector(openSettings), keyEquivalent: ",")
        settingsItem.target = self
        menu.addItem(settingsItem)
        menu.addItem(.separator())

        let translateItem = NSMenuItem(title: "翻译当前段落", action: #selector(translateSelection), keyEquivalent: "")
        translateItem.target = self
        menu.addItem(translateItem)
        let explainItem = NSMenuItem(title: "解释当前段落", action: #selector(explainSelection), keyEquivalent: "")
        explainItem.target = self
        menu.addItem(explainItem)

        let show = NSMenuItem(title: hudEnabled ? "隐藏 Pareno HUD" : "显示 Pareno HUD", action: #selector(toggleFollowCaret), keyEquivalent: "h")
        show.keyEquivalentModifierMask = [.command, .option]
        show.target = self
        show.state = hudEnabled ? .on : .off
        menu.addItem(show)

        let followMode = NSMenuItem(title: "吸附光标", action: #selector(useFollowMode), keyEquivalent: "")
        followMode.target = self
        followMode.state = hudMode == .follow ? .on : .off
        menu.addItem(followMode)

        let fixedMode = NSMenuItem(title: "固定位置（可拖动）", action: #selector(useFixedMode), keyEquivalent: "")
        fixedMode.target = self
        fixedMode.state = hudMode == .fixed ? .on : .off
        menu.addItem(fixedMode)

        let resetHUD = NSMenuItem(title: "重置小工具位置", action: #selector(resetHUD), keyEquivalent: "")
        resetHUD.target = self
        menu.addItem(resetHUD)

        let modelItem = NSMenuItem(title: "模型", action: nil, keyEquivalent: "")
        let submenu = NSMenu()
        if models.isEmpty {
            submenu.addItem(NSMenuItem(title: lastError.isEmpty ? "读取中…" : lastError, action: nil, keyEquivalent: ""))
        } else {
            for model in models {
                let item = NSMenuItem(title: model, action: #selector(selectModel(_:)), keyEquivalent: "")
                item.target = self
                item.representedObject = model
                item.state = model == currentModel ? .on : .off
                submenu.addItem(item)
            }
        }
        submenu.addItem(.separator())
        let refresh = NSMenuItem(title: "刷新模型", action: #selector(refreshModelsAction), keyEquivalent: "")
        refresh.target = self
        submenu.addItem(refresh)
        modelItem.submenu = submenu
        menu.addItem(modelItem)

        menu.addItem(.separator())
        let trust = NSMenuItem(
            title: SelectionService.isTrusted ? "辅助功能：已授权" : "辅助功能：未授权（点击设置）",
            action: #selector(openAccessibility),
            keyEquivalent: ""
        )
        trust.target = self
        menu.addItem(trust)

        menu.addItem(.separator())
        let quit = NSMenuItem(title: "退出 Pareno Desktop", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        menu.addItem(quit)
        statusItem.menu = menu
    }

    private func installHotkey() {
        var eventType = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        let pointer = Unmanaged.passUnretained(self).toOpaque()
        InstallEventHandler(GetApplicationEventTarget(), { _, _, userData in
            guard let userData else { return noErr }
            let delegate = Unmanaged<AppDelegate>.fromOpaque(userData).takeUnretainedValue()
            DispatchQueue.main.async { delegate.checkSelection() }
            return noErr
        }, 1, &eventType, pointer, &hotKeyHandler)
        let hotKeyID = EventHotKeyID(signature: OSType(0x5743484B), id: 1)
        let status = RegisterEventHotKey(UInt32(kVK_ANSI_G), UInt32(cmdKey | optionKey), hotKeyID, GetApplicationEventTarget(), 0, &hotKeyRef)
        log("hotkey registered status=\(status)")
    }

    private func log(_ message: String) {
        let line = "\(Date()): \(message)\n"
        guard let data = line.data(using: .utf8) else { return }
        let url = URL(fileURLWithPath: "/tmp/pareno-desktop.log")
        if let handle = try? FileHandle(forWritingTo: url) {
            handle.seekToEndOfFile()
            handle.write(data)
            try? handle.close()
        } else {
            try? data.write(to: url)
        }
    }

    @objc func checkSelection() {
        runTask(.check)
    }

    private func hideHUD() {
        hudEnabled = false
        UserDefaults.standard.set(false, forKey: Prefs.visible)
        hud.hide()
        rebuildMenu()
    }

    @objc private func openSettings() {
        settingsWindow?.show()
    }

    private func applyAppearance() {
        switch UserDefaults.standard.string(forKey: Prefs.appearance) ?? "system" {
        case "dark": NSApp.appearance = NSAppearance(named: .darkAqua)
        case "light": NSApp.appearance = NSAppearance(named: .aqua)
        default: NSApp.appearance = nil
        }
    }

    private func applyDockPolicy() {
        let show = UserDefaults.standard.bool(forKey: Prefs.showInDock)
        guard show != lastDockPolicy else { return }
        lastDockPolicy = show
        NSApp.setActivationPolicy(show ? .regular : .accessory)
    }

    private func reloadPreferences() {
        let defaults = UserDefaults.standard
        if let value = defaults.object(forKey: Prefs.visible) as? Bool { hudEnabled = value }
        if let raw = defaults.string(forKey: Prefs.mode) { hudMode = HUDMode(rawValue: raw) ?? .follow }
    }

    @objc private func translateSelection() {
        runTask(.translate)
    }

    @objc private func explainSelection() {
        runTask(.explain)
    }

    @objc private func toggleFollowCaret() {
        hudEnabled.toggle()
        UserDefaults.standard.set(hudEnabled, forKey: Prefs.visible)
        if !hudEnabled { hud.hide() }
        rebuildMenu()
        updateHUD()
    }

    @objc private func useFollowMode() {
        hudMode = .follow
        UserDefaults.standard.set(hudMode.rawValue, forKey: Prefs.mode)
        hud.setMode(.follow, origin: nil)
        rebuildMenu()
        updateHUD()
    }

    @objc private func resetHUD() {
        fixedOrigin = nil
        hudMode = .follow
        UserDefaults.standard.set(hudMode.rawValue, forKey: Prefs.mode)
        hud.setMode(.follow, origin: nil)
        rebuildMenu()
        updateHUD()
    }

    @objc private func useFixedMode() {
        hudMode = .fixed
        UserDefaults.standard.set(hudMode.rawValue, forKey: Prefs.mode)
        if fixedOrigin == nil, let visible = NSScreen.main?.visibleFrame {
            fixedOrigin = NSPoint(x: visible.maxX - 220, y: visible.minY + 80)
        }
        hud.setMode(.fixed, origin: fixedOrigin)
        rebuildMenu()
        updateHUD()
    }

    private func installActivityMonitors() {
        let mark = { [weak self] in self?.lastTextActivity = Date() }
        if let monitor = NSEvent.addGlobalMonitorForEvents(matching: .keyDown, handler: { _ in mark() }) {
            activityMonitors.append(monitor)
        }
        if let monitor = NSEvent.addGlobalMonitorForEvents(matching: .leftMouseDown, handler: { [weak self] _ in
            self?.lastClickPoint = NSEvent.mouseLocation
            self?.lastClickTime = Date()
            mark()
        }) {
            activityMonitors.append(monitor)
        }
    }

    private func startHUDTimer() {
        hudTimer?.invalidate()
        let timer = Timer(timeInterval: 0.6, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.updateHUD() }
        }
        RunLoop.main.add(timer, forMode: .common)
        hudTimer = timer
    }

    private func updateHUD() {
        if CommandLine.arguments.contains("--hud-demo") { return }
        guard hudEnabled, SelectionService.isTrusted else {
            hud.hide()
            return
        }
        if hudMode == .fixed {
            hud.showFixed(at: fixedOrigin)
            return
        }
        if panel.panel.isVisible {
            hud.keepVisible()
            return
        }
        let defaults = UserDefaults.standard
        let showTyping = defaults.object(forKey: Prefs.showTyping) as? Bool ?? true
        let showSelection = defaults.object(forKey: Prefs.showSelection) as? Bool ?? true
        let autoHide = defaults.object(forKey: Prefs.autoHide) as? Double ?? 3
        let selection = SelectionService.selectedText()?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let recentlyActive = Date().timeIntervalSince(lastTextActivity) < autoHide
        guard (showTyping && recentlyActive) || (showSelection && !selection.isEmpty) else {
            hud.hide()
            return
        }
        let caret = SelectionService.caretRect()
        let field = SelectionService.textInputFrame()
        if let caret, let field {
            let inside = field.insetBy(dx: -10, dy: -16).contains(NSPoint(x: caret.minX, y: caret.minY))
            if inside {
                if let context = SelectionService.currentParagraph() {
                    cachedContext = (context.text, context.element, caret, Date())
                }
                hud.update(caret: caret)
                lastHUDOrigin = hud.origin
                return
            }
            hud.update(caret: NSRect(x: field.minX, y: field.maxY, width: 2, height: 2))
            lastHUDOrigin = hud.origin
            return
        }
        if let caret, caret.minX > 1 || caret.minY > 1 {
            hud.update(caret: caret)
            lastHUDOrigin = hud.origin
            return
        }
        if let field {
            hud.update(caret: NSRect(x: field.minX, y: field.maxY, width: 2, height: 2))
            lastHUDOrigin = hud.origin
            return
        }
        if let click = lastClickPoint, Date().timeIntervalSince(lastClickTime) < 300 {
            hud.update(caret: NSRect(x: click.x, y: click.y + 18, width: 2, height: 2))
            lastHUDOrigin = hud.origin
            return
        }
        hud.hide()
    }

    private func runTask(_ mode: CheckMode) {
        guard SelectionService.isTrusted else {
            SelectionService.requestTrust()
            panel.showMessage("需要辅助功能权限：打开 系统设置 → 隐私与安全性 → 辅助功能，勾选 Pareno Desktop，然后再试一次。")
            return
        }
        let sourceApp = NSWorkspace.shared.frontmostApplication
        if hudMode == .follow, let cached = cachedContext, Date().timeIntervalSince(cached.time) < 6 {
            panel.show(text: cached.text, mode: mode, modelName: currentModel, element: cached.element, app: sourceApp, caret: cached.caret)
            return
        }
        if let context = SelectionService.currentParagraph() {
            let caret = SelectionService.caretRect()
            panel.show(text: context.text, mode: mode, modelName: currentModel, element: context.element, app: sourceApp, caret: caret)
            return
        }
        if let fallback = SelectionService.copySelectionViaKeyboard(), let element = SelectionService.focusedElement() {
            panel.show(text: fallback, mode: mode, modelName: currentModel, element: element, app: sourceApp, caret: SelectionService.caretRect())
            return
        }
        panel.showMessage("没有找到可检查的文字。请把光标放进一段文字，或先选中一段。")
    }

    @objc private func selectModel(_ sender: NSMenuItem) {
        guard let model = sender.representedObject as? String else { return }
        currentModel = model
        UserDefaults.standard.set(model, forKey: "ParenoDesktopModel")
        rebuildMenu()
    }

    @objc private func refreshModelsAction() {
        refreshModels()
    }

    private func refreshModels() {
        Task {
            do {
                let list = try await OllamaClient().models()
                self.models = list
                self.lastError = list.isEmpty ? "未找到模型" : ""
                if self.currentModel.isEmpty || !list.contains(self.currentModel) {
                    self.currentModel = list.first ?? ""
                    UserDefaults.standard.set(self.currentModel, forKey: "ParenoDesktopModel")
                }
            } catch {
                self.lastError = "Ollama 不可用"
            }
            self.rebuildMenu()
        }
    }

    @objc private func openAccessibility() {
        SelectionService.openAccessibilitySettings()
    }
}
