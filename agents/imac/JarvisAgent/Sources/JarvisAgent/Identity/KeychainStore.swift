// REQUIRES REAL macOS VALIDATION — Keychain APIs cannot be exercised in
// this Linux/Claude Code environment. This file is source only; it has
// never been built or run against a real Keychain.
//
// KNOWN ISSUE observed in the field: a saved credential sometimes failed
// to load on a later run (hasCredential=false despite a prior successful
// save). The most likely cause: this binary is built with `swift build`
// and run unsigned/ad-hoc, not as a properly code-signed app. macOS scopes
// Keychain item access partly by the calling binary's code signature —
// an ad-hoc signature is derived from the binary's own hash, so every
// `swift build` that changes the binary can make it look like a *different*
// application to the Keychain, unable to read items an earlier build saved.
// The real fix is proper code signing with a stable Developer ID (requires
// the user's own paid Apple Developer account — out of scope here). Until
// then, this file adds two things that are in scope: (1) real error
// logging instead of silently swallowing the OSStatus, so this is
// diagnosable on the real machine, and (2) kSecUseDataProtectionKeychain,
// Apple's modern recommended flag for consistent behavior across the
// legacy file-based keychain and the data-protection keychain.

import Foundation
import Security

/// Stores the long-lived pairing credential Core issues after a human
/// approves this device's pairing code. Never written to disk, UserDefaults,
/// logs, or source — only the macOS Keychain.
enum KeychainStore {
    private static let service = "com.jarvis.agent.credential"
    private static let account = "core-pairing-credential"

    static func saveCredential(_ secret: String) -> Bool {
        guard let data = secret.data(using: .utf8) else { return false }

        // Remove any existing entry first so this is a clean upsert.
        _ = deleteCredential()

        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecValueData as String: data,
            kSecUseDataProtectionKeychain as String: true,
            // Only this device, only while unlocked at least once since boot —
            // never synced to iCloud Keychain, since this credential is
            // specific to this one Mac's pairing with Core.
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]

        let status = SecItemAdd(query as CFDictionary, nil)
        if status != errSecSuccess {
            Logger.shared.error("Keychain save failed with OSStatus \(status): \(secStatusMessage(status))")
        }
        return status == errSecSuccess
    }

    static func loadCredential() -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecUseDataProtectionKeychain as String: true,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]

        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)

        if status != errSecSuccess {
            if status != errSecItemNotFound {
                // errSecItemNotFound just means "never paired yet" — not an
                // error worth logging. Anything else (e.g. an access/ACL
                // failure from a changed code signature) is worth surfacing.
                Logger.shared.error("Keychain load failed with OSStatus \(status): \(secStatusMessage(status))")
                print("[JarvisAgent] Keychain load failed (OSStatus \(status)) — will re-pair.")
            }
            return nil
        }

        guard let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    @discardableResult
    static func deleteCredential() -> Bool {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecUseDataProtectionKeychain as String: true,
        ]
        let status = SecItemDelete(query as CFDictionary)
        return status == errSecSuccess || status == errSecItemNotFound
    }

    private static func secStatusMessage(_ status: OSStatus) -> String {
        SecCopyErrorMessageString(status, nil) as String? ?? "unknown error"
    }
}
