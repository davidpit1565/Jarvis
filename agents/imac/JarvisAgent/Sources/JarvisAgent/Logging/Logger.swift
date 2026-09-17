// REQUIRES REAL macOS VALIDATION — OSLog behavior cannot be exercised here.

import Foundation
import os.log

/// Thin OSLog wrapper. Never pass a credential, pairing secret, or tool
/// input/output that might contain sensitive data to `log()` — log only
/// operational/status information.
final class Logger {
    static let shared = Logger()

    private let osLog = OSLog(subsystem: "com.jarvis.agent", category: "general")

    private init() {}

    func log(_ message: String) {
        os_log("%{public}@", log: osLog, type: .info, message)
    }

    func error(_ message: String) {
        os_log("%{public}@", log: osLog, type: .error, message)
    }
}
