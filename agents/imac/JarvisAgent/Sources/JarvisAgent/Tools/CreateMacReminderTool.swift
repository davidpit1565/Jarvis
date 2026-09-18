// REQUIRES REAL macOS VALIDATION — EventKit cannot be exercised outside a
// real macOS runtime. Never compiled or run in this environment.

import EventKit
import Foundation

/// Creates a reminder in the macOS Reminders app's default list via
/// EventKit's public `EKEventStore` API — never AppleScript. Distinct
/// from JARVIS's own SQLite-backed ReminderStore (CREATE_REMINDER): this
/// writes into the real Reminders app so it also shows up in Siri/on
/// other synced devices.
enum CreateMacReminderTool {
    static func make() -> AgentTool {
        AgentTool(name: "create_mac_reminder") { input in
            guard let title = input["title"]?.value as? String, !title.trimmingCharacters(in: .whitespaces).isEmpty else {
                return ToolResultPayload(success: false, data: nil, error: "title is required")
            }

            return RemindersAccess.withAccess {
                guard let defaultList = RemindersAccess.store.defaultCalendarForNewReminders() else {
                    return ToolResultPayload(success: false, data: nil, error: "No default Reminders list is configured")
                }

                let reminder = EKReminder(eventStore: RemindersAccess.store)
                reminder.title = title
                reminder.calendar = defaultList

                if let dueAtString = input["dueAt"]?.value as? String,
                   let dueDate = ISO8601DateFormatter().date(from: dueAtString) {
                    reminder.dueDateComponents = Calendar.current.dateComponents(
                        [.year, .month, .day, .hour, .minute], from: dueDate
                    )
                }

                do {
                    try RemindersAccess.store.save(reminder, commit: true)
                    let result: [String: AnyCodable] = ["title": AnyCodable(title)]
                    return ToolResultPayload(success: true, data: AnyCodable(result), error: nil)
                } catch {
                    return ToolResultPayload(success: false, data: nil, error: "Failed to save reminder: \(error.localizedDescription)")
                }
            }
        }
    }
}
