// NEVER COMPILED OR RUN — no Xcode/iOS toolchain in this sandbox.
//
// Deliberately simpler than the Mac agent's KeychainStore.swift, and that
// simplicity is a real, reasoned difference, not an oversight: the Mac
// agent's extensive doc comment about errSecMissingEntitlement and
// ad-hoc-signature code-identity churn is specific to a *raw `swift build`
// executable* with no App Store/Developer-ID signing identity. A real iOS
// app built and run through Xcode is always provisioned and signed (even
// under a free personal-team "Automatic signing" profile) before it can
// run on a device or simulator at all, so it doesn't hit either problem:
// kSecUseDataProtectionKeychain's entitlement requirement is a macOS-only
// concern (iOS has exactly one Keychain, already "data protection" by
// default — there is no legacy-vs-data-protection choice to make on iOS),
// and TCC/Keychain ACL scoping by a rebuild's changing ad-hoc code hash is
// also a macOS-unsigned-executable-specific failure mode. This is reasoned
// from how iOS code signing and Keychain access groups work, not verified
// against a real device in this sandbox — if an iOS build does ever hit an
// unexpected Keychain error, check the provisioning profile/entitlements
// first, not this file's logic.
import Foundation
import Security

/// Stores the long-lived pairing credential Core issues after a human
/// approves this device's pairing code. Never written to disk,
/// UserDefaults, logs, or source — only the iOS Keychain.
enum KeychainStore {
    private static let service = "com.jarvis.app.credential"
    private static let account = "core-pairing-credential"

    static func saveCredential(_ secret: String) -> Bool {
        guard let data = secret.data(using: .utf8) else { return false }

        _ = deleteCredential()

        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecValueData as String: data,
            // Only this device, only while unlocked at least once since
            // boot, never synced to iCloud Keychain — this credential is
            // specific to this one iPhone's pairing with this one Core.
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]

        let status = SecItemAdd(query as CFDictionary, nil)
        if status != errSecSuccess {
            Logger.error("Keychain save failed with OSStatus \(status): \(secStatusMessage(status))")
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
                Logger.error("Keychain load failed with OSStatus \(status): \(secStatusMessage(status))")
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
