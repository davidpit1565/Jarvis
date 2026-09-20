export interface AutomationRuleRecord {
  id: string;
  /** 24-hour "HH:MM" in the configured JARVIS_TIMEZONE, e.g. "08:00". */
  timeOfDay: string;
  /** The instruction JARVIS runs on itself when this rule fires, e.g. "check the weather and tell me if I need an umbrella". */
  instruction: string;
  enabled: boolean;
  /** "YYYY-MM-DD" this rule last actually ran on, or null if it never has — prevents re-triggering within the same day. */
  lastTriggeredDate: string | null;
  createdAt: string;
}

export interface CreateAutomationRuleInput {
  timeOfDay: string;
  instruction: string;
}
