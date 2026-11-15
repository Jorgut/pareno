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
    private var lastKeyPoint: NSPoint?
    private var lastKeyTime = Date.distantPast
    private var lastCaretRect: NSRect?
    private var lastDebugLog = Date.distantPast
    private var currentLanguage = L10n.current
    private var agentStatuses: [AgentStatus] = []
    private var cloudModels: [String] = []
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
        if defaults.object(forKey: Prefs.provider) == nil {
            defaults.set(AIProvider.ollama.rawValue, forKey: Prefs.provider)
        }
        if defaults.object(forKey: Prefs.language) == nil {
            defaults.set(L10n.systemDefault.rawValue, forKey: Prefs.language)
        }
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
            self?.applyLanguageIfNeeded()
            self?.rebuildMenu()
            self?.updateHUD()
        }
        hud = CursorHUD()
        hud.onCheck = { [weak self] in self?.toggleTask(.check) }
        hud.onTranslate = { [weak self] in self?.toggleTask(.translate) }
        hud.onExplain = { [weak self] in self?.toggleTask(.explain) }
        hud.onSettings = { [weak self] in self?.openSettings() }
        hud.onClose = { [weak self] in self?.hideHUD() }
        NotificationCenter.default.addObserver(
            forName: Notification.Name("NSWindowDidOrderOffScreenNotification"), object: panel.panel, queue: .main
        ) { [weak self] _ in
            self?.hud.setActiveMode(nil)
        }
        hud.onMove = { [weak self] origin in
            guard let self else { return }
            self.fixedOrigin = origin
            if self.panel.panel.isVisible { self.panel.followHUD(self.hud.frame) }
        }
        hud.setMode(hudMode, origin: fixedOrigin)
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let button = statusItem.button {
            button.image = NSImage(systemSymbolName: "text.badge.checkmark", accessibilityDescription: "Pareno Desktop")
            button.image?.isTemplate = true
            button.toolTip = L10n.t("tooltip.hud")
        }
        rebuildMenu()
        installHotkey()
        Task.detached {
            let statuses = AgentDetector.scan()
            await MainActor.run {
                self.agentStatuses = statuses
                self.rebuildMenu()
            }
        }
        log("launched trusted=\(SelectionService.isTrusted)")
        if !SelectionService.isTrusted && !demoMode {
            SelectionService.requestTrust()
        }
        refreshModels()
        installActivityMonitors()
        startHUDTimer()
        if demoMode {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
                self?.panel.showMessage(L10n.t("panel.testMessage"))
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
        let check = NSMenuItem(title: L10n.t("menu.check"), action: #selector(checkSelection), keyEquivalent: "")
        check.target = self
        menu.addItem(check)
        let settingsItem = NSMenuItem(title: L10n.t("menu.settings"), action: #selector(openSettings), keyEquivalent: ",")
        settingsItem.target = self
        menu.addItem(settingsItem)
        menu.addItem(.separator())

        let translateItem = NSMenuItem(title: L10n.t("menu.translate"), action: #selector(translateSelection), keyEquivalent: "")
        translateItem.target = self
        menu.addItem(translateItem)
        let explainItem = NSMenuItem(title: L10n.t("menu.explain"), action: #selector(explainSelection), keyEquivalent: "")
        explainItem.target = self
        menu.addItem(explainItem)

        let show = NSMenuItem(title: hudEnabled ? L10n.t("menu.hideHUD") : L10n.t("menu.showHUD"), action: #selector(toggleFollowCaret), keyEquivalent: "h")
        show.keyEquivalentModifierMask = [.command, .option]
        show.target = self
        show.state = hudEnabled ? .on : .off
        menu.addItem(show)

        let followMode = NSMenuItem(title: L10n.t("menu.follow"), action: #selector(useFollowMode), keyEquivalent: "")
        followMode.target = self
        followMode.state = hudMode == .follow ? .on : .off
        menu.addItem(followMode)

        let fixedMode = NSMenuItem(title: L10n.t("menu.fixed"), action: #selector(useFixedMode), keyEquivalent: "")
        fixedMode.target = self
        fixedMode.state = hudMode == .fixed ? .on : .off
        menu.addItem(fixedMode)

        let resetHUD = NSMenuItem(title: L10n.t("menu.reset"), action: #selector(resetHUD), keyEquivalent: "")
        resetHUD.target = self
        menu.addItem(resetHUD)

        let aiItem = NSMenuItem(title: L10n.t("menu.ai"), action: nil, keyEquivalent: "")
        let aiSubmenu = NSMenu()
        let selectedProvider = AIProvider(rawValue: UserDefaults.standard.string(forKey: Prefs.provider) ?? "ollama") ?? .ollama
        for provider in [AIProvider.auto, .claude, .codex, .cursor, .opencode, .ollama, .ollamaCloud] {
            var title = provider.label
            var enabled = true
            if let kind = provider.agent {
                let status = agentStatuses.first { $0.kind == kind }
                if let status {
                    title += status.ready ? " · \(status.version.isEmpty ? "✓" : status.version)" : " · \(L10n.t("agents.missing"))"
                    enabled = status.ready
                } else {
                    title += " · \(L10n.t("agents.missing"))"
                    enabled = false
                }
            }
            let item = NSMenuItem(title: title, action: #selector(selectProvider(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = provider.rawValue
            item.state = selectedProvider == provider ? .on : .off
            item.isEnabled = enabled
            aiSubmenu.addItem(item)
        }
        aiItem.submenu = aiSubmenu
        menu.addItem(aiItem)

        let modelItem = NSMenuItem(title: L10n.t("menu.model"), action: nil, keyEquivalent: "")
        let submenu = NSMenu()
        if models.isEmpty {
            submenu.addItem(NSMenuItem(title: lastError.isEmpty ? L10n.t("menu.loading") : lastError, action: nil, keyEquivalent: ""))
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
        let header = NSMenuItem(title: "☁ \(L10n.t("menu.cloudModels"))", action: nil, keyEquivalent: "")
        header.isEnabled = false
        submenu.addItem(header)
        if cloudModels.isEmpty {
            let empty = NSMenuItem(title: L10n.t("settings.cloud.section"), action: nil, keyEquivalent: "")
            empty.isEnabled = false
            submenu.addItem(empty)
        } else {
            for model in cloudModels {
                let item = NSMenuItem(title: model, action: #selector(selectModel(_:)), keyEquivalent: "")
                item.target = self
                item.representedObject = model
                item.state = model == currentModel ? .on : .off
                submenu.addItem(item)
            }
        }
        submenu.addItem(.separator())
        let refresh = NSMenuItem(title: L10n.t("menu.refresh"), action: #selector(refreshModelsAction), keyEquivalent: "")
        refresh.target = self
        submenu.addItem(refresh)
        modelItem.submenu = submenu
        menu.addItem(modelItem)

        menu.addItem(.separator())
        let trust = NSMenuItem(
            title: SelectionService.isTrusted ? L10n.t("menu.trusted") : L10n.t("menu.untrusted"),
            action: #selector(openAccessibility),
            keyEquivalent: ""
        )
        trust.target = self
        menu.addItem(trust)

        menu.addItem(.separator())
        let quit = NSMenuItem(title: L10n.t("menu.quit"), action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
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

    private func applyLanguageIfNeeded() {
        let language = L10n.current
        guard language != currentLanguage else { return }
        currentLanguage = language
        hud.applyLanguage()
        panel.refreshLanguage()
        refreshModels()
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
        if let monitor = NSEvent.addGlobalMonitorForEvents(matching: .keyDown, handler: { [weak self] _ in
            self?.lastKeyPoint = NSEvent.mouseLocation
            self?.lastKeyTime = Date()
            mark()
        }) {
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
        let panelOpen = panel.panel.isVisible
        let defaults = UserDefaults.standard
        let showTyping = defaults.object(forKey: Prefs.showTyping) as? Bool ?? true
        let showSelection = defaults.object(forKey: Prefs.showSelection) as? Bool ?? true
        let autoHide = defaults.object(forKey: Prefs.autoHide) as? Double ?? 3
        let caret = SelectionService.caretRect()
        let field = SelectionService.textInputFrame()
        if let caret {
            if lastCaretRect != caret { lastTextActivity = Date() }
            lastCaretRect = caret
        } else {
            lastCaretRect = nil
        }
        let selection = SelectionService.selectedText()?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let recentlyActive = Date().timeIntervalSince(lastTextActivity) < autoHide
        if UserDefaults.standard.bool(forKey: "ParenoDebugHUD"), Date().timeIntervalSince(lastDebugLog) > 2 {
            lastDebugLog = Date()
            let role = SelectionService.focusedElement().map { SelectionService.role(of: $0) } ?? "nil"
            log("hud role=\(role) caret=\(String(describing: caret)) field=\(String(describing: field)) active=\(recentlyActive) selection=\(selection.count)")
        }
        let role = SelectionService.focusedElement().map { SelectionService.role(of: $0) } ?? ""
        let textRoles = ["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField", "AXSecureTextField"]
        let hasTextInput = field != nil || caret != nil || textRoles.contains(role)
        let hasSelection = !selection.isEmpty
        guard panelOpen || hasTextInput || hasSelection else {
            hud.hide()
            return
        }
        guard (showTyping && (recentlyActive || hasTextInput)) || (showSelection && hasSelection) else {
            hud.hide()
            return
        }
        if let caret, let field {
            let inside = field.insetBy(dx: -10, dy: -16).contains(NSPoint(x: caret.minX, y: caret.minY))
            if inside {
                if let context = SelectionService.currentParagraph() {
                    cachedContext = (context.text, context.element, caret, Date())
                }
                hud.update(caret: caret, field: field)
                lastHUDOrigin = hud.origin
                if panelOpen { panel.followHUD(hud.frame) }
                return
            }
            hud.update(caret: NSRect(x: field.minX + 8, y: field.maxY - 4, width: 2, height: 2), field: field)
            lastHUDOrigin = hud.origin
            if panelOpen { panel.followHUD(hud.frame) }
            return
        }
        if let caret, caret.minX > 1 || caret.minY > 1 {
            hud.update(caret: caret)
            lastHUDOrigin = hud.origin
            if panelOpen { panel.followHUD(hud.frame) }
            return
        }
        if let field {
            hud.update(caret: NSRect(x: field.minX, y: field.maxY, width: 2, height: 2), field: field)
            lastHUDOrigin = hud.origin
            if panelOpen { panel.followHUD(hud.frame) }
            return
        }
        if let key = lastKeyPoint, Date().timeIntervalSince(lastKeyTime) < 60 {
            hud.update(caret: NSRect(x: key.x, y: key.y + 18, width: 2, height: 2))
            lastHUDOrigin = hud.origin
            return
        }
        if let click = lastClickPoint, Date().timeIntervalSince(lastClickTime) < 300 {
            hud.update(caret: NSRect(x: click.x, y: click.y + 18, width: 2, height: 2))
            lastHUDOrigin = hud.origin
            if panelOpen { panel.followHUD(hud.frame) }
            return
        }
        if panelOpen {
            hud.keepVisible()
            panel.followHUD(hud.frame)
            return
        }
        hud.hide()
    }

    private func toggleTask(_ mode: CheckMode) {
        if panel.panel.isVisible {
            // A message / no-text card has no active mode; any of the three HUD
            // actions should dismiss it instead of immediately reopening it.
            if panel.model.state == .error, panel.model.sourceText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                panel.panel.orderOut(nil)
                hud.setActiveMode(nil)
                return
            }
            if panel.model.mode == mode {
                panel.panel.orderOut(nil)
                hud.setActiveMode(nil)
                return
            }
        }
        runTask(mode)
    }

    private func runTask(_ mode: CheckMode) {
        guard SelectionService.isTrusted else {
            SelectionService.requestTrust()
            hud.setActiveMode(nil)
        panel.showMessage(L10n.t("error.permission"), needsPermission: true)
            return
        }
        let sourceApp = NSWorkspace.shared.frontmostApplication
        if hudMode == .follow, let cached = cachedContext, Date().timeIntervalSince(cached.time) < 6 {
            panel.show(text: cached.text, mode: mode, modelName: currentModel, element: cached.element, app: sourceApp, caret: cached.caret, hudFrame: hud.frame)
            hud.setActiveMode(mode)
            return
        }
        if let context = SelectionService.currentParagraph() {
            let caret = SelectionService.caretRect()
            panel.show(text: context.text, mode: mode, modelName: currentModel, element: context.element, app: sourceApp, caret: caret, hudFrame: hud.frame)
            hud.setActiveMode(mode)
            return
        }
        if let fallback = SelectionService.copySelectionViaKeyboard(), let element = SelectionService.focusedElement() {
            panel.show(text: fallback, mode: mode, modelName: currentModel, element: element, app: sourceApp, caret: SelectionService.caretRect(), hudFrame: hud.frame)
            hud.setActiveMode(mode)
            return
        }
        hud.setActiveMode(nil)
        panel.showMessage(L10n.t("error.noText"))
    }

    @objc private func selectProvider(_ sender: NSMenuItem) {
        guard let raw = sender.representedObject as? String else { return }
        UserDefaults.standard.set(raw, forKey: Prefs.provider)
        rebuildMenu()
    }

    @objc private func selectModel(_ sender: NSMenuItem) {
        guard let model = sender.representedObject as? String else { return }
        currentModel = model
        UserDefaults.standard.set(model, forKey: "ParenoDesktopModel")
        let provider: AIProvider = cloudModels.contains(model) ? .ollamaCloud : .ollama
        UserDefaults.standard.set(provider.rawValue, forKey: Prefs.provider)
        rebuildMenu()
    }

    @objc private func refreshModelsAction() {
        refreshModels()
    }

    private func refreshModels() {
        Task {
            let local = (try? await OllamaClient().models()) ?? []
            let cloud = (try? await OllamaClient(baseURL: AIService.cloudEndpoint).models()) ?? []
            self.models = local
            self.cloudModels = cloud
            self.lastError = local.isEmpty && cloud.isEmpty ? L10n.t("error.ollamaUnavailable") : ""
            if self.currentModel.isEmpty || !(local + cloud).contains(self.currentModel) {
                let preferred = AIService.fastestModel(in: local, preferred: "")
                self.currentModel = preferred.isEmpty ? AIService.fastestCloudModel(in: cloud, preferred: "") : preferred
                UserDefaults.standard.set(self.currentModel, forKey: "ParenoDesktopModel")
            }
            self.rebuildMenu()
        }
    }

    @objc private func openAccessibility() {
        SelectionService.openAccessibilitySettings()
    }
}
