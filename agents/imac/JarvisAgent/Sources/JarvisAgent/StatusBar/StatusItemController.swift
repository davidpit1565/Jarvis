// REQUIRES REAL macOS VALIDATION — AppKit UI cannot be exercised outside a
// real macOS runtime. Never compiled or run in this environment.

import AppKit

enum ConnectionStatus {
    case connected
    case reconnecting
    case offline

    var label: String {
        switch self {
        case .connected: return "● Connected"
        case .reconnecting: return "● Reconnecting"
        case .offline: return "● Offline"
        }
    }
}

/// Minimal menu bar surface: a status item showing connection state and a
/// small menu (pair/re-pair, pause, quit). No Dock icon — the app runs as
/// an `LSUIElement` (see Info.plist / launchd notes in Resources/).
final class StatusItemController {
    private let statusItem: NSStatusItem
    private let menu = NSMenu()
    var onPairRequested: (() -> Void)?
    var onPauseToggled: ((Bool) -> Void)?
    var onQuitRequested: (() -> Void)?

    private var isPaused = false

    init() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        statusItem.button?.title = "JARVIS"
        buildMenu()
        statusItem.menu = menu
        update(status: .offline)
    }

    func update(status: ConnectionStatus, deviceName: String? = nil) {
        let title = deviceName.map { "JARVIS — \($0)" } ?? "JARVIS"
        statusItem.button?.title = title
        menu.item(withTag: MenuTag.status.rawValue)?.title = status.label
    }

    private enum MenuTag: Int {
        case status = 1
        case pair = 2
        case pause = 3
        case quit = 4
    }

    private func buildMenu() {
        let statusEntry = NSMenuItem(title: ConnectionStatus.offline.label, action: nil, keyEquivalent: "")
        statusEntry.tag = MenuTag.status.rawValue
        statusEntry.isEnabled = false
        menu.addItem(statusEntry)

        menu.addItem(NSMenuItem.separator())

        let pairEntry = NSMenuItem(title: "Pair / Re-pair…", action: #selector(pairTapped), keyEquivalent: "")
        pairEntry.tag = MenuTag.pair.rawValue
        pairEntry.target = self
        menu.addItem(pairEntry)

        let pauseEntry = NSMenuItem(title: "Pause Agent", action: #selector(pauseTapped), keyEquivalent: "")
        pauseEntry.tag = MenuTag.pause.rawValue
        pauseEntry.target = self
        menu.addItem(pauseEntry)

        menu.addItem(NSMenuItem.separator())

        let quitEntry = NSMenuItem(title: "Quit JARVIS Agent", action: #selector(quitTapped), keyEquivalent: "q")
        quitEntry.tag = MenuTag.quit.rawValue
        quitEntry.target = self
        menu.addItem(quitEntry)
    }

    @objc private func pairTapped() {
        onPairRequested?()
    }

    @objc private func pauseTapped() {
        isPaused.toggle()
        menu.item(withTag: MenuTag.pause.rawValue)?.title = isPaused ? "Resume Agent" : "Pause Agent"
        onPauseToggled?(isPaused)
    }

    @objc private func quitTapped() {
        onQuitRequested?()
    }
}
