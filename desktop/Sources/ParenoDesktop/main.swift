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

func runSelfTest() {
    var failures = 0
    func expect(_ condition: Bool, _ name: String) {
        print((condition ? "PASS " : "FAIL ") + name)
        if !condition { failures += 1 }
    }
    let json = #"{"language":"en","issues":[{"type":"grammar","source":"I very like","replacement":"I really like","reason":"副词不能修饰动词"}],"minimal":"I really like it.","natural":"I really like it.","explanation":"ok"}"#
    let decoded = try? Checker.decode(json, original: "I very like it.")
    expect(decoded?.issues.count == 1, "decode issue count")
    expect(decoded?.issues.first?.label == "语法", "issue label")
    expect(decoded?.minimal == "I really like it.", "minimal text")
    let fenced = "```json\n" + json + "\n```"
    expect((try? Checker.decode(fenced, original: ""))?.issues.count == 1, "fenced json")
    let explain = #"{"why":"very 不能直接修饰动词","better":"I really like it.","example":"She really likes it."}"#
    let explained = try? Checker.decode(explain, original: "I very like it.")
    expect(explained?.why.isEmpty == false, "explain why")
    expect(explained?.example.isEmpty == false, "explain example")
    expect((try? Checker.decode("not json", original: "x")) == nil, "invalid json rejected")
    print(failures == 0 ? "SELFTEST PASS" : "SELFTEST FAIL")
    exit(failures == 0 ? 0 : 1)
}

let arguments = Array(CommandLine.arguments.dropFirst())
if arguments.contains("--selftest") { runSelfTest() }
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
