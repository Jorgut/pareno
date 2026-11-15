import Foundation

struct AIResult {
    let result: CheckResult
    let source: String
}

enum AIService {
    static let cloudEndpoint = URL(string: "https://ollama.com")!

    static func run(mode: CheckMode, text: String, provider: AIProvider, model: String) async throws -> AIResult {
        if provider == .auto {
            for kind in AgentKind.allCases where AgentDetector.locate(kind.executable) != nil {
                if let result = try? await runAgent(kind: kind, mode: mode, text: text) {
                    return result
                }
            }
            return try await runOllama(mode: mode, text: text, model: model, cloud: false)
        }

        if provider == .ollamaCloud {
            return try await runOllama(mode: mode, text: text, model: model, cloud: true)
        }

        if let kind = provider.agent {
            guard AgentDetector.locate(kind.executable) != nil else {
                throw CheckError.ollama(L10n.t("agents.missing"))
            }
            return try await runAgent(kind: kind, mode: mode, text: text)
        }

        return try await runOllama(mode: mode, text: text, model: model, cloud: false)
    }

    private static func runAgent(kind: AgentKind, mode: CheckMode, text: String) async throws -> AIResult {
        let messages = messages(for: mode, text: text)
        let raw = try await AgentClient.complete(kind: kind, system: messages.system, user: messages.user)
        return AIResult(result: try Checker.decode(raw, original: text), source: kind.label)
    }

    private static func runOllama(mode: CheckMode, text: String, model: String, cloud: Bool) async throws -> AIResult {
        let client: OllamaClient
        let selected: String
        if cloud {
            let key = KeychainStore.string(for: Prefs.ollamaKeyAccount)
            guard !key.isEmpty else { throw CheckError.ollama(L10n.t("error.cloudKey")) }
            let endpoint = cloudEndpoint
            let catalog = try await OllamaClient(baseURL: endpoint).models()
            selected = fastestCloudModel(in: catalog, preferred: model)
            guard !selected.isEmpty else { throw CheckError.noModel }
            client = OllamaClient(baseURL: endpoint, apiKey: key)
        } else {
            client = OllamaClient()
            let installed = try await client.models()
            selected = fastestModel(in: installed, preferred: model)
            guard !selected.isEmpty else { throw CheckError.noModel }
        }
        let checked: CheckResult
        switch mode {
        case .check:
            checked = try await Checker.check(text: text, model: selected, client: client)
        case .translate:
            checked = try await Checker.translate(text: text, model: selected, client: client)
        case .explain:
            checked = try await Checker.explain(text: text, model: selected, client: client)
        }
        return AIResult(result: checked, source: selected)
    }

    static func fastestModel(in models: [String], preferred: String) -> String {
        if models.contains(preferred), !preferred.lowercased().contains("gpt-oss") {
            return preferred
        }
        let ranked = ["qwen3.5:4b", "gemma4:12b", "qwen3.8:27b", "qwen2.5:7b", "gemma3:4b", "llama3.2:3b"]
        for name in ranked {
            if let match = models.first(where: { $0 == name || $0.hasPrefix(name + ":") }) {
                return match
            }
        }
        return models.first(where: { !$0.lowercased().contains("gpt-oss") }) ?? models.first ?? ""
    }

    static func fastestCloudModel(in models: [String], preferred: String) -> String {
        if models.contains(preferred) { return preferred }
        let ranked = ["deepseek-v4.1-flash", "glm-5.3-flash", "kimi-k3.1-pro"]
        for name in ranked {
            if let match = models.first(where: { $0 == name || $0.hasPrefix(name + ":") }) {
                return match
            }
        }
        return models.first ?? ""
    }

    private static func messages(for mode: CheckMode, text: String) -> (system: String, user: String) {
        switch mode {
        case .check:
            let list = Checker.messages(for: text)
            return (list[0].content, list[1].content)
        case .translate:
            return (Checker.translatePrompt, jsonPayload(text))
        case .explain:
            return (Checker.explainPrompt, jsonPayload(text))
        }
    }

    private static func jsonPayload(_ text: String) -> String {
        let data = (try? JSONSerialization.data(withJSONObject: ["text": text])) ?? Data("{}".utf8)
        return String(data: data, encoding: .utf8) ?? "{}"
    }
}
