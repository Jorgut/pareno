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
    @AppStorage(Prefs.appearance) private var appearance = "system"

    var body: some View {
        Form {
            Section("Pareno HUD") {
                Toggle("显示 Pareno HUD", isOn: $visible)
                Toggle("输入时出现", isOn: $showTyping)
                Toggle("选中文字时出现", isOn: $showSelection)
                Picker("位置", selection: $mode) {
                    Text("吸附光标").tag(HUDMode.follow.rawValue)
                    Text("固定位置（可拖动）").tag(HUDMode.fixed.rawValue)
                }
                HStack {
                    Text("停止输入后隐藏")
                    Slider(value: $autoHide, in: 1...8, step: 1)
                    Text("\(Int(autoHide)) 秒").monospacedDigit().foregroundStyle(.secondary)
                }
            }

            Section("外观") {
                Picker("主题", selection: $appearance) {
                    Text("跟随系统").tag("system")
                    Text("深色").tag("dark")
                    Text("浅色").tag("light")
                }
            }

            Section("启动与权限") {
                Toggle("在 Dock 显示图标", isOn: $showInDock)
                Text("关闭 Dock 图标后，Pareno Desktop 仍在菜单栏运行；完全退出后可从 Applications 或 Finder 重新打开。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Button("打开辅助功能设置") {
                    SelectionService.openAccessibilitySettings()
                }
            }

            Section("模型") {
                LabeledContent("当前模型") {
                    Text(model.isEmpty ? "未选择" : model).foregroundStyle(.secondary)
                }
                Text("在菜单栏图标 → 模型 中切换。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        .frame(width: 460, height: 560)
        .onChange(of: visible) { _ in notifyChange() }
        .onChange(of: showTyping) { _ in notifyChange() }
        .onChange(of: showSelection) { _ in notifyChange() }
        .onChange(of: autoHide) { _ in notifyChange() }
        .onChange(of: showInDock) { _ in notifyChange() }
        .onChange(of: mode) { _ in notifyChange() }
        .onChange(of: appearance) { _ in notifyChange() }
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
            panel.title = "Pareno Desktop 设置"
            panel.styleMask = [.titled, .closable]
            panel.isReleasedWhenClosed = false
            panel.center()
            window = panel
        }
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }
}
