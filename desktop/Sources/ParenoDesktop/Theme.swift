import AppKit
import SwiftUI

enum ParenoTheme: String, CaseIterable, Identifiable {
    case champagne
    case paper
    case ink

    var id: String { rawValue }

    var title: String { L10n.t("skin.\(rawValue)") }
    var note: String { L10n.t("skin.\(rawValue).note") }

    var colorScheme: ColorScheme {
        switch self {
        case .paper: return .light
        case .champagne, .ink: return .dark
        }
    }

    var hudMaterial: NSVisualEffectView.Material { .hudWindow }

    var hudTint: NSColor {
        switch self {
        case .champagne:
            return NSColor(calibratedRed: 0.118, green: 0.106, blue: 0.086, alpha: 0.88)
        case .paper:
            return NSColor(calibratedRed: 0.984, green: 0.969, blue: 0.933, alpha: 0.92)
        case .ink:
            return NSColor(calibratedRed: 0.082, green: 0.125, blue: 0.169, alpha: 0.90)
        }
    }

    var hudText: NSColor {
        switch self {
        case .champagne: return NSColor(calibratedRed: 0.965, green: 0.937, blue: 0.882, alpha: 1)
        case .paper: return NSColor(calibratedRed: 0.133, green: 0.122, blue: 0.102, alpha: 1)
        case .ink: return NSColor(calibratedRed: 0.902, green: 0.929, blue: 0.949, alpha: 1)
        }
    }

    var hudSecondary: NSColor {
        switch self {
        case .champagne: return NSColor(calibratedRed: 0.647, green: 0.608, blue: 0.545, alpha: 1)
        case .paper: return NSColor(calibratedRed: 0.431, green: 0.396, blue: 0.345, alpha: 1)
        case .ink: return NSColor(calibratedRed: 0.584, green: 0.643, blue: 0.690, alpha: 1)
        }
    }

    var hudAccent: NSColor {
        switch self {
        case .champagne: return NSColor(calibratedRed: 0.847, green: 0.737, blue: 0.471, alpha: 1)
        case .paper: return NSColor(calibratedRed: 0.690, green: 0.514, blue: 0.235, alpha: 1)
        case .ink: return NSColor(calibratedRed: 0.788, green: 0.663, blue: 0.420, alpha: 1)
        }
    }

    var hudBorder: NSColor {
        switch self {
        case .champagne: return NSColor(calibratedRed: 0.227, green: 0.204, blue: 0.165, alpha: 0.9)
        case .paper: return NSColor(calibratedRed: 0.835, green: 0.784, blue: 0.702, alpha: 0.95)
        case .ink: return NSColor(calibratedRed: 0.173, green: 0.227, blue: 0.282, alpha: 0.95)
        }
    }

    var cardBackgroundNS: NSColor {
        switch self {
        case .champagne: return NSColor(calibratedRed: 0.102, green: 0.094, blue: 0.078, alpha: 0.96)
        case .paper: return NSColor(calibratedRed: 0.984, green: 0.969, blue: 0.933, alpha: 0.98)
        case .ink: return NSColor(calibratedRed: 0.082, green: 0.125, blue: 0.169, alpha: 0.97)
        }
    }

    var cardBorder: Color {
        switch self {
        case .champagne: return Color(red: 0.227, green: 0.204, blue: 0.165)
        case .paper: return Color(red: 0.835, green: 0.784, blue: 0.702)
        case .ink: return Color(red: 0.173, green: 0.227, blue: 0.282)
        }
    }

    var cardBackground: Color { Color(nsColor: cardBackgroundNS) }

    var text: Color {
        switch self {
        case .champagne: return Color(red: 0.965, green: 0.937, blue: 0.882)
        case .paper: return Color(red: 0.133, green: 0.122, blue: 0.102)
        case .ink: return Color(red: 0.902, green: 0.929, blue: 0.949)
        }
    }

    var secondaryText: Color {
        switch self {
        case .champagne: return Color(red: 0.647, green: 0.608, blue: 0.545)
        case .paper: return Color(red: 0.431, green: 0.396, blue: 0.345)
        case .ink: return Color(red: 0.584, green: 0.643, blue: 0.690)
        }
    }

    var accent: Color { Color(nsColor: hudAccent) }

    var onAccent: Color {
        switch self {
        case .champagne: return Color(red: 0.137, green: 0.110, blue: 0.063)
        case .paper: return Color(red: 1.0, green: 0.976, blue: 0.929)
        case .ink: return Color(red: 0.102, green: 0.078, blue: 0.039)
        }
    }

    var markBarNS: NSColor {
        switch self {
        case .champagne: return NSColor(calibratedRed: 0.957, green: 0.937, blue: 0.894, alpha: 1)
        case .paper: return NSColor(calibratedRed: 0.133, green: 0.122, blue: 0.102, alpha: 1)
        case .ink: return NSColor(calibratedRed: 0.863, green: 0.890, blue: 0.910, alpha: 1)
        }
    }

    var markCursorNS: NSColor { hudAccent }
    var markBar: Color { Color(nsColor: markBarNS) }
    var markCursor: Color { Color(nsColor: markCursorNS) }
}

@MainActor
final class ThemeStore: ObservableObject {
    static let shared = ThemeStore()

    @Published var theme: ParenoTheme {
        didSet {
            UserDefaults.standard.set(theme.rawValue, forKey: Prefs.theme)
            NotificationCenter.default.post(name: .parenoThemeChanged, object: nil)
        }
    }

    private init() {
        let raw = UserDefaults.standard.string(forKey: Prefs.theme) ?? ParenoTheme.champagne.rawValue
        theme = ParenoTheme(rawValue: raw) ?? .champagne
    }
}

extension Notification.Name {
    static let parenoThemeChanged = Notification.Name("ParenoThemeChanged")
}

struct ThemeMarkView: View {
    let theme: ParenoTheme

    var body: some View {
        Canvas { context, size in
            let scale = min(size.width / 64, size.height / 64)
            let offsetX = (size.width - 64 * scale) / 2
            let offsetY = (size.height - 64 * scale) / 2
            let bars: [(CGFloat, CGFloat, CGFloat)] = [
                (6, 13.75, 52),
                (6, 27.75, 46),
                (6, 41.75, 40)
            ]
            for (x, y, width) in bars {
                let rect = CGRect(
                    x: offsetX + x * scale,
                    y: offsetY + y * scale,
                    width: width * scale,
                    height: 8.5 * scale
                )
                context.fill(Path(roundedRect: rect, cornerRadius: 4.25 * scale), with: .color(theme.markBar))
            }
            let cursor = CGRect(
                x: offsetX + 51 * scale,
                y: offsetY + 39 * scale,
                width: 7 * scale,
                height: 20.5 * scale
            )
            context.fill(Path(cursor), with: .color(theme.markCursor))
        }
        .accessibilityLabel("Pareno")
    }
}
