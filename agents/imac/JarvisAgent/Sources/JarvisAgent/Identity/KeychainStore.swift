// Verified against a real Keychain (2026-09-18): saveCredential() failed
// with errSecMissingEntitlement (-34018) — kSecUseDataProtectionKeychain
// requires the keychain-access-groups entitlement, which an unsigned/
// ad-hoc `swift build` executable does not have and cannot get without a
// paid Apple Developer code-signing identity. Removed; the legacy
// file-based keychain API (no kSecUseDataProtectionKeychain) needs no
// such entitlement for a plain kSecClassGenericPassword item and is what
// this now uses.
//
// Separately, still-open field risk: macOS scopes Keychain item access
// partly by the calling binary's code signature — an ad-hoc signature is
// derived from the binary's own hash, so a `swift build` that changes the
// binary can look like a *different* application to the Keychain, unable
// to read items an earlier build saved. Only a stable Developer ID
// signature fixes that; out of scope here. Real error logging (below)
// stays in place so that, if it happens, it's diagnosable rather than a
// silent "hasCredential=false".

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
        ]
        let status = SecItemDelete(query as CFDictionary)
        return status == errSecSuccess || status == errSecItemNotFound
    }

    private static func secStatusMessage(_ status: OSStatus) -> String {
        SecCopyErrorMessageString(status, nil) as String? ?? "unknown error"
    }
}
