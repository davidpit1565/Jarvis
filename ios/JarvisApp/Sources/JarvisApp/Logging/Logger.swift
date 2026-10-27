// NEVER COMPILED OR RUN — no Xcode/iOS toolchain in this sandbox. Written
// carefully against real, current Foundation/os.log API names; validate on
// a real device/simulator before trusting it.

import Foundation
import os.log

/// Thin `os.log` wrapper, mirroring `agents/imac/JarvisAgent`'s own
/// `Logging/Logger.swift` — never logs credentials, never logs raw camera
/// frames or transcript content beyond what's already printed to the
/// console elsewhere in this app for diagnostics.
enum Logger {
    private static let log = OSLog(subsystem: "com.jarvis.ios", category: "JarvisApp")

    static func log(_ message: String) {
        os_log("%{public}@", log: log, type: .default, message)
    }

    static func error(_ message: String) {
        os_log("%{public}@", log: log, type: .error, message)
    }
}
