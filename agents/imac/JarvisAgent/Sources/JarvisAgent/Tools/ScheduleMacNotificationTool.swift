// REQUIRES REAL macOS VALIDATION — UserNotifications cannot be exercised
// outside a real macOS runtime. Never compiled or run in this
// environment. Extra uncertainty beyond the usual disclaimer:
// UNUserNotificationCenter is documented as requiring a proper app
// bundle/valid bundle identifier in some configurations — this process
// only has one via the same linker-embedded Info.plist trick
// WakeWordListener's mic/Speech permission prompts already rely on (see
// Package.swift). Whether TCC/UserNotifications accepts that the same
// way is genuinely unverified; if notifications silently fail to appear
// on a real Mac, this embedding approach (not the tool's own logic) is
// the first thing to check.
import Foundation
import UserNotifications

/// Posts a real macOS system notification — "pop up a reminder on my
/// screen" — either immediately or at a given future time via
/// UNTimeIntervalNotificationTrigger. Distinct from CREATE_ALARM
/// (Telegram, reaches the phone) and CREATE_WAKEUP_CALL (a real phone
/// call): this one is Mac-local only, for when the user is actually
/// sitting at the Mac.
enum ScheduleMacNotificationTool {
    private static let maxDelaySeconds: Double = 24 * 60 * 60 // 24 hours — a real scheduler (CREATE_ALARM) exists for daily recurrence; this is for a single near-term nudge.

    static func make() -> AgentTool {
        AgentTool(name: "schedule_mac_notification") { input in
            let title = (input["title"]?.value as? String) ?? "JARVIS"
            let body = (input["message"]?.value as? String) ?? ""
            guard !body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                return ToolResultPayload(success: false, data: nil, error: "message must be a non-empty string")
            }

            let delaySeconds = (input["delaySeconds"]?.value as? Double) ?? 0
            guard delaySeconds >= 0, delaySeconds <= maxDelaySeconds else {
                return ToolResultPayload(
                    success: false,
                    data: nil,
                    error: "delaySeconds must be between 0 and \(Int(maxDelaySeconds)) (use create_alarm for daily recurrence)"
                )
            }

            let center = UNUserNotificationCenter.current()
            let semaphore = DispatchSemaphore(value: 0)
            var authorized = false
            center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
                authorized = granted
                semaphore.signal()
            }
            _ = semaphore.wait(timeout: .now() + 10)

            guard authorized else {
                return ToolResultPayload(
                    success: false,
                    data: nil,
                    error: "Notification permission not granted — check System Settings > Notifications for this app"
                )
            }

            let content = UNMutableNotificationContent()
            content.title = title
            content.body = body
            content.sound = .default

            // A nil trigger fires as soon as the request is added — the
            // "immediately" case; UNTimeIntervalNotificationTrigger needs a
            // strictly positive interval, so 0 must map to nil rather than
            // being passed through directly.
            let trigger: UNTimeIntervalNotificationTrigger? =
                delaySeconds > 0 ? UNTimeIntervalNotificationTrigger(timeInterval: delaySeconds, repeats: false) : nil

            let requestId = UUID().uuidString
            let request = UNNotificationRequest(identifier: requestId, content: content, trigger: trigger)

            let addSemaphore = DispatchSemaphore(value: 0)
            var addError: Error?
            center.add(request) { error in
                addError = error
                addSemaphore.signal()
            }
            _ = addSemaphore.wait(timeout: .now() + 10)

            if let addError {
                return ToolResultPayload(success: false, data: nil, error: "Failed to schedule notification: \(addError.localizedDescription)")
            }

            let result: [String: AnyCodable] = [
                "id": AnyCodable(requestId),
                "delaySeconds": AnyCodable(delaySeconds),
            ]
            return ToolResultPayload(success: true, data: AnyCodable(result), error: nil)
        }
    }
}
