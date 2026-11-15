import Foundation

enum AgentKind: String, CaseIterable {
    case claude
    case codex
    case cursor
    case opencode

    var label: String {
        switch self {
        case .claude: return "Claude Code"
        case .codex: return "Codex CLI"
        case .cursor: return "Cursor Agent"
        case .opencode: return "OpenCode"
        }
    }

    var executable: String {
        switch self {
        case .claude: return "claude"
        case .codex: return "codex"
        case .cursor: return "cursor-agent"
        case .opencode: return "opencode"
        }
    }
}

struct AgentStatus: Identifiable {
    let kind: AgentKind
    let path: String
    let version: String
    let ready: Bool

    var id: String { kind.rawValue }
    var label: String { kind.label }
    var detail: String {
        if ready { return version.isEmpty ? path : version }
        return path.isEmpty ? L10n.t("agents.missing") : L10n.t("agents.error")
    }
}

enum AgentDetector {
    private static let searchDirectories: [String] = {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        var directories = (ProcessInfo.processInfo.environment["PATH"] ?? "")
            .split(separator: ":")
            .map(String.init)
        for directory in [
            "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin",
            "\(home)/.local/bin", "\(home)/.bun/bin", "\(home)/.npm-global/bin", "\(home)/.cargo/bin"
        ] where !directories.contains(directory) {
            directories.append(directory)
        }
        return directories
    }()

    static func locate(_ executable: String) -> String? {
        for directory in searchDirectories {
            let candidate = directory + "/" + executable
            if FileManager.default.isExecutableFile(atPath: candidate) {
                return candidate
            }
        }
        return nil
    }

    static func scan() -> [AgentStatus] {
        AgentKind.allCases.map { kind in
            guard let path = locate(kind.executable) else {
                return AgentStatus(kind: kind, path: "", version: "", ready: false)
            }
            let version = (try? runVersion(path)) ?? ""
            return AgentStatus(kind: kind, path: path, version: version, ready: true)
        }
    }

    private static func runVersion(_ path: String) throws -> String {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: path)
        process.arguments = ["--version"]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = Pipe()
        try process.run()
        let deadline = Date().addingTimeInterval(2)
        while process.isRunning && Date() < deadline {
            usleep(100_000)
        }
        if process.isRunning {
            process.terminate()
            return ""
        }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        let text = String(data: data, encoding: .utf8) ?? ""
        return text.split(separator: "\n").first.map(String.init)?.trimmingCharacters(in: .whitespaces) ?? ""
    }
}

enum AIProvider: String, CaseIterable {
    case auto
    case claude
    case codex
    case cursor
    case opencode
    case ollama
    case ollamaCloud

    var label: String {
        switch self {
        case .auto: return L10n.t("provider.auto")
        case .claude: return AgentKind.claude.label
        case .codex: return AgentKind.codex.label
        case .cursor: return AgentKind.cursor.label
        case .opencode: return AgentKind.opencode.label
        case .ollama: return "Ollama"
        case .ollamaCloud: return "Ollama Cloud"
        }
    }

    var agent: AgentKind? {
        switch self {
        case .claude: return .claude
        case .codex: return .codex
        case .cursor: return .cursor
        case .opencode: return .opencode
        default: return nil
        }
    }
}

enum AgentClient {
    static func complete(kind: AgentKind, system: String, user: String, timeout: TimeInterval = 120) async throws -> String {
        let prompt = "SYSTEM:\n\(system)\n\nUSER:\n\(user)"
        return try await Task.detached(priority: .userInitiated) {
            try run(kind: kind, prompt: prompt, timeout: timeout)
        }.value
    }

    private static func run(kind: AgentKind, prompt: String, timeout: TimeInterval) throws -> String {
        guard let path = AgentDetector.locate(kind.executable) else {
            throw CheckError.ollama(L10n.t("agents.error"))
        }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: path)
        let stdin = Pipe()
        let stdout = Pipe()
        let stderr = Pipe()
        process.standardInput = stdin
        process.standardOutput = stdout
        process.standardError = stderr

        switch kind {
        case .claude:
            process.arguments = ["-p", "--output-format", "json", "--tools", ""]
        case .codex:
            process.arguments = [
                "exec", "--json", "--ephemeral", "--ignore-user-config", "--ignore-rules",
                "--skip-git-repo-check", "--sandbox", "read-only", "--disable", "shell_tool",
                "-c", "model_reasoning_effort=\"low\"", "-c", "project_doc_max_bytes=0",
                "-c", "web_search=\"disabled\"", "-"
            ]
        case .cursor:
            process.arguments = ["-p", "--output-format", "json", "--mode", "ask", "--trust", prompt]
        case .opencode:
            process.arguments = ["run", "--format", "json", "--pure", prompt]
        }

        try process.run()
        if process.standardInput is Pipe {
            stdin.fileHandleForWriting.write(Data(prompt.utf8))
            try? stdin.fileHandleForWriting.close()
        }

        let deadline = Date().addingTimeInterval(timeout)
        while process.isRunning && Date() < deadline {
            usleep(100_000)
        }
        if process.isRunning {
            process.terminate()
            throw CheckError.ollama(L10n.t("agents.timeout"))
        }

        let outData = stdout.fileHandleForReading.readDataToEndOfFile()
        let errData = stderr.fileHandleForReading.readDataToEndOfFile()
        let output = String(data: outData, encoding: .utf8) ?? ""
        let errorOutput = String(data: errData, encoding: .utf8) ?? ""
        guard process.terminationStatus == 0 else {
            let detail = errorOutput.isEmpty ? output : errorOutput
            throw CheckError.ollama(detail.trimmingCharacters(in: .whitespacesAndNewlines).prefix(300).description)
        }
        return try parse(kind: kind, output: output)
    }

    private static func parse(kind: AgentKind, output: String) throws -> String {
        switch kind {
        case .claude:
            guard let object = jsonObject(output),
                  let result = object["result"] as? String, !result.isEmpty else {
                throw CheckError.decoding(String(output.prefix(200)))
            }
            return result
        case .cursor:
            guard let object = jsonObject(output) else {
                throw CheckError.decoding(String(output.prefix(200)))
            }
            for key in ["result", "text", "message"] {
                if let value = object[key] as? String, !value.isEmpty { return value }
            }
            throw CheckError.decoding(String(output.prefix(200)))
        case .opencode:
            var parts: [String] = []
            for line in output.split(separator: "\n") {
                guard let data = line.data(using: .utf8),
                      let event = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
                if event["type"] as? String == "text", let text = event["text"] as? String {
                    parts.append(text)
                } else if let part = event["part"] as? [String: Any],
                          part["type"] as? String == "text",
                          let text = part["text"] as? String {
                    parts.append(text)
                }
            }
            let joined = parts.joined().trimmingCharacters(in: .whitespacesAndNewlines)
            guard !joined.isEmpty else { throw CheckError.decoding(String(output.prefix(200))) }
            return joined
        case .codex:
            var messages: [String] = []
            var completed = false
            for line in output.split(separator: "\n") {
                guard let data = line.data(using: .utf8),
                      let event = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
                let type = event["type"] as? String ?? ""
                if type == "turn.failed" || type == "error" {
                    throw CheckError.ollama(L10n.t("agents.error"))
                }
                if type == "turn.completed" { completed = true }
                if type == "item.completed",
                   let item = event["item"] as? [String: Any],
                   item["type"] as? String == "agent_message",
                   let text = item["text"] as? String {
                    messages.append(text)
                }
            }
            guard completed, !messages.isEmpty else {
                throw CheckError.decoding(String(output.prefix(200)))
            }
            return messages.joined(separator: "\n")
        }
    }

    private static func jsonObject(_ output: String) -> [String: Any]? {
        let trimmed = output.trimmingCharacters(in: .whitespacesAndNewlines)
        if let data = trimmed.data(using: .utf8),
           let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            return object
        }
        for line in trimmed.split(separator: "\n").reversed() {
            if let data = line.data(using: .utf8),
               let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                return object
            }
        }
        return nil
    }
}
