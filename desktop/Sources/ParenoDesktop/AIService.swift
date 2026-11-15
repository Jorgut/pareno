import Foundation

struct AIResult {
    let result: CheckResult
    let source: String
}

enum AIService {
    static func run(mode: CheckMode, text: String, provider: AIProvider, model: String) async throws -> AIResult {
        if provider == .auto {
            for kind in AgentKind.allCases where AgentDetector.locate(kind.executable) != nil {
                if let result = try? await runAgent(kind: kind, mode: mode, text: text) {
                    return result
                }
            }
            return try await runOllama(mode: mode, text: text, model: model)
        }

        if let kind = provider.agent {
            guard AgentDetector.locate(kind.executable) != nil else {
                throw CheckError.ollama(L10n.t("agents.missing"))
            }
            return try await runAgent(kind: kind, mode: mode, text: text)
        }

        return try await runOllama(mode: mode, text: text, model: model)
    }

    private static func runAgent(kind: AgentKind, mode: CheckMode, text: String) async throws -> AIResult {
        let messages = messages(for: mode, text: text)
        let raw = try await AgentClient.complete(kind: kind, system: messages.system, user: messages.user)
        return AIResult(result: try Checker.decode(raw, original: text), source: kind.label)
    }

    private static func runOllama(mode: CheckMode, text: String, model: String) async throws -> AIResult {
        let client = OllamaClient()
        let installed = try await client.models()
        let selected = fastestModel(in: installed, preferred: model)
        guard !selected.isEmpty else { throw CheckError.noModel }
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
        let ranked = ["qwen2.5:7b", "qwen2.5:3b", "gemma3:4b", "llama3.2:3b", "phi4-mini", "mistral:7b"]
        for name in ranked {
            if let match = models.first(where: { $0 == name || $0.hasPrefix(name + ":") }) {
                return match
            }
        }
        return models.first(where: { !$0.lowercased().contains("gpt-oss") }) ?? models.first ?? ""
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
