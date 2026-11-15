import Cocoa
import ApplicationServices

enum SelectionService {
    static var isTrusted: Bool { AXIsProcessTrusted() }

    static func requestTrust() {
        let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
        let options = [key: true] as CFDictionary
        AXIsProcessTrustedWithOptions(options)
    }

    static func openAccessibilitySettings() {
        let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")!
        NSWorkspace.shared.open(url)
    }

    static func focusedElement() -> AXUIElement? {
        let system = AXUIElementCreateSystemWide()
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(system, kAXFocusedUIElementAttribute as CFString, &value) == .success,
              let element = value else { return nil }
        return (element as! AXUIElement)
    }

    static func selectedText(from element: AXUIElement? = nil) -> String? {
        guard let element = element ?? focusedElement() else { return nil }
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXSelectedTextAttribute as CFString, &value) == .success else { return nil }
        return value as? String
    }

    static func setSelectedText(_ text: String, on element: AXUIElement) -> Bool {
        AXUIElementSetAttributeValue(element, kAXSelectedTextAttribute as CFString, text as CFTypeRef) == .success
    }

    static func caretRect() -> NSRect? {
        guard let element = focusedElement() else { return nil }
        var rangeRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, &rangeRef) == .success,
              let rangeRef else { return nil }
        var selectedRange = CFRange(location: 0, length: 0)
        AXValueGetValue(rangeRef as! AXValue, .cfRange, &selectedRange)
        var queryRange = selectedRange
        if queryRange.length == 0 {
            var valueRef: CFTypeRef?
            let length = (AXUIElementCopyAttributeValue(element, kAXValueAttribute as CFString, &valueRef) == .success)
                ? ((valueRef as? String)?.utf16.count ?? 0) : 0
            if queryRange.location < length {
                queryRange.length = 1
            } else if queryRange.location > 0 {
                queryRange.location -= 1
                queryRange.length = 1
            }
        }
        var range = queryRange
        guard let expandedRef = AXValueCreate(.cfRange, &range) else { return nil }
        var boundsRef: CFTypeRef?
        guard AXUIElementCopyParameterizedAttributeValue(element, kAXBoundsForRangeParameterizedAttribute as CFString, expandedRef, &boundsRef) == .success,
              let boundsRef else { return nil }
        var rect = CGRect.zero
        guard AXValueGetValue(boundsRef as! AXValue, .cgRect, &rect), rect.width >= 0, rect.height > 0 else { return nil }
        let screenHeight = NSScreen.screens.first?.frame.height ?? 0
        return NSRect(x: rect.origin.x, y: screenHeight - rect.maxY, width: max(rect.width, 2), height: rect.height)
    }

    static func textInputFrame() -> NSRect? {
        guard let element = focusedElement() else { return nil }
        var positionRef: CFTypeRef?
        var sizeRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &positionRef) == .success,
              AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &sizeRef) == .success,
              let positionRef, let sizeRef else { return nil }
        var point = CGPoint.zero
        var size = CGSize.zero
        guard AXValueGetValue(positionRef as! AXValue, .cgPoint, &point),
              AXValueGetValue(sizeRef as! AXValue, .cgSize, &size),
              size.width > 20, size.height > 10 else { return nil }
        let screenHeight = NSScreen.screens.first?.frame.height ?? 0
        return NSRect(x: point.x, y: screenHeight - point.y - size.height, width: size.width, height: size.height)
    }

    static func focusedHasSelectionRange() -> Bool {
        guard let element = focusedElement() else { return false }
        var value: CFTypeRef?
        return AXUIElementCopyAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, &value) == .success
    }

    static func currentParagraph() -> (text: String, element: AXUIElement)? {
        guard let element = focusedElement() else { return nil }
        if let selected = selectedText(from: element)?.trimmingCharacters(in: .whitespacesAndNewlines), !selected.isEmpty {
            return (selected, element)
        }
        var valueRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXValueAttribute as CFString, &valueRef) == .success,
              let value = valueRef as? String, !value.isEmpty else { return nil }
        var rangeRef: CFTypeRef?
        var location = value.utf16.count
        if AXUIElementCopyAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, &rangeRef) == .success,
           let rangeRef {
            var range = CFRange(location: 0, length: 0)
            if AXValueGetValue(rangeRef as! AXValue, .cfRange, &range) {
                location = min(max(0, range.location), value.utf16.count)
            }
        }
        let ns = value as NSString
        let previous = ns.range(of: "\n\n", options: .backwards, range: NSRange(location: 0, length: location))
        let start = previous.location == NSNotFound ? 0 : previous.location + previous.length
        let next = ns.range(of: "\n\n", options: [], range: NSRange(location: location, length: ns.length - location))
        let end = next.location == NSNotFound ? ns.length : next.location
        guard end > start else { return nil }
        let text = ns.substring(with: NSRange(location: start, length: end - start)).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        return (String(text.prefix(1500)), element)
    }

    static func copySelectionViaKeyboard() -> String? {
        let pasteboard = NSPasteboard.general
        let previousItems = pasteboard.pasteboardItems
        let previousCount = pasteboard.changeCount
        guard let source = CGEventSource(stateID: .combinedSessionState) else { return nil }
        let down = CGEvent(keyboardEventSource: source, virtualKey: 8, keyDown: true)
        let up = CGEvent(keyboardEventSource: source, virtualKey: 8, keyDown: false)
        down?.flags = .maskCommand
        up?.flags = .maskCommand
        down?.post(tap: .cghidEventTap)
        up?.post(tap: .cghidEventTap)
        usleep(160_000)
        let changed = pasteboard.changeCount != previousCount
        let copied = changed ? pasteboard.string(forType: .string)?.trimmingCharacters(in: .whitespacesAndNewlines) : nil
        if changed, let previousItems {
            pasteboard.clearContents()
            pasteboard.writeObjects(previousItems)
        }
        return (copied?.isEmpty == false) ? copied : nil
    }

    static func paste(_ text: String) {
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        pasteboard.setString(text, forType: .string)
        guard let source = CGEventSource(stateID: .combinedSessionState) else { return }
        let down = CGEvent(keyboardEventSource: source, virtualKey: 9, keyDown: true)
        let up = CGEvent(keyboardEventSource: source, virtualKey: 9, keyDown: false)
        down?.flags = .maskCommand
        up?.flags = .maskCommand
        down?.post(tap: .cghidEventTap)
        up?.post(tap: .cghidEventTap)
    }
}
