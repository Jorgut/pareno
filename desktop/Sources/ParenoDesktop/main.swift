import Cocoa
import Foundation

enum CLIRunner {
    static func listModels() {
        let semaphore = DispatchSemaphore(value: 0)
        Task {
            do {
                let models = try await OllamaClient().models()
                print(models.joined(separator: "\n"))
            } catch {
                FileHandle.standardError.write(Data("error: \(error.localizedDescription)\n".utf8))
            }
            semaphore.signal()
        }
        semaphore.wait()
    }

    static func check(text: String, model: String?) {
        let semaphore = DispatchSemaphore(value: 0)
        Task {
            do {
                let client = OllamaClient()
                let available = try await client.models()
                let selected = model ?? available.first ?? ""
                guard !selected.isEmpty else { throw CheckError.noModel }
                let result = try await Checker.check(text: text, model: selected, client: client)
                print("model: \(selected)")
                print("issues: \(result.issues.count)")
                for issue in result.issues {
                    print("[\(issue.label)] \(issue.source) -> \(issue.replacement)")
                    if !issue.reason.isEmpty { print("  \(issue.reason)") }
                }
                print("minimal: \(result.minimal)")
                print("natural: \(result.natural)")
                if !result.explanation.isEmpty { print("note: \(result.explanation)") }
            } catch {
                FileHandle.standardError.write(Data("error: \(error.localizedDescription)\n".utf8))
                exit(1)
            }
            semaphore.signal()
            exit(0)
        }
        semaphore.wait()
    }
}

let arguments = Array(CommandLine.arguments.dropFirst())
if let index = arguments.firstIndex(of: "--check") {
    let text = arguments.dropFirst(index + 1).joined(separator: " ")
    CLIRunner.check(text: text, model: nil)
} else if arguments.contains("--models") {
    CLIRunner.listModels()
} else {
    MainActor.assumeIsolated {
        let application = NSApplication.shared
        let delegate = AppDelegate()
        application.delegate = delegate
        application.run()
    }
}
