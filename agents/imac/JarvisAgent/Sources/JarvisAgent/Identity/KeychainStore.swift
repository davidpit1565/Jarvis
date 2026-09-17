// REQUIRES REAL macOS VALIDATION — Keychain APIs cannot be exercised in
// this Linux/Claude Code environment. This file is source only; it has
// never been built or run against a real Keychain.

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

        guard status == errSecSuccess, let data = result as? Data else { return nil }
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
}
