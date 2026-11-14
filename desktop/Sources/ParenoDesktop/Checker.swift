import Foundation

struct CheckIssue: Identifiable, Codable {
    let type: String
    let source: String
    let replacement: String
    let reason: String
    var id: String { "\(type)|\(source)|\(replacement)" }

    var label: String {
        switch type {
        case "grammar": return "语法"
        case "vocabulary": return "用词"
        default: return "表达"
        }
    }
}

struct CheckResult: Codable {
    var language: String = "en"
    var issues: [CheckIssue] = []
    var minimal: String = ""
    var natural: String = ""
    var explanation: String = ""
}

enum Checker {
    static let systemPrompt = """
    You are Pareno Desktop, a bilingual writing checker for Chinese and English. The user text may be English, Chinese, or mixed.
    Identify only:
    - grammar and spelling errors, type "grammar"
    - wrong or weak word choice, bad collocations, vocabulary improvements, type "vocabulary"
    - awkward, unclear or unnatural expression, tone, flow, type "expression"
    Rules:
    - Every issue.source MUST be an exact substring of the user text. Never invent a source span.
    - reason is Simplified Chinese, concise, and explains why it is wrong or better.
    - minimal corrects only clear errors and preserves everything else.
    - natural is a natural, precise, professional rewrite. Preserve meaning, facts, names, numbers, citations and the author's voice. Do not add new content.
    - If the text is already correct, return an empty issues array and minimal equal to the text.
    Return ONLY a JSON object:
    {"language":"en|zh|mixed","issues":[{"type":"grammar","source":"...","replacement":"...","reason":"..."}],"minimal":"...","natural":"...","explanation":"中文一句话总结"}
    """

    static func messages(for text: String) -> [ChatMessage] {
        let payload = ["text": text]
        let data = (try? JSONSerialization.data(withJSONObject: payload, options: [])) ?? Data("{}".utf8)
        let content = String(data: data, encoding: .utf8) ?? "{}"
        return [
            ChatMessage(role: "system", content: systemPrompt),
            ChatMessage(role: "user", content: content)
        ]
    }

    static func check(text: String, model: String, client: OllamaClient = OllamaClient()) async throws -> CheckResult {
        let raw = try await client.chat(model: model, messages: messages(for: text))
        return try decode(raw, original: text)
    }

    static let translatePrompt = """
    You are Pareno Desktop Translate. Translate the user text between Chinese and English.
    - Chinese input: translate into natural, professional English.
    - English input: translate into natural, professional Simplified Chinese.
    - Mixed input: translate into English.
    Preserve meaning, names, numbers, citations and the author's voice. Do not add or remove content.
    Return ONLY a JSON object:
    {"language":"en|zh|mixed","issues":[],"minimal":"faithful translation","natural":"more natural, fluent translation","explanation":"中文一句话说明翻译取舍"}
    """

    static func translate(text: String, model: String, client: OllamaClient = OllamaClient()) async throws -> CheckResult {
        let payload = (try? JSONSerialization.data(withJSONObject: ["text": text])) ?? Data("{}".utf8)
        let content = String(data: payload, encoding: .utf8) ?? "{}"
        let raw = try await client.chat(model: model, messages: [
            ChatMessage(role: "system", content: translatePrompt),
            ChatMessage(role: "user", content: content)
        ])
        return try decode(raw, original: text)
    }

    static func decode(_ raw: String, original: String) throws -> CheckResult {
        let json = extractJSON(raw)
        guard let data = json.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw CheckError.decoding(String(raw.prefix(200)))
        }
        var result = CheckResult()
        result.language = object["language"] as? String ?? "en"
        result.minimal = (object["minimal"] as? String) ?? original
        result.natural = (object["natural"] as? String) ?? result.minimal
        result.explanation = (object["explanation"] as? String) ?? ""
        if let issues = object["issues"] as? [[String: Any]] {
            result.issues = issues.compactMap { item in
                guard let source = item["source"] as? String, !source.isEmpty,
                      let replacement = item["replacement"] as? String else { return nil }
                return CheckIssue(
                    type: item["type"] as? String ?? "expression",
                    source: source,
                    replacement: replacement,
                    reason: item["reason"] as? String ?? ""
                )
            }
        }
        return result
    }

    static func extractJSON(_ raw: String) -> String {
        var text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.hasPrefix("```") {
            if let firstNewline = text.firstIndex(of: "\n") {
                text = String(text[text.index(after: firstNewline)...])
            }
            if let fence = text.range(of: "```", options: .backwards) {
                text = String(text[..<fence.lowerBound])
            }
        }
        guard let start = text.firstIndex(of: "{"), let end = text.lastIndex(of: "}") else {
            return text
        }
        return String(text[start...end])
    }
}
