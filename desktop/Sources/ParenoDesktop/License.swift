import Foundation
import CryptoKit

struct ParenoLicensePayload: Codable {
    let email: String
    let product: String
    let issued: Double
}

@MainActor
final class LicenseManager: ObservableObject {
    static let shared = LicenseManager()

    enum State: Equatable {
        case trial(daysLeft: Int)
        case expired
        case licensed(email: String)

        var title: String {
            switch self {
            case .trial(let days): return L10n.t("license.trialDays", days)
            case .expired: return L10n.t("license.expired")
            case .licensed(let email): return L10n.t("license.active", email)
            }
        }

        var isPro: Bool {
            switch self {
            case .trial(let days): return days > 0
            case .expired: return false
            case .licensed: return true
            }
        }
    }

    @Published private(set) var state: State = .trial(daysLeft: 14)
    @Published private(set) var statusMessage = ""

    let trialDays = 14
    private let publicKeyBase64 = "AQsxpfx4ZcjOf2zueeMOS4gqagcGP2JPhne4rcsEC5Q="
    private let trialStartKey = "ParenoDesktopTrialStart"
    private let licenseKeyAccount = "parenoDesktopLicense"

    private init() {
        startTrialIfNeeded()
        refresh()
    }

    func refresh() {
        let key = KeychainStore.string(for: licenseKeyAccount)
        if !key.isEmpty, let payload = verify(key) {
            state = .licensed(email: payload.email)
            return
        }
        let start = trialStart()
        let elapsed = Date().timeIntervalSince(start)
        let days = max(0, trialDays - Int(floor(max(0, elapsed) / 86_400)))
        state = days > 0 ? .trial(daysLeft: days) : .expired
    }

    @discardableResult
    func activate(_ key: String) -> Bool {
        let trimmed = key.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            statusMessage = L10n.t("license.enterKey")
            return false
        }
        guard let payload = verify(trimmed) else {
            statusMessage = L10n.t("license.invalid")
            return false
        }
        KeychainStore.set(trimmed, for: licenseKeyAccount)
        state = .licensed(email: payload.email)
        statusMessage = L10n.t("license.activated", payload.email)
        return true
    }

    func deactivate() {
        KeychainStore.set("", for: licenseKeyAccount)
        statusMessage = ""
        refresh()
    }

    private func startTrialIfNeeded() {
        if UserDefaults.standard.object(forKey: trialStartKey) == nil {
            UserDefaults.standard.set(Date().timeIntervalSince1970, forKey: trialStartKey)
        }
    }

    private func trialStart() -> Date {
        let value = UserDefaults.standard.double(forKey: trialStartKey)
        return Date(timeIntervalSince1970: value > 0 ? value : Date().timeIntervalSince1970)
    }

    private func verify(_ key: String) -> ParenoLicensePayload? {
        let parts = key.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 2,
              let payloadData = base64URLDecode(String(parts[0])),
              let signature = base64URLDecode(String(parts[1])),
              let publicKeyData = Data(base64Encoded: publicKeyBase64),
              let publicKey = try? Curve25519.Signing.PublicKey(rawRepresentation: publicKeyData),
              publicKey.isValidSignature(signature, for: payloadData),
              let payload = try? JSONDecoder().decode(ParenoLicensePayload.self, from: payloadData),
              payload.product == "pareno-desktop" else {
            return nil
        }
        return payload
    }

    private func base64URLDecode(_ value: String) -> Data? {
        var base64 = value.replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        while base64.count % 4 != 0 { base64.append("=") }
        return Data(base64Encoded: base64)
    }
}
