import Cocoa
import SwiftUI

enum Prefs {
    static let visible = "ParenoDesktopHUDVisible"
    static let mode = "ParenoDesktopHUDMode"
    static let showTyping = "ParenoDesktopShowTyping"
    static let showSelection = "ParenoDesktopShowSelection"
    static let autoHide = "ParenoDesktopAutoHide"
    static let showInDock = "ParenoDesktopShowInDock"
    static let model = "ParenoDesktopModel"
    static let appearance = "ParenoDesktopAppearance"
    static let theme = "ParenoDesktopTheme"
    static let onboardingDone = "ParenoDesktopOnboardingDone"
    static let cardAttached = "ParenoCardAttached"
    static let language = "ParenoLanguage"
    static let cardWidth = "ParenoCardWidth"
    static let cardHeight = "ParenoCardHeight"
    static let provider = "ParenoProvider"
    static let ollamaKeyAccount = "ollamaApiKey"
    static let origin = "ParenoDesktopHUDOrigin"
    static let legacyVisible = "ParenoDesktopFollowCaret"
}

struct SettingsView: View {
    private func notifyChange() {
        NotificationCenter.default.post(name: .parenoSettingsChanged, object: nil)
    }

    @AppStorage(Prefs.visible) private var visible = true
    @AppStorage(Prefs.showTyping) private var showTyping = true
    @AppStorage(Prefs.showSelection) private var showSelection = true
    @AppStorage(Prefs.autoHide) private var autoHide = 3.0
    @AppStorage(Prefs.showInDock) private var showInDock = false
    @AppStorage(Prefs.mode) private var mode = HUDMode.follow.rawValue
    @AppStorage(Prefs.model) private var model = ""
    @AppStorage(Prefs.cardAttached) private var cardAttached = true
    @AppStorage(Prefs.provider) private var provider = "ollama"
    @State private var cloudKey = ""
    @AppStorage(Prefs.language) private var language = "en"
    @ObservedObject private var themeStore = ThemeStore.shared
    @ObservedObject private var licenseManager = LicenseManager.shared
    @State private var licenseKey = ""

    var body: some View {
        Form {
            Section(L10n.t("language.section")) {
                Picker("", selection: $language) {
                    ForEach(AppLanguage.allCases, id: \.self) { item in
                        Text(item.label).tag(item.rawValue)
                    }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
            }

            Section("Pareno HUD") {
                Toggle(L10n.t("settings.hud.show"), isOn: $visible)
                Toggle(L10n.t("settings.hud.typing"), isOn: $showTyping)
                Toggle(L10n.t("settings.hud.selection"), isOn: $showSelection)
                Picker(L10n.t("settings.hud.position"), selection: $mode) {
                    Text(L10n.t("settings.hud.follow")).tag(HUDMode.follow.rawValue)
                    Text(L10n.t("settings.hud.fixed")).tag(HUDMode.fixed.rawValue)
                }
                HStack {
                    Text(L10n.t("settings.hud.hideAfter"))
                    Slider(value: $autoHide, in: 1...8, step: 1)
                    Text(L10n.t("settings.seconds", Int(autoHide)))
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                }
            }

            Section(L10n.t("settings.card.section")) {
                Toggle(L10n.t("settings.card.attach"), isOn: $cardAttached)
                Text(L10n.t("settings.card.hint"))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Section(L10n.t("license.section")) {
                HStack {
                    Text(licenseManager.state.title)
                        .font(.system(size: 12, weight: .medium))
                    Spacer()
                    if licenseManager.state.isPro {
                        Image(systemName: "checkmark.seal.fill")
                            .foregroundStyle(themeStore.theme.accent)
                    }
                }
                SecureField(L10n.t("license.key"), text: $licenseKey)
                HStack(spacing: 8) {
                    Button(L10n.t("license.activate")) {
                        _ = licenseManager.activate(licenseKey)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(themeStore.theme.accent)
                    Button(L10n.t("license.buy")) {
                        Task {
                            if let url = await licenseManager.beginCheckout() {
                                NSWorkspace.shared.open(url)
                            }
                        }
                    }
                    .buttonStyle(.bordered)
                }
                if !licenseManager.statusMessage.isEmpty {
                    Text(licenseManager.statusMessage)
                        .font(.caption)
                        .foregroundStyle(themeStore.theme.secondaryText)
                }
            }

            Section(L10n.t("settings.startup.section")) {
                Toggle(L10n.t("settings.startup.dock"), isOn: $showInDock)
                Text(L10n.t("settings.startup.dockHint"))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Button(L10n.t("settings.startup.accessibility")) {
                    SelectionService.openAccessibilitySettings()
                }
            }

            Section(L10n.t("settings.ai.section")) {
                Picker(L10n.t("settings.ai.source"), selection: $provider) {
                    ForEach(AIProvider.allCases, id: \.rawValue) { item in
                        Text(item.label).tag(item.rawValue)
                    }
                }
                Text(L10n.t("settings.ai.hint"))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Section(L10n.t("settings.cloud.section")) {
                SecureField(L10n.t("settings.cloud.key"), text: $cloudKey)
                Text(L10n.t("settings.cloud.hint"))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Section(L10n.t("settings.model.section")) {
                LabeledContent(L10n.t("settings.model.current")) {
                    Text(model.isEmpty ? L10n.t("settings.model.none") : model)
                        .foregroundStyle(.secondary)
                }
                Text(L10n.t("settings.model.hint"))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .id(language)
        .formStyle(.grouped)
        .frame(width: 460, height: 720)
        .onChange(of: visible) { _ in notifyChange() }
        .onChange(of: showTyping) { _ in notifyChange() }
        .onChange(of: showSelection) { _ in notifyChange() }
        .onChange(of: autoHide) { _ in notifyChange() }
        .onChange(of: showInDock) { _ in notifyChange() }
        .onChange(of: mode) { _ in notifyChange() }
        .onChange(of: cardAttached) { _ in notifyChange() }
        .onChange(of: language) { _ in notifyChange() }
        .onChange(of: provider) { _ in notifyChange() }
        .onChange(of: cloudKey) { value in
            KeychainStore.set(value, for: Prefs.ollamaKeyAccount)
            notifyChange()
        }
        .onAppear { cloudKey = KeychainStore.string(for: Prefs.ollamaKeyAccount) }
        .onDisappear { notifyChange() }
    }
}

extension Notification.Name {
    static let parenoSettingsChanged = Notification.Name("ParenoSettingsChanged")
}

@MainActor
final class SettingsWindowController {
    private var window: NSWindow?

    func show() {
        if window == nil {
            let controller = NSHostingController(rootView: SettingsView())
            let panel = NSWindow(contentViewController: controller)
            panel.title = L10n.t("settings.title")
            panel.styleMask = [.titled, .closable]
            panel.isReleasedWhenClosed = false
            panel.center()
            window = panel
        }
        window?.title = L10n.t("settings.title")
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }
}
