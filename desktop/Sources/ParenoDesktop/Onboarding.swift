import AppKit
import SwiftUI

@MainActor
final class OnboardingWindowController: NSWindowController, NSWindowDelegate {
    private var didFinish = false
    private let onFinish: () -> Void

    init(onFinish: @escaping () -> Void) {
        self.onFinish = onFinish
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 560, height: 560),
            styleMask: [.titled, .closable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = "Pareno"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.isReleasedWhenClosed = false
        window.center()
        super.init(window: window)
        window.contentView = NSHostingView(rootView: OnboardingView(onFinish: { [weak self] in
            self?.finish()
        }))
        window.delegate = self
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func present() {
        guard let window else { return }
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
    }

    private func finish() {
        guard !didFinish else { return }
        didFinish = true
        UserDefaults.standard.set(true, forKey: Prefs.onboardingDone)
        close()
        onFinish()
    }

    func windowWillClose(_ notification: Notification) {
        UserDefaults.standard.set(true, forKey: Prefs.onboardingDone)
        if !didFinish {
            didFinish = true
            onFinish()
        }
    }
}

private enum OnboardingStep: Int, CaseIterable {
    case welcome
    case accessibility
    case model
    case skin
}

private struct OnboardingView: View {
    @ObservedObject private var themeStore = ThemeStore.shared
    @State private var step: OnboardingStep = .welcome
    @State private var trusted = SelectionService.isTrusted
    @State private var models: [String] = []
    @State private var loadingModels = false
    @State private var modelError = ""
    let onFinish: () -> Void

    private var theme: ParenoTheme { themeStore.theme }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider().overlay(theme.cardBorder)
            content
            Spacer(minLength: 0)
            footer
        }
        .padding(28)
        .frame(width: 560, height: 560)
        .background(theme.cardBackground)
        .environment(\.colorScheme, theme.colorScheme)
        .onAppear { refreshModels() }
    }

    private var header: some View {
        HStack(spacing: 10) {
            ThemeMarkView(theme: theme).frame(width: 26, height: 26)
            VStack(alignment: .leading, spacing: 1) {
                Text("PARENO").font(.system(size: 15, weight: .semibold, design: .serif)).tracking(2)
                Text("并言").font(.system(size: 10)).foregroundStyle(theme.secondaryText)
            }
            Spacer()
            HStack(spacing: 6) {
                ForEach(OnboardingStep.allCases, id: \.rawValue) { item in
                    Capsule()
                        .fill(item.rawValue <= step.rawValue ? theme.accent : theme.cardBorder)
                        .frame(width: 18, height: 3)
                }
            }
        }
        .foregroundStyle(theme.text)
        .padding(.bottom, 18)
    }

    @ViewBuilder private var content: some View {
        switch step {
        case .welcome:
            VStack(alignment: .leading, spacing: 16) {
                Text(L10n.t("onboarding.title"))
                    .font(.system(size: 30, weight: .medium, design: .serif))
                    .foregroundStyle(theme.text)
                Text(L10n.t("onboarding.lead"))
                    .font(.system(size: 13))
                    .lineSpacing(5)
                    .foregroundStyle(theme.secondaryText)
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 14) {
                    onboardingPoint("⌥⌘G", L10n.t("onboarding.point.hotkey"))
                    onboardingPoint("⌃⌥H", L10n.t("onboarding.point.hud"))
                }
                .padding(.top, 6)
            }
        case .accessibility:
            VStack(alignment: .leading, spacing: 14) {
                Text(L10n.t("onboarding.accessibility.title"))
                    .font(.system(size: 24, weight: .medium, design: .serif))
                    .foregroundStyle(theme.text)
                Text(L10n.t("onboarding.accessibility.lead"))
                    .font(.system(size: 12.5))
                    .lineSpacing(4)
                    .foregroundStyle(theme.secondaryText)
                HStack(spacing: 8) {
                    Circle().fill(trusted ? Color.green : Color.orange).frame(width: 7, height: 7)
                    Text(trusted ? L10n.t("onboarding.accessibility.granted") : L10n.t("onboarding.accessibility.missing"))
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(theme.text)
                    Spacer()
                }
                .padding(10)
                .background(theme.text.opacity(0.045), in: RoundedRectangle(cornerRadius: 8))
                Text(L10n.t("onboarding.accessibility.hint"))
                    .font(.system(size: 11))
                    .foregroundStyle(theme.secondaryText)
                HStack(spacing: 8) {
                    Button(L10n.t("onboarding.accessibility.open")) {
                        SelectionService.openAccessibilitySettings()
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(theme.accent)
                    .foregroundStyle(theme.onAccent)
                    Button(L10n.t("onboarding.accessibility.check")) {
                        trusted = SelectionService.isTrusted
                    }
                    .buttonStyle(.bordered)
                }
            }
        case .model:
            VStack(alignment: .leading, spacing: 14) {
                Text(L10n.t("onboarding.model.title"))
                    .font(.system(size: 24, weight: .medium, design: .serif))
                    .foregroundStyle(theme.text)
                Text(L10n.t("onboarding.model.lead"))
                    .font(.system(size: 12.5))
                    .lineSpacing(4)
                    .foregroundStyle(theme.secondaryText)
                if loadingModels {
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small)
                        Text(L10n.t("onboarding.model.loading")).font(.system(size: 12)).foregroundStyle(theme.secondaryText)
                    }
                } else if models.isEmpty {
                    Text(modelError.isEmpty ? L10n.t("onboarding.model.none") : modelError)
                        .font(.system(size: 12))
                        .foregroundStyle(theme.secondaryText)
                } else {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 6) {
                            ForEach(models, id: \.self) { name in
                                HStack {
                                    Text(name).font(.system(size: 12, weight: name == recommended ? .semibold : .regular))
                                    Spacer()
                                    if name == recommended {
                                        Text(L10n.t("onboarding.model.recommended"))
                                            .font(.system(size: 9))
                                            .foregroundStyle(theme.accent)
                                    }
                                }
                                .padding(.horizontal, 10).padding(.vertical, 7)
                                .background(theme.text.opacity(0.045), in: RoundedRectangle(cornerRadius: 7))
                            }
                        }
                    }
                    .frame(maxHeight: 130)
                }
                HStack(spacing: 8) {
                    Button(L10n.t("onboarding.model.download")) {
                        if let url = URL(string: "https://ollama.com/download") { NSWorkspace.shared.open(url) }
                    }
                    .buttonStyle(.bordered)
                    Button(L10n.t("onboarding.model.refresh")) { refreshModels() }
                        .buttonStyle(.bordered)
                }
            }
        case .skin:
            VStack(alignment: .leading, spacing: 14) {
                Text(L10n.t("onboarding.skin.title"))
                    .font(.system(size: 24, weight: .medium, design: .serif))
                    .foregroundStyle(theme.text)
                Text(L10n.t("onboarding.skin.lead"))
                    .font(.system(size: 12.5))
                    .lineSpacing(4)
                    .foregroundStyle(theme.secondaryText)
                HStack(spacing: 10) {
                    ForEach(ParenoTheme.allCases) { item in
                        Button { themeStore.theme = item } label: {
                            VStack(alignment: .leading, spacing: 6) {
                                RoundedRectangle(cornerRadius: 8).fill(item.cardBackground).frame(height: 54)
                                    .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(item.cardBorder, lineWidth: 1))
                                Text(item.title).font(.system(size: 11, weight: .medium)).foregroundStyle(theme.text)
                            }
                            .padding(7)
                            .background(themeStore.theme == item ? item.accent.opacity(0.16) : Color.clear, in: RoundedRectangle(cornerRadius: 9))
                            .overlay(RoundedRectangle(cornerRadius: 9).strokeBorder(themeStore.theme == item ? item.accent : Color.clear, lineWidth: 1))
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
    }

    private func onboardingPoint(_ key: String, _ text: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(key).font(.system(size: 11, weight: .semibold, design: .monospaced)).foregroundStyle(theme.accent)
            Text(text).font(.system(size: 11)).foregroundStyle(theme.secondaryText)
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(theme.text.opacity(0.04), in: RoundedRectangle(cornerRadius: 8))
    }

    private var footer: some View {
        HStack(spacing: 8) {
            Button(L10n.t("onboarding.skip")) { onFinish() }
                .buttonStyle(.plain)
                .foregroundStyle(theme.secondaryText)
            Spacer()
            if step != .welcome {
                Button(L10n.t("onboarding.back")) {
                    if let previous = OnboardingStep(rawValue: step.rawValue - 1) { step = previous }
                }
                .buttonStyle(.bordered)
            }
            Button(step == .skin ? L10n.t("onboarding.finish") : L10n.t("onboarding.next")) {
                if let next = OnboardingStep(rawValue: step.rawValue + 1) {
                    step = next
                } else {
                    onFinish()
                }
            }
            .buttonStyle(.borderedProminent)
            .tint(theme.accent)
            .foregroundStyle(theme.onAccent)
        }
        .padding(.top, 16)
    }

    private var recommended: String { "qwen3.5:4b" }

    private func refreshModels() {
        loadingModels = true
        modelError = ""
        Task {
            do {
                let list = try await OllamaClient().models()
                await MainActor.run {
                    models = list
                    loadingModels = false
                }
            } catch {
                await MainActor.run {
                    models = []
                    modelError = error.localizedDescription
                    loadingModels = false
                }
            }
        }
    }
}
