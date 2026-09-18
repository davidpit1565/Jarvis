// REQUIRES REAL macOS VALIDATION — EventKit cannot be exercised outside a
// real macOS runtime. Never compiled or run in this environment.

import EventKit

/// Lists incomplete reminders from the macOS Reminders app via EventKit's
/// public `EKEventStore` API — never AppleScript's `tell application
/// "Reminders"`. Distinct from JARVIS's own SQLite-backed ReminderStore
/// (LIST_REMINDERS): this reads the reminders already in the user's real
/// Reminders app, the ones Siri/other apps also see. READ: purely
/// informational, no side effects.
enum ListMacRemindersTool {
    static func make() -> AgentTool {
        AgentTool(name: "list_mac_reminders") { _ in
            RemindersAccess.withAccess {
                let predicate = RemindersAccess.store.predicateForIncompleteReminders(
                    withDueDateStarting: nil, ending: nil, calendars: nil
                )

                let semaphore = DispatchSemaphore(value: 0)
                var fetched: [EKReminder] = []
                RemindersAccess.store.fetchReminders(matching: predicate) { reminders in
                    fetched = reminders ?? []
                    semaphore.signal()
                }
                semaphore.wait()

                let items: [AnyCodable] = fetched.map { reminder in
                    var entry: [String: AnyCodable] = [
                        "title": AnyCodable(reminder.title ?? ""),
                        "list": AnyCodable(reminder.calendar?.title ?? ""),
                    ]
                    if let dueDate = reminder.dueDateComponents?.date {
                        entry["dueAt"] = AnyCodable(ISO8601DateFormatter().string(from: dueDate))
                    }
                    return AnyCodable(entry)
                }

                let result: [String: AnyCodable] = ["reminders": AnyCodable(items)]
                return ToolResultPayload(success: true, data: AnyCodable(result), error: nil)
            }
        }
    }
}
