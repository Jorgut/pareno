import Foundation

enum CheckError: LocalizedError {
    case ollama(String)
    case decoding(String)
    case noModel

    var errorDescription: String? {
        switch self {
        case .ollama(let message): return message
        case .decoding(let message): return "无法解析模型返回：\(message)"
        case .noModel: return "本机 Ollama 还没有安装模型，请先运行 ollama pull qwen2.5:7b。"
        }
    }
}

struct ChatMessage: Codable {
    let role: String
    let content: String
}

struct OllamaClient {
    let baseURL: URL

    init(baseURL: URL? = nil) {
        if let baseURL {
            self.baseURL = baseURL
        } else if let override = ProcessInfo.processInfo.environment["WRITECHECK_OLLAMA"], let url = URL(string: override) {
            self.baseURL = url
        } else {
            self.baseURL = URL(string: "http://localhost:11434")!
        }
    }

    func models() async throws -> [String] {
        var request = URLRequest(url: baseURL.appendingPathComponent("api/tags"))
        request.timeoutInterval = 5
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse else { throw CheckError.ollama("Ollama 没有响应。") }
            guard (200..<300).contains(http.statusCode) else {
                throw CheckError.ollama("Ollama 返回 \(http.statusCode)。请确认 Ollama 已启动。")
            }
            struct Tags: Decodable {
                struct Model: Decodable { let name: String }
                let models: [Model]
            }
            return try JSONDecoder().decode(Tags.self, from: data).models.map(\.name)
        } catch let error as CheckError {
            throw error
        } catch {
            throw CheckError.ollama("连接本机 Ollama 失败：\(error.localizedDescription)")
        }
    }

    func chat(model: String, messages: [ChatMessage]) async throws -> String {
        var request = URLRequest(url: baseURL.appendingPathComponent("api/chat"))
        request.httpMethod = "POST"
        request.timeoutInterval = 150
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        struct Options: Encodable { let temperature: Double }
        struct Body: Encodable {
            let model: String
            let messages: [ChatMessage]
            let stream: Bool
            let format: String
            let options: Options
            let think: Bool?
        }
        let body = Body(model: model, messages: messages, stream: false, format: "json", options: Options(temperature: 0.2), think: false)
        request.httpBody = try JSONEncoder().encode(body)
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse else { throw CheckError.ollama("Ollama 没有响应。") }
            struct Response: Decodable {
                struct Message: Decodable { let content: String }
                let message: Message?
                let error: String?
            }
            let decoded = try JSONDecoder().decode(Response.self, from: data)
            if let error = decoded.error { throw CheckError.ollama(error) }
            guard (200..<300).contains(http.statusCode), let message = decoded.message else {
                throw CheckError.ollama("Ollama 返回 \(http.statusCode)。模型 \(model) 可能不可用。")
            }
            return message.content
        } catch let error as CheckError {
            throw error
        } catch {
            throw CheckError.ollama("调用 Ollama 失败：\(error.localizedDescription)")
        }
    }
}
