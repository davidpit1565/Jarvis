// REQUIRES REAL macOS VALIDATION — EventKit cannot be exercised outside a
// real macOS runtime. Never compiled or run in this environment.

import EventKit

/// Marks a reminder in the macOS Reminders app complete, found by an
/// exact (case-insensitive) title match among incomplete reminders — same
/// "fail on zero or multiple matches rather than guessing" discipline as
/// ClickElementTool, since there's no reminder ID shared with Core to
/// address one unambiguously.
enum CompleteMacReminderTool {
    static func make() -> AgentTool {
        AgentTool(name: "complete_mac_reminder") { input in
            guard let title = input["title"]?.value as? String, !title.trimmingCharacters(in: .whitespaces).isEmpty else {
                return ToolResultPayload(success: false, data: nil, error: "title is required")
            }

            return RemindersAccess.withAccess {
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

                let matches = fetched.filter { ($0.title ?? "").caseInsensitiveCompare(title) == .orderedSame }

                if matches.isEmpty {
                    return ToolResultPayload(success: false, data: nil, error: "No incomplete reminder titled '\(title)' was found")
                }
                if matches.count > 1 {
                    return ToolResultPayload(success: false, data: nil, error: "Multiple reminders are titled '\(title)' — be more specific")
                }

                let reminder = matches[0]
                reminder.isCompleted = true
                do {
                    try RemindersAccess.store.save(reminder, commit: true)
                    let result: [String: AnyCodable] = ["title": AnyCodable(title)]
                    return ToolResultPayload(success: true, data: AnyCodable(result), error: nil)
                } catch {
                    return ToolResultPayload(success: false, data: nil, error: "Failed to complete reminder: \(error.localizedDescription)")
                }
            }
        }
    }
}
