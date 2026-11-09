// desktop-operator: macOS helper for `phm desktop`.
//
// AXUIElement reads first. CGWindow screenshots plus Vision OCR when the
// tree has no text. CGEvent posts keyboard and mouse. ScreenCaptureKit stays
// in desktop/src-tauri/src/computer.rs for the Verse window path.
//
// The TypeScript policy in src/core/desktop/operator-policy.ts is the source
// of truth. This process also refuses Messages, Keychain, Passwords,
// SecurityAgent and System Settings when invoked directly, and it never
// opens chat.db, keychain files or credential stores.
//
// Denied settings titles are kept in sync with COMPUTER_DENIED_SETTINGS_TITLES.
import AppKit
import ApplicationServices
import Darwin
import Foundation
import Vision

let binaryName = "desktop-operator"
let accessibilityPane = "System Settings > Privacy & Security > Accessibility"
let screenRecordingPane = "System Settings > Privacy & Security > Screen & System Audio Recording"
let accessibilityURL = "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
let screenRecordingURL = "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
let maxNodes = 500
let maxDepth = 12
let maxString = 200
let maxText = 8000
let maxType = 2000
let deniedSettingsTitles = [
    "Privacy & Security",
    "Privacy",
    "Security",
    "Passwords",
    "Touch ID & Password",
    "Users & Groups",
    "Login Items",
    "Login Items & Extensions",
]
let closedBundles = [
    "com.apple.MobileSMS",
    "com.apple.iChat",
    "com.apple.keychainaccess",
    "com.apple.Passwords",
    "com.apple.SecurityAgent",
    "com.apple.systempreferences",
    "com.apple.Settings",
]
// Exact bundle ids only. Phantom (ai.ashlr.desktop) is not writable.
let writableBundles = [
    "ai.cognition.devin",
    "com.cognition.devin",
    "com.openai.codex",
    "com.anthropic.claudefordesktop",
    "ai.x.grok",
    "com.xai.grok",
    "com.todesktop.230313mzl4w4u92",
]

func writable(_ bundle: String?) -> Bool {
    guard let bundle = bundle?.lowercased() else { return false }
    return writableBundles.contains { $0.lowercased() == bundle }
}

func requireWritable(_ app: NSRunningApplication) {
    if !writable(app.bundleIdentifier) {
        fail("denied", "Desktop writes are limited to Devin, Codex, Claude, Grok Bot and Cursor.")
    }
}

func requireFrontmost(_ app: NSRunningApplication) {
    if NSWorkspace.shared.frontmostApplication?.processIdentifier != app.processIdentifier {
        _ = app.activate(options: [.activateIgnoringOtherApps])
        usleep(150_000)
    }
    if NSWorkspace.shared.frontmostApplication?.processIdentifier != app.processIdentifier {
        fail("failed", "The target app is not frontmost, so no input was sent.")
    }
}

func emit(_ object: [String: Any]) -> Never {
    do {
        let data = try JSONSerialization.data(withJSONObject: object, options: [])
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([0x0A]))
    } catch {
        let fallback = Data("{\"ok\":false,\"code\":\"failed\",\"error\":\"could not encode helper JSON\"}\n".utf8)
        FileHandle.standardOutput.write(fallback)
    }
    exit(0)
}

func permission(_ kind: String) -> Never {
    let screen = kind == "screen_recording"
    emit([
        "ok": false,
        "code": "permission_required",
        "permission": kind,
        "pane": screen ? screenRecordingPane : accessibilityPane,
        "settingsUrl": screen ? screenRecordingURL : accessibilityURL,
        "binary": binaryName,
    ])
}

func fail(_ code: String, _ error: String) -> Never {
    emit(["ok": false, "code": code, "error": error, "binary": binaryName])
}

func accessibilityGranted(prompt: Bool) -> Bool {
    if !prompt { return AXIsProcessTrusted() }
    let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
    return AXIsProcessTrustedWithOptions([key: true] as CFDictionary)
}

func screenGranted(prompt: Bool) -> Bool {
    if CGPreflightScreenCaptureAccess() { return true }
    if prompt { _ = CGRequestScreenCaptureAccess() }
    return CGPreflightScreenCaptureAccess()
}

func forbidden(_ value: String?) -> Bool {
    guard let value else { return false }
    let lower = value.lowercased()
    if lower.contains("chat.db") || lower.contains("login.keychain") { return true }
    if lower.contains("/keychain") || lower.contains("library/messages") { return true }
    if lower.contains("cookies.binarycookies") { return true }
    return false
}

func bundleClosed(_ bundleId: String?) -> Bool {
    guard let bundleId else { return false }
    let lower = bundleId.lowercased()
    return closedBundles.contains { lower == $0.lowercased() }
}

func settingsTitle(_ title: String?) -> Bool {
    guard let title else { return false }
    let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    if trimmed.isEmpty { return false }
    return deniedSettingsTitles.contains { denied in
        let needle = denied.lowercased()
        return trimmed == needle || trimmed.hasPrefix(needle + " ")
    }
}

func runningApps() -> [NSRunningApplication] {
    NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }
}

func appRecord(_ app: NSRunningApplication) -> [String: Any] {
    var record: [String: Any] = [
        "name": app.localizedName ?? "App",
        "pid": Int(app.processIdentifier),
    ]
    if let bundle = app.bundleIdentifier { record["bundleId"] = bundle }
    if let path = app.executableURL?.path { record["executablePath"] = path }
    return record
}

func findApp(_ query: String) -> NSRunningApplication? {
    let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    return runningApps().first { app in
        app.bundleIdentifier?.lowercased() == needle || app.localizedName?.lowercased() == needle
    }
}

func windowList() -> [[String: Any]] {
    let options = CGWindowListOption(arrayLiteral: .optionOnScreenOnly, .excludeDesktopElements)
    return CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] ?? []
}

struct WindowRow {
    let app: String
    let bundleId: String?
    let title: String
    let windowId: Int
    let focused: Bool
    let pid: Int
}

func visibleWindows(appFilter: String?) -> [WindowRow] {
    let front = NSWorkspace.shared.frontmostApplication?.processIdentifier
    var rows: [WindowRow] = []
    var sawFront = false
    for info in windowList() {
        let layer = info[kCGWindowLayer as String] as? Int ?? 0
        if layer != 0 { continue }
        let pid = info[kCGWindowOwnerPID as String] as? Int ?? 0
        let owner = NSRunningApplication(processIdentifier: pid_t(pid))
        let name = owner?.localizedName ?? (info[kCGWindowOwnerName as String] as? String ?? "")
        let bundle = owner?.bundleIdentifier
        let title = info[kCGWindowName as String] as? String ?? ""
        if let appFilter {
            let needle = appFilter.lowercased()
            let matches = name.lowercased() == needle || bundle?.lowercased() == needle
            if !matches { continue }
        }
        let id = info[kCGWindowNumber as String] as? Int ?? 0
        let focused = !sawFront && front == pid_t(pid)
        if focused { sawFront = true }
        rows.append(WindowRow(app: name, bundleId: bundle, title: title, windowId: id, focused: focused, pid: pid))
    }
    return rows
}

func copyAttribute(_ element: AXUIElement, _ name: String) -> AnyObject? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
    return value
}

func stringAttribute(_ element: AXUIElement, _ name: String) -> String? {
    copyAttribute(element, name) as? String
}

func elements(_ value: AnyObject?) -> [AXUIElement] {
    guard let list = value as? [AXUIElement] else { return [] }
    return list
}

struct AxWalk {
    var parts: [String] = []
    var nodes = 0
    var truncated = false
    var secure = false
}

func walk(_ element: AXUIElement, depth: Int, into state: inout AxWalk) {
    if state.nodes >= maxNodes || depth > maxDepth {
        state.truncated = true
        return
    }
    state.nodes += 1
    let role = stringAttribute(element, kAXRoleAttribute as String) ?? ""
    if isSecure(element) {
        state.secure = true
        return
    }
    let label = stringAttribute(element, kAXTitleAttribute as String)
        ?? stringAttribute(element, kAXDescriptionAttribute as String)
        ?? ""
    let value = stringAttribute(element, kAXValueAttribute as String) ?? ""
    let line = [role, String(label.prefix(maxString)), String(value.prefix(maxString))]
        .filter { !$0.isEmpty }
        .joined(separator: " ")
    if !line.isEmpty { state.parts.append(line) }
    for child in elements(copyAttribute(element, kAXChildrenAttribute as String)) {
        walk(child, depth: depth + 1, into: &state)
    }
}

func axWindows(_ pid: pid_t) -> [AXUIElement] {
    elements(copyAttribute(AXUIElementCreateApplication(pid), kAXWindowsAttribute as String))
}

func readTree(pid: pid_t, title: String?) -> AxWalk {
    var state = AxWalk()
    let windows = axWindows(pid)
    let chosen = windows.filter { window in
        guard let title else { return true }
        return (stringAttribute(window, kAXTitleAttribute as String) ?? "") == title
    }
    for window in chosen {
        if settingsTitle(stringAttribute(window, kAXTitleAttribute as String)) {
            fail("denied", "System Settings privacy panes are closed to desktop control.")
        }
        walk(window, depth: 0, into: &state)
    }
    return state
}

func isSecure(_ element: AXUIElement) -> Bool {
    let role = (stringAttribute(element, kAXRoleAttribute as String) ?? "").lowercased()
    let subrole = (stringAttribute(element, kAXSubroleAttribute as String) ?? "").lowercased()
    for value in [role, subrole] where value.contains("secure") || value.contains("password") { return true }
    return false
}

func focusedIsSecure(_ pid: pid_t) -> Bool {
    guard let focused = copyAttribute(AXUIElementCreateApplication(pid), kAXFocusedUIElementAttribute as String),
          CFGetTypeID(focused) == AXUIElementGetTypeID() else { return true }
    return isSecure(focused as! AXUIElement)
}

func pointOverTarget(_ point: CGPoint, pid: pid_t) -> Bool {
    let options = CGWindowListOption(arrayLiteral: .optionOnScreenOnly, .excludeDesktopElements)
    let infos = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] ?? []
    for info in infos {
        let layer = info[kCGWindowLayer as String] as? Int ?? 0
        if layer != 0 { continue }
        // kCGWindowBounds is already a dictionary. Cast that value, do not rebuild [String: Double].
        guard let bounds = info[kCGWindowBounds as String] as? CFDictionary,
              let rect = CGRect(dictionaryRepresentation: bounds) else { continue }
        if !rect.contains(point) { continue }
        let owner = info[kCGWindowOwnerPID as String] as? Int ?? -1
        return owner == Int(pid)
    }
    return false
}

func postText(_ text: String) {
    let source = CGEventSource(stateID: .hidSystemState)
    let units = Array(text.utf16)
    var index = 0
    while index < units.count {
        let end = min(index + 20, units.count)
        var chunk = Array(units[index..<end])
        guard let down = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true),
              let up = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false) else { return }
        chunk.withUnsafeBufferPointer { buffer in
            guard let base = buffer.baseAddress else { return }
            down.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: base)
            up.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: base)
        }
        down.post(tap: .cghidEventTap)
        up.post(tap: .cghidEventTap)
        index = end
    }
}

func postClick(x: Double, y: Double) {
    let source = CGEventSource(stateID: .hidSystemState)
    let point = CGPoint(x: x, y: y)
    CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap)
    CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap)
}

func pressRef(pid: pid_t, ref: String) -> Bool {
    guard let number = Int(ref.dropFirst()), ref.hasPrefix("e") else { return false }
    var index = 0
    func visit(_ element: AXUIElement, depth: Int) -> Bool {
        if index >= maxNodes || depth > maxDepth { return false }
        index += 1
        if index == number {
            return AXUIElementPerformAction(element, kAXPressAction as CFString) == .success
        }
        for child in elements(copyAttribute(element, kAXChildrenAttribute as String)) {
            if visit(child, depth: depth + 1) { return true }
        }
        return false
    }
    for window in axWindows(pid) {
        if visit(window, depth: 0) { return true }
    }
    return false
}

func fitted(_ image: CGImage) -> CGImage {
    let maxWidth = 1280
    if image.width <= maxWidth { return image }
    let height = max(1, Int((Double(image.height) * Double(maxWidth) / Double(image.width)).rounded()))
    guard let context = CGContext(
        data: nil, width: maxWidth, height: height, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else { return image }
    context.interpolationQuality = .medium
    context.draw(image, in: CGRect(x: 0, y: 0, width: maxWidth, height: height))
    return context.makeImage() ?? image
}

func pngBase64(_ image: CGImage) -> String? {
    let data = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:])
    return data?.base64EncodedString()
}

func recognize(_ image: CGImage) -> String {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .fast
    let handler = VNImageRequestHandler(cgImage: image, options: [:])
    do { try handler.perform([request]) } catch { return "" }
    let lines = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }
    return String(lines.joined(separator: "\n").prefix(maxText))
}

func capture(windowId: Int) -> CGImage? {
    CGWindowListCreateImage(
        CGRect.null,
        .optionIncludingWindow,
        CGWindowID(windowId),
        [.boundsIgnoreFraming, .bestResolution]
    )
}

func requireApp(_ query: String) -> NSRunningApplication {
    if forbidden(query) { fail("forbidden_store", "Desktop operator does not read Messages, the keychain, or credential stores.") }
    guard let app = findApp(query) else { fail("not_running", "That app is not running.") }
    if bundleClosed(app.bundleIdentifier) { fail("denied", "That app is closed to desktop control.") }
    return app
}

func requireWindow(pid: pid_t, title: String?) -> WindowRow {
    if settingsTitle(title) { fail("denied", "System Settings privacy panes are closed to desktop control.") }
    let rows = visibleWindows(appFilter: nil).filter { $0.pid == Int(pid) }
    if let title {
        guard let row = rows.first(where: { $0.title == title }) else { fail("failed", "That window is not visible.") }
        return row
    }
    guard let row = rows.first else { fail("failed", "That app has no visible window.") }
    return row
}

let raw = FileHandle.standardInput.readDataToEndOfFile()
guard !raw.isEmpty, let json = try? JSONSerialization.jsonObject(with: raw) as? [String: Any], let op = json["op"] as? String else {
    fail("failed", "desktop-operator helper expects a JSON op")
}

let prompt = json["prompt"] as? Bool ?? false
let appName = json["app"] as? String
let windowTitle = json["window"] as? String
if forbidden(appName) || forbidden(windowTitle) {
    fail("forbidden_store", "Desktop operator does not read Messages, the keychain, or credential stores.")
}

switch op {
case "doctor":
    emit([
        "ok": true,
        "accessibility": accessibilityGranted(prompt: prompt),
        "screenRecording": screenGranted(prompt: prompt),
        "binary": binaryName,
    ])
case "list-apps":
    if !accessibilityGranted(prompt: false) { permission("accessibility") }
    emit(["ok": true, "apps": runningApps().map(appRecord)])
case "windows":
    if !accessibilityGranted(prompt: false) { permission("accessibility") }
    let rows = visibleWindows(appFilter: appName).filter { !bundleClosed($0.bundleId) && !settingsTitle($0.title) }
    emit(["ok": true, "windows": rows.map { row in
        var record: [String: Any] = [
            "app": row.app,
            "title": row.title,
            "windowId": row.windowId,
            "focused": row.focused,
            "pid": row.pid,
        ]
        if let bundle = row.bundleId { record["bundleId"] = bundle }
        return record
    }])
case "read":
    if !accessibilityGranted(prompt: false) { permission("accessibility") }
    guard let name = appName else { fail("failed", "app is required") }
    let app = requireApp(name)
    let tree = readTree(pid: app.processIdentifier, title: windowTitle)
    if tree.secure && tree.parts.isEmpty { fail("secure_field", "Secure text fields are not read.") }
    var text = tree.parts.joined(separator: "\n")
    var source = "ax"
    if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        if !screenGranted(prompt: false) { permission("screen_recording") }
        let row = requireWindow(pid: app.processIdentifier, title: windowTitle)
        if let image = capture(windowId: row.windowId) {
            text = recognize(fitted(image))
            source = "ocr"
        }
    }
    emit([
        "ok": true,
        "source": source,
        "text": String(text.prefix(maxText)),
        "truncated": tree.truncated || text.count > maxText,
        "nodes": tree.nodes,
    ])
case "focus":
    if !accessibilityGranted(prompt: false) { permission("accessibility") }
    guard let name = appName else { fail("failed", "app is required") }
    let app = requireApp(name)
    requireWritable(app)
    if !app.activate(options: [.activateIgnoringOtherApps]) { fail("failed", "The app did not take focus.") }
    if let windowTitle {
        for window in axWindows(app.processIdentifier) where stringAttribute(window, kAXTitleAttribute as String) == windowTitle {
            _ = AXUIElementPerformAction(window, kAXRaiseAction as CFString)
        }
    }
    emit(["ok": true, "focused": true])
case "scroll":
    if !accessibilityGranted(prompt: false) { permission("accessibility") }
    guard let name = appName else { fail("failed", "app is required") }
    let app = requireApp(name)
    requireWritable(app)
    requireFrontmost(app)
    let dy = json["dy"] as? Int ?? -3
    let dx = json["dx"] as? Int ?? 0
    let source = CGEventSource(stateID: .hidSystemState)
    CGEvent(scrollWheelEvent2Source: source, units: .line, wheelCount: 2, wheel1: Int32(dy), wheel2: Int32(dx), wheel3: 0)?
        .post(tap: .cghidEventTap)
    emit(["ok": true, "scrolled": true])
case "type":
    if !accessibilityGranted(prompt: false) { permission("accessibility") }
    guard let name = appName else { fail("failed", "app is required") }
    guard let text = json["text"] as? String, !text.isEmpty, text.count <= maxType else { fail("failed", "text must be 1 to 2000 characters") }
    let app = requireApp(name)
    requireWritable(app)
    requireFrontmost(app)
    if focusedIsSecure(app.processIdentifier) { fail("secure_field", "Secure text fields are not typed into.") }
    postText(text)
    emit(["ok": true, "typed": text.count])
case "click":
    if !accessibilityGranted(prompt: false) { permission("accessibility") }
    guard let name = appName else { fail("failed", "app is required") }
    let app = requireApp(name)
    requireWritable(app)
    requireFrontmost(app)
    if let ref = json["ref"] as? String, !ref.isEmpty {
        if !pressRef(pid: app.processIdentifier, ref: ref) { fail("failed", "That accessibility ref was not pressed.") }
        emit(["ok": true, "clicked": true])
    }
    guard let x = json["x"] as? Double ?? (json["x"] as? Int).map(Double.init),
          let y = json["y"] as? Double ?? (json["y"] as? Int).map(Double.init) else {
        fail("failed", "click needs a ref or both x and y")
    }
    if !pointOverTarget(CGPoint(x: x, y: y), pid: app.processIdentifier) {
        fail("denied", "That point is not over the target app's window.")
    }
    postClick(x: x, y: y)
    emit(["ok": true, "clicked": true])
case "screenshot":
    if !accessibilityGranted(prompt: false) { permission("accessibility") }
    if !screenGranted(prompt: false) { permission("screen_recording") }
    guard let name = appName else { fail("failed", "app is required") }
    let app = requireApp(name)
    let row = requireWindow(pid: app.processIdentifier, title: windowTitle)
    guard let image = capture(windowId: row.windowId) else { permission("screen_recording") }
    let scaled = fitted(image)
    guard let encoded = pngBase64(scaled), encoded.count <= 1_500_000 else { fail("failed", "screenshot exceeded the response cap") }
    emit([
        "ok": true,
        "mime": "image/png",
        "base64": encoded,
        "width": scaled.width,
        "height": scaled.height,
        "ocrText": recognize(scaled),
    ])
default:
    fail("failed", "unknown desktop-operator op")
}
