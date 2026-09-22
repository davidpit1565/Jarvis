export interface JarvisConfig {
  /** "anthropic" (default) or "groq" — which Brain implementation src/index.ts constructs. */
  brainProvider: "anthropic" | "groq";
  /**
   * True only when JARVIS_BRAIN_PROVIDER was actually set in the
   * environment (as opposed to defaulting to "anthropic" because it was
   * unset). AIRouter uses this to distinguish "I explicitly want this
   * provider" from "no preference stated" — an explicit choice is never
   * overridden by AI_FREE_FIRST, only used for fallback/failure recovery,
   * so someone who already has JARVIS_BRAIN_PROVIDER set sees zero
   * behavior change.
   */
  brainProviderExplicit: boolean;
  /** Required when brainProvider is "anthropic"; optional (but usable as an AIRouter fallback/secondary) otherwise. */
  anthropicApiKey?: string;
  /** Required when brainProvider is "groq"; optional (but usable as an AIRouter fallback/secondary) otherwise. */
  groqApiKey?: string;
  /** Groq model id; unset uses GroqBrain's own default (a real tool-calling-capable free-tier model). */
  groqModel?: string;
  /**
   * Optional OpenRouter API key — when set, AIProviderRegistry registers
   * an `OpenRouterBrain` as another free-tier provider alongside Groq.
   * Wholly optional: unset means OpenRouter is simply unavailable, same
   * as any other unconfigured provider, never a crash and never a silent
   * fallback to a paid one.
   */
  openrouterApiKey?: string;
  /**
   * OpenRouter model id; unset uses OpenRouterBrain's own default. Must
   * carry OpenRouter's ":free" suffix — OpenRouterBrain refuses to
   * construct with anything else (see its own doc comment for why).
   */
  openrouterModel?: string;
  /**
   * Enables Anthropic prompt caching (`cache_control: ephemeral`) on the
   * system prompt and tool definitions ClaudeBrain sends. A pure cost
   * optimization with no behavior change, so it defaults to on; set
   * JARVIS_PROMPT_CACHING=false only to rule it out while debugging a
   * cost/usage discrepancy. See ClaudeBrainOptions.promptCachingEnabled.
   */
  promptCachingEnabled: boolean;
  /**
   * Whether AIRouter should prefer a free-tier provider (currently: Groq)
   * over a paid one when no explicit JARVIS_BRAIN_PROVIDER is set and
   * more than one provider is configured. Defaults to true — "free
   * first" is the whole point of the router existing. Ignored entirely
   * when brainProviderExplicit is true.
   */
  aiFreeFirst: boolean;
  /**
   * Optional explicit fallback provider AIRouter switches to when the
   * primary provider's call fails (network error, 5xx, rate limit).
   * Unset means AIRouter still falls back to whichever *other* provider
   * happens to be configured, if any — this only lets you pin exactly
   * which one.
   */
  aiFallbackProvider?: "anthropic" | "groq";
  /** Optional daily USD cap on paid-provider spend (estimated); unset means unlimited. See CostTracker. */
  maxDailyCostUsd?: number;
  /** Optional monthly USD cap on paid-provider spend (estimated); unset means unlimited. See CostTracker. */
  maxMonthlyCostUsd?: number;
  /**
   * Denial-of-wallet protection: optional hard USD ceiling on estimated
   * paid-provider spend within a single run (one `handleUserMessage` turn
   * or one `AgentCore` task). Once reached, further paid-provider calls
   * *for that same run* fall back to a free provider (or fail clearly if
   * none is configured) — independent of and stricter-scoped than
   * `maxDailyCostUsd`/`maxMonthlyCostUsd`, which only bound spend in
   * aggregate. Unset means unlimited (today's behavior). See
   * `AIRouter.maxCostPerRunUsd`/`RunBudgetExceededError`.
   */
  maxCostPerRunUsd?: number;
  /**
   * Hard zero-cost boundary: when true, AIRouter never calls a paid
   * provider under any circumstance (not even as a fallback when the
   * free provider fails) — it throws `ZeroCostModeError` instead. This
   * is independent of, and stricter than, `maxDailyCostUsd`/
   * `maxMonthlyCostUsd`, which bound paid usage rather than forbid it
   * outright. Defaults to false.
   */
  zeroCostMode: boolean;
  /**
   * Budget-constrained degradation: once today's or this month's spend
   * reaches this fraction of `maxDailyCostUsd`/`maxMonthlyCostUsd` (e.g.
   * 0.8 = 80%), AIRouter proactively biases toward a free provider even
   * though the hard cap hasn't been hit yet — a soft nudge, not a new hard
   * boundary (see `AIRouterOptions.softBudgetCapRatio`). Defaults to 0.8;
   * a value >= 1 disables the feature (routing only reacts at the hard
   * cap, today's original behavior). Ignored entirely when neither cost
   * cap is configured.
   */
  softBudgetCapRatio: number;
  /** Consecutive call failures before AIRouter's per-provider circuit breaker opens (stops routing to it) for `aiCircuitBreakerCooldownMs`. Defaults to 3. */
  aiCircuitBreakerThreshold: number;
  /** How long (ms) an open provider circuit stays open before a single half-open trial call is let through. Defaults to 60000 (60s). */
  aiCircuitBreakerCooldownMs: number;
  /** Path to the SQLite database storing AIRouter's per-call estimated-cost records (CostTracker). */
  aiCostDbPath: string;
  /**
   * TTL (ms) for the in-memory READ-tool result cache (ToolResultCache) —
   * how long an identical READ-tool call's result is served from cache
   * instead of re-running the tool (e.g. a repeated GET_WEATHER for the
   * same location). 0 disables the cache entirely (every call always
   * re-runs the tool, today's behavior). Defaults to 60000 (60s): long
   * enough to dedupe a burst of near-identical questions in one
   * conversation, short enough that stale data is never surfaced for long.
   */
  toolResultCacheTtlMs: number;
  port: number;
  memoryDbPath: string;
  /** Path to the SQLite database storing registered Face ID/Touch ID (WebAuthn) credentials. */
  webauthnDbPath: string;
  /** Path to the SQLite database storing reminders/tasks. */
  remindersDbPath: string;
  /** Path to the SQLite database storing proactive automation rules (JARVIS acting on its own by a schedule). */
  automationRulesDbPath: string;
  /** Path to the SQLite database storing a durable record of automation rule executions that threw (see AutomationFailureStore). */
  automationFailuresDbPath: string;
  /**
   * Path to the SQLite database backing the dashboard's activity log, so
   * recent activity survives a restart/redeploy instead of resetting to
   * "Nothing yet." every time.
   */
  activityLogDbPath: string;
  /** Path to the SQLite database storing the full conversation transcript, for SEARCH_CONVERSATION_HISTORY. */
  conversationHistoryDbPath: string;
  /** Path to the SQLite database storing paired-device credentials, so devices don't need to re-pair after every restart. */
  pairingDbPath: string;
  /** Path to the SQLite database storing device identity/role, so a device doesn't lose its role after every restart. */
  deviceRegistryDbPath: string;
  /** Path to the SQLite database storing the structured tool-execution audit trail. */
  toolAuditLogDbPath: string;
  /** Path to the SQLite database storing per-call token usage, for real cost visibility. */
  tokenUsageDbPath: string;
  /** Path to the SQLite database storing Autonomous Agent Core task state (src/agent/AgentTaskStore.ts) — roadmap items 26-34. */
  agentTaskDbPath: string;
  /** How often (ms) the background agent queue worker's `AgentCore.runQueueTick` fires — roadmap item 33. */
  agentQueueTickMs: number;
  /**
   * IANA timezone (e.g. "Asia/Jerusalem") used to tell Claude the user's
   * local time every turn, so relative times ("tomorrow at 9am") resolve
   * correctly. Defaults to UTC — set this to your actual timezone.
   */
  timezone: string;
  /** Both must be set together to enable the optional Twilio phone gateway. */
  twilioAuthToken?: string;
  /**
   * The exact public base URL Twilio is configured to call (e.g. an ngrok
   * URL). Required for signature verification: a reverse-proxied request's
   * `req.url` as seen by this process reflects the internal address, not
   * the public one Twilio actually signed.
   */
  twilioPublicBaseUrl?: string;
  /** E.164 numbers allowed to call JARVIS; empty/unset disables the gateway unless twilioAllowOpenAccess is set. */
  twilioAllowedCallers?: string[];
  /**
   * Explicit opt-in to run the phone gateway with no caller allowlist at
   * all — required now that an empty twilioAllowedCallers refuses to
   * start the gateway rather than silently letting any caller through.
   */
  twilioAllowOpenAccess: boolean;
  /**
   * Twilio Account SID, the Twilio phone number to call FROM, and the
   * owner's own phone number to call — all three required together to
   * enable outbound calls (currently: scheduled wake-up calls). Distinct
   * from the inbound phone gateway's config above: a Twilio account can
   * receive calls without ever placing one, so this is opt-in on top of
   * that, not implied by it.
   */
  twilioAccountSid?: string;
  twilioFromNumber?: string;
  ownerPhoneNumber?: string;
  /**
   * How many outbound Twilio calls (currently: scheduled wake-up calls)
   * JARVIS will place per day, at most — Twilio bills per call, and
   * unlike every AI-provider call (gated by CostTracker's daily/monthly
   * $ budget), nothing previously stopped a misconfigured wake-up call
   * rule (or many of them) from placing an unbounded number of real,
   * billed calls. Defaults to 10 — generous for a genuinely daily wake-up
   * call plus some headroom, but nowhere near "unbounded."
   */
  maxOutboundCallsPerDay: number;
  /** Path to the SQLite database storing recurring wake-up/scheduled-call times. */
  wakeUpCallDbPath: string;
  /** Path to the SQLite database storing recurring alarms (Telegram-notification, not a phone call). */
  alarmDbPath: string;
  /** Twilio <Say> voice name (e.g. "Polly.Matthew"); unset uses the gateway's own default. */
  twilioVoice?: string;
  /**
   * Twilio <Say> voice for Hebrew replies (e.g. "Google.he-IL-Standard-D") —
   * separate from twilioVoice because Amazon Polly has no Hebrew voice at
   * all, so Hebrew always goes through Twilio's Google TTS integration.
   * Unset uses the gateway's own default.
   */
  twilioVoiceHebrew?: string;
  /**
   * Language Twilio's <Gather> should recognize speech in. Unset uses the
   * gateway's own default ("multi" — real automatic Hebrew/English
   * detection via Twilio's deepgram_nova-3 speech model). Set this to a
   * single BCP-47 code (e.g. "he-IL" or "en-US") only if that model isn't
   * available on the Twilio account this runs on.
   */
  twilioGatherLanguage?: string;
  /**
   * SSML `<prosody pitch>`/`<prosody rate>` applied to every spoken line,
   * for JARVIS's deliberately deep, machine-sounding phone voice (not a
   * human, not "cute") — see TwilioVoiceGateway's DEFAULT_VOICE comment.
   * Unset uses the gateway's own defaults.
   */
  twilioVoicePitch?: string;
  twilioVoiceRate?: string;
  /**
   * Bot token (from @BotFather) and webhook secret required together to
   * enable the optional Telegram gateway — a scoped alternative to "give
   * JARVIS access to all my Telegram messages": the user adds this
   * specific bot to specific chats, and JARVIS only ever sees messages
   * sent to it there, never anything else on the account.
   */
  telegramBotToken?: string;
  /** Verifies incoming webhook requests actually came from Telegram (the `X-Telegram-Bot-Api-Secret-Token` header Telegram echoes back, set via setWebhook's own `secret_token` field). */
  telegramWebhookSecret?: string;
  /** Numeric Telegram chat IDs allowed to talk to the bot; empty/unset disables the gateway unless telegramAllowOpenAccess is set. */
  telegramAllowedChatIds?: string[];
  /**
   * Explicit opt-in to run the Telegram gateway with no chat allowlist at
   * all — required now that an empty telegramAllowedChatIds refuses to
   * start the gateway rather than silently letting any chat through.
   */
  telegramAllowOpenAccess: boolean;
  /**
   * The owner's own Telegram chat ID — required for NOTIFY_USER to have
   * somewhere to push a proactive message to. Distinct from
   * telegramAllowedChatIds (which chats may talk *to* JARVIS): this is
   * specifically where JARVIS talks *first*, unprompted.
   */
  telegramOwnerChatId?: string;
  /**
   * Both required together to enable GET_WEATHER — a real, free (Open-Meteo,
   * no API key) current-weather lookup for one fixed location, since a
   * personal assistant only ever needs to know the weather where its one
   * user actually is.
   */
  weatherLatitude?: number;
  weatherLongitude?: number;
  /** Enables GET_NEWS — free RSS headlines from this one configured feed. Unset means the tool doesn't exist. */
  newsRssUrl?: string;
  /**
   * Both required together to enable the weekly usage/cost digest, pushed
   * via NOTIFY_USER's own Telegram delivery (so it also needs
   * telegramGateway + telegramOwnerChatId configured). Day 0=Sunday..6=Saturday.
   */
  weeklyDigestDayOfWeek?: number;
  weeklyDigestTime?: string;
  /**
   * Hours of no interaction (any channel) before JARVIS sends a wellness
   * check-in via NOTIFY_USER's own Telegram delivery — also needs
   * telegramGateway + telegramOwnerChatId configured. Unset disables the
   * feature entirely.
   */
  checkinAfterHours?: number;
  /**
   * "HH:MM" local time (in `timezone`) JARVIS sends a daily morning
   * briefing — weather + today's calendar + due/overdue reminders — via
   * NOTIFY_USER's own Telegram delivery (also needs telegramGateway +
   * telegramOwnerChatId configured). Unset disables the feature entirely.
   */
  morningBriefingTime?: string;
  /**
   * Optional all-time estimated-cost threshold (USD). When set, JARVIS
   * warns (console + activity log) once cumulative estimated spend
   * crosses 75%, 90%, and 100% of it — each stage fires once, not on
   * every call past it. All-time, not daily/monthly, since
   * TokenUsageStore only tracks a running total; a real budget period
   * would need time-windowed queries this doesn't have yet.
   */
  costAlertThresholdUsd?: number;
  /**
   * Shared secret required on POST /pairing/approve. Mandatory once the
   * phone gateway is configured, since that makes this same server
   * reachable from the public internet — without it, the pairing code
   * alone (handed back to whoever requested it) is enough to self-approve
   * a fake device. Optional for purely local development.
   */
  adminToken?: string;
  /**
   * Enables Anthropic's own server-side web_search tool — real internet
   * search billed through the same Anthropic account, no separate vendor.
   * Off by default: it changes what JARVIS can see and costs extra per
   * search, so it's an explicit opt-in.
   */
  webSearchEnabled: boolean;
  /** Caps how many searches Claude may run in a single turn. */
  webSearchMaxUses: number;
  /**
   * Enables Anthropic's own server-side web_fetch tool — lets Claude
   * actually read a specific URL's content, not just a search snippet.
   * Same account/billing as web_search. Off by default, same reasoning.
   */
  webFetchEnabled: boolean;
  /** Caps how many URL fetches Claude may run in a single turn. */
  webFetchMaxUses: number;
  /**
   * Enables live phone-call audio waveform visualization on the
   * dashboard, via Twilio Media Streams. Only meaningful when the phone
   * gateway is also configured. Off by default: Twilio bills Media
   * Streams at ~$0.004/min on top of normal call minutes — a real,
   * if small, extra cost, so this is never silently turned on.
   */
  audioWaveformEnabled: boolean;
  /**
   * Overrides the Anthropic API base URL — explicit opt-in only, for
   * pointing JARVIS's brain at a local Anthropic-compatible model gateway
   * instead of Anthropic's own metered API, for cost reasons. Unset (the
   * default) means the real Anthropic API, always; this is never picked
   * up from the ambient ANTHROPIC_BASE_URL environment variable that other
   * tools on the same machine might set, only from this JARVIS-specific
   * variable, so JARVIS never silently starts talking to some unrelated
   * local proxy just because it happened to be running.
   */
  anthropicBaseUrl?: string;
  /**
   * A cheaper/different model to retry against, once, when the primary
   * model call fails with a 429/503/529 even after the SDK's own
   * automatic retries — a degraded reply beats no reply during a
   * provider outage or rate-limit spike. Opt-in only; unset means never
   * fall back.
   */
  fallbackModel?: string;
  /**
   * The public base URL this server is reachable at — used for the Google
   * Calendar OAuth redirect URI. Distinct from twilioPublicBaseUrl: a
   * user might want calendar integration without the phone gateway (or
   * vice versa), so this isn't implied by/tied to Twilio's own config,
   * even though in practice they're often the same URL.
   */
  publicBaseUrl?: string;
  /** Google OAuth client credentials — both required together to enable Calendar integration. */
  googleClientId?: string;
  googleClientSecret?: string;
  /** Path to the SQLite database storing the linked Google account's OAuth tokens. */
  calendarTokenDbPath: string;
  /** Spotify OAuth client credentials — both required together to enable Spotify integration. */
  spotifyClientId?: string;
  spotifyClientSecret?: string;
  /** Path to the SQLite database storing the linked Spotify account's OAuth tokens. */
  spotifyTokenDbPath: string;
  /** Both required together to enable the video studio integration (reels list, publish, Instagram stats). */
  studioBaseUrl?: string;
  studioSecret?: string;
  /** Path to the SQLite database storing tracked commitments/promises (CommitmentStore). */
  commitmentsDbPath: string;
  /**
   * How many days an open commitment can go without being fulfilled
   * before the follow-up engine marks it "stale" (see getStaleCommitments/
   * CommitmentStore.markStale) and it starts surfacing as proactive
   * context. Defaults to 3.
   */
  staleCommitmentDays: number;
  /**
   * Both optional, but meant to be set together: "HH:MM" 24-hour local
   * bounds (in `timezone`) during which non-urgent proactive
   * notifications (reminder due-notifications, automation-rule result
   * pushes, the morning briefing) are suppressed and queued to fire once
   * the window ends, instead of interrupting the user overnight. An
   * overnight window (start > end, e.g. "22:00"-"07:00") is supported and
   * expected. Time-critical channels — alarms and scheduled wake-up
   * calls, which fire at a time the user explicitly set for that exact
   * purpose — deliberately do NOT check this at all (see index.ts): quiet
   * hours is an opt-out per notification type, not a blanket "no
   * notifications" switch. Unset (either or both) disables quiet hours
   * entirely.
   */
  quietHoursStart?: string;
  quietHoursEnd?: string;
  /**
   * Tool Risk Model: hard cap on how many tool calls a single Orchestrator
   * turn will actually execute — see Orchestrator's own
   * `maxToolCallsPerRun` doc comment for why this exists. Defaults to 30.
   */
  maxToolCallsPerRun: number;
  /**
   * Tool Risk Model: default timeout (ms) for a local tool's `execute()`
   * call before Orchestrator aborts it instead of waiting forever. 0
   * disables timeout enforcement. Defaults to 30000 (30s).
   */
  localToolTimeoutMs: number;
  /**
   * Both required together to enable the AgentMail integration
   * (https://docs.agentmail.to) — JARVIS's own independent email inbox
   * (e.g. jarvis@agentmail.to), completely separate from the user's
   * personal Gmail account (GmailClient/SEND_EMAIL). The inbox itself is
   * created once by the user in AgentMail's own dashboard/API; JARVIS only
   * ever operates the one inbox id given here, never creates or lists
   * inboxes on its own. Unset means the feature simply doesn't register —
   * no crash, no warning spam, just one informative log line when it IS
   * configured (see src/index.ts).
   */
  agentMailApiKey?: string;
  agentMailInboxId?: string;
  /**
   * Hard daily cap on real sends via SEND_AGENT_EMAIL — mirrors
   * maxOutboundCallsPerDay's reasoning for Twilio: nothing else stops a
   * misconfigured automation rule (or a runaway agent loop) from sending
   * an unbounded number of real emails under JARVIS's own identity in a
   * day. Defaults to 20.
   */
  agentMailMaxSendsPerDay: number;
  /**
   * Base URL of a locally-run Ollama server (https://ollama.com) — used
   * for genuinely free, local embeddings (see OllamaEmbeddingsClient).
   * Named to match the env var a concurrently-developed Ollama chat
   * provider (OllamaBrain) also reads, so both features share one Ollama
   * server config rather than each inventing its own. Defaults to
   * Ollama's own standard local address; only meaningful once
   * `ollamaEmbeddingModel` is also set.
   */
  ollamaBaseUrl: string;
  /**
   * Enables the entire Semantic Memory Search / Semantic Result Cache
   * layer (JARVIS_ROADMAP_AUDIT.md #60, previously skipped for lack of a
   * free embeddings source) — unset (the default) means every existing
   * exact-match code path (MemoryStore.search LIKE matching,
   * ToolResultCache's exact-match cache) runs completely unchanged, with
   * zero dependency on Ollama being installed or running at all. Set to
   * an embedding model actually pulled into Ollama (e.g.
   * "nomic-embed-text" — run `ollama pull nomic-embed-text` first) to opt
   * in. See README's "Semantic memory & caching (optional, local-only)"
   * section for what this unlocks and what stays exact-match-only.
   */
  ollamaEmbeddingModel?: string;
}

class ConfigError extends Error {}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new ConfigError(`Missing required environment variable: ${name}`);
  }
  return value;
}

/**
 * Loads and validates configuration from environment variables.
 * Never logs the actual values of secrets.
 */
export function loadConfig(): JarvisConfig {
  // "anthropic" (default, unchanged) or "groq" — a genuine $0 option
  // (Groq's free tier: no credit card, real tool-calling support) added
  // on explicit request. Only ANTHROPIC_API_KEY OR GROQ_API_KEY is
  // required, never both — a Groq-only setup never needs an Anthropic
  // account at all, which is the whole point of it being genuinely free.
  const brainProviderRaw = process.env.JARVIS_BRAIN_PROVIDER?.trim().toLowerCase() || "anthropic";
  if (brainProviderRaw !== "anthropic" && brainProviderRaw !== "groq") {
    throw new ConfigError(`Invalid JARVIS_BRAIN_PROVIDER: "${brainProviderRaw}" — must be "anthropic" or "groq"`);
  }
  const brainProvider = brainProviderRaw as "anthropic" | "groq";
  const brainProviderExplicit = Boolean(process.env.JARVIS_BRAIN_PROVIDER?.trim());
  // Both keys are read unconditionally now (rather than the previous
  // all-or-nothing "only the selected provider's key exists at all") so
  // AIRouter can register whichever providers are actually configured,
  // regardless of which one JARVIS_BRAIN_PROVIDER names — a Groq-primary
  // setup can still carry an Anthropic key as its fallback, and vice
  // versa. The provider named by brainProvider is still the one that MUST
  // be present, exactly as before.
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY?.trim() || undefined;
  const groqApiKey = process.env.GROQ_API_KEY?.trim() || undefined;
  if (brainProvider === "anthropic" && !anthropicApiKey) {
    throw new ConfigError("Missing required environment variable: ANTHROPIC_API_KEY");
  }
  if (brainProvider === "groq" && !groqApiKey) {
    throw new ConfigError("Missing required environment variable: GROQ_API_KEY");
  }
  if (!anthropicApiKey && !groqApiKey) {
    throw new ConfigError(
      "No AI provider is configured — set ANTHROPIC_API_KEY and/or GROQ_API_KEY so AIRouter has at least one Brain to use."
    );
  }
  const groqModel = process.env.JARVIS_GROQ_MODEL?.trim() || undefined;
  const openrouterApiKey = process.env.OPENROUTER_API_KEY?.trim() || undefined;
  const openrouterModel = process.env.JARVIS_OPENROUTER_MODEL?.trim() || undefined;

  const promptCachingRaw = process.env.JARVIS_PROMPT_CACHING?.trim().toLowerCase();
  const promptCachingEnabled = promptCachingRaw === undefined || promptCachingRaw === "" ? true : promptCachingRaw === "true";

  const aiFreeFirstRaw = process.env.AI_FREE_FIRST?.trim().toLowerCase();
  const aiFreeFirst = aiFreeFirstRaw === undefined || aiFreeFirstRaw === "" ? true : aiFreeFirstRaw === "true";

  const aiFallbackProviderRaw = process.env.AI_FALLBACK_PROVIDER?.trim().toLowerCase() || undefined;
  if (aiFallbackProviderRaw && aiFallbackProviderRaw !== "anthropic" && aiFallbackProviderRaw !== "groq") {
    throw new ConfigError(`Invalid AI_FALLBACK_PROVIDER: "${aiFallbackProviderRaw}" — must be "anthropic" or "groq"`);
  }
  const aiFallbackProvider = aiFallbackProviderRaw as "anthropic" | "groq" | undefined;

  const maxDailyCostUsdRaw = process.env.MAX_DAILY_COST_USD?.trim();
  const maxDailyCostUsd = maxDailyCostUsdRaw ? Number(maxDailyCostUsdRaw) : undefined;
  if (maxDailyCostUsdRaw && (Number.isNaN(maxDailyCostUsd) || maxDailyCostUsd! <= 0)) {
    throw new ConfigError("Invalid MAX_DAILY_COST_USD: must be a positive number");
  }

  const maxMonthlyCostUsdRaw = process.env.MAX_MONTHLY_COST_USD?.trim();
  const maxMonthlyCostUsd = maxMonthlyCostUsdRaw ? Number(maxMonthlyCostUsdRaw) : undefined;
  if (maxMonthlyCostUsdRaw && (Number.isNaN(maxMonthlyCostUsd) || maxMonthlyCostUsd! <= 0)) {
    throw new ConfigError("Invalid MAX_MONTHLY_COST_USD: must be a positive number");
  }

  const zeroCostModeRaw = process.env.ZERO_COST_MODE?.trim().toLowerCase();
  const zeroCostMode = zeroCostModeRaw === "true";

  const maxCostPerRunUsdRaw = process.env.JARVIS_MAX_COST_PER_RUN_USD?.trim();
  const maxCostPerRunUsd = maxCostPerRunUsdRaw ? Number(maxCostPerRunUsdRaw) : undefined;
  if (maxCostPerRunUsdRaw && (Number.isNaN(maxCostPerRunUsd) || maxCostPerRunUsd! <= 0)) {
    throw new ConfigError("Invalid JARVIS_MAX_COST_PER_RUN_USD: must be a positive number");
  }

  const softBudgetCapRatioRaw = process.env.JARVIS_SOFT_BUDGET_CAP_RATIO?.trim();
  const softBudgetCapRatio = softBudgetCapRatioRaw !== undefined && softBudgetCapRatioRaw !== "" ? Number(softBudgetCapRatioRaw) : 0.8;
  if (softBudgetCapRatioRaw && (Number.isNaN(softBudgetCapRatio) || softBudgetCapRatio < 0)) {
    throw new ConfigError("Invalid JARVIS_SOFT_BUDGET_CAP_RATIO: must be a non-negative number (>= 1 disables the feature)");
  }

  const aiCircuitBreakerThresholdRaw = process.env.AI_CIRCUIT_BREAKER_THRESHOLD?.trim();
  const aiCircuitBreakerThreshold = aiCircuitBreakerThresholdRaw ? Number(aiCircuitBreakerThresholdRaw) : 3;
  if (
    aiCircuitBreakerThresholdRaw &&
    (!Number.isInteger(aiCircuitBreakerThreshold) || aiCircuitBreakerThreshold <= 0)
  ) {
    throw new ConfigError("Invalid AI_CIRCUIT_BREAKER_THRESHOLD: must be a positive integer");
  }

  const aiCircuitBreakerCooldownMsRaw = process.env.AI_CIRCUIT_BREAKER_COOLDOWN_MS?.trim();
  const aiCircuitBreakerCooldownMs = aiCircuitBreakerCooldownMsRaw ? Number(aiCircuitBreakerCooldownMsRaw) : 60_000;
  if (
    aiCircuitBreakerCooldownMsRaw &&
    (!Number.isInteger(aiCircuitBreakerCooldownMs) || aiCircuitBreakerCooldownMs <= 0)
  ) {
    throw new ConfigError("Invalid AI_CIRCUIT_BREAKER_COOLDOWN_MS: must be a positive integer");
  }

  const aiCostDbPath = process.env.JARVIS_AI_COST_DB_PATH ?? "./data/jarvis-ai-cost.sqlite";
  const toolResultCacheTtlMsRaw = process.env.JARVIS_TOOL_RESULT_CACHE_TTL_MS?.trim();
  const toolResultCacheTtlMs = toolResultCacheTtlMsRaw !== undefined && toolResultCacheTtlMsRaw !== "" ? Number(toolResultCacheTtlMsRaw) : 60_000;
  if (toolResultCacheTtlMsRaw && (!Number.isInteger(toolResultCacheTtlMs) || toolResultCacheTtlMs < 0)) {
    throw new ConfigError("Invalid JARVIS_TOOL_RESULT_CACHE_TTL_MS: must be a non-negative integer");
  }
  const port = Number(process.env.JARVIS_PORT ?? "4770");
  const memoryDbPath = process.env.JARVIS_MEMORY_DB_PATH ?? "./data/jarvis-memory.sqlite";
  const webauthnDbPath = process.env.JARVIS_WEBAUTHN_DB_PATH ?? "./data/jarvis-webauthn.sqlite";
  const remindersDbPath = process.env.JARVIS_REMINDERS_DB_PATH ?? "./data/jarvis-reminders.sqlite";
  const automationRulesDbPath = process.env.JARVIS_AUTOMATION_RULES_DB_PATH ?? "./data/jarvis-automation-rules.sqlite";
  const automationFailuresDbPath =
    process.env.JARVIS_AUTOMATION_FAILURES_DB_PATH ?? "./data/jarvis-automation-failures.sqlite";
  const activityLogDbPath = process.env.JARVIS_ACTIVITY_LOG_DB_PATH ?? "./data/jarvis-activity.sqlite";
  const conversationHistoryDbPath =
    process.env.JARVIS_CONVERSATION_HISTORY_DB_PATH ?? "./data/jarvis-conversation-history.sqlite";
  const pairingDbPath = process.env.JARVIS_PAIRING_DB_PATH ?? "./data/jarvis-pairing.sqlite";
  const deviceRegistryDbPath = process.env.JARVIS_DEVICE_REGISTRY_DB_PATH ?? "./data/jarvis-devices.sqlite";
  const toolAuditLogDbPath = process.env.JARVIS_TOOL_AUDIT_LOG_DB_PATH ?? "./data/jarvis-tool-audit.sqlite";
  const tokenUsageDbPath = process.env.JARVIS_TOKEN_USAGE_DB_PATH ?? "./data/jarvis-token-usage.sqlite";
  const agentTaskDbPath = process.env.JARVIS_AGENT_TASK_DB_PATH ?? "./data/jarvis-agent-tasks.sqlite";
  const agentQueueTickMsRaw = process.env.JARVIS_AGENT_QUEUE_TICK_MS;
  const agentQueueTickMs = agentQueueTickMsRaw ? Number(agentQueueTickMsRaw) : 5_000;
  if (!Number.isFinite(agentQueueTickMs) || agentQueueTickMs <= 0) {
    throw new ConfigError("Invalid JARVIS_AGENT_QUEUE_TICK_MS: must be a positive integer");
  }

  const timezone = process.env.JARVIS_TIMEZONE?.trim() || "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    throw new ConfigError(`Invalid JARVIS_TIMEZONE: "${timezone}" is not a recognized IANA timezone name`);
  }

  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new ConfigError(`Invalid JARVIS_PORT: must be an integer between 1 and 65535`);
  }

  const twilioAuthToken = process.env.TWILIO_AUTH_TOKEN?.trim() || undefined;
  const twilioPublicBaseUrl = process.env.TWILIO_PUBLIC_BASE_URL?.trim() || undefined;

  if (Boolean(twilioAuthToken) !== Boolean(twilioPublicBaseUrl)) {
    throw new ConfigError(
      "TWILIO_AUTH_TOKEN and TWILIO_PUBLIC_BASE_URL must be set together (or neither) to enable the phone gateway"
    );
  }

  const twilioAllowedCallers = process.env.TWILIO_ALLOWED_CALLERS?.split(",")
    .map((n) => n.trim())
    .filter((n) => n.length > 0);
  // Deliberately opt-in: an empty TWILIO_ALLOWED_CALLERS used to just log
  // a warning and open the gateway to any caller anyway — anyone who
  // called the number reached full JARVIS, including tools like
  // SAVE_MEMORY, with nothing to stop them but a line in the server logs
  // nobody was watching. Now that gap requires this explicit flag instead
  // of silently falling through.
  const twilioAllowOpenAccess = process.env.TWILIO_ALLOW_OPEN_ACCESS?.trim().toLowerCase() === "true";
  const twilioVoice = process.env.TWILIO_VOICE?.trim() || undefined;
  const twilioVoiceHebrew = process.env.TWILIO_VOICE_HEBREW?.trim() || undefined;
  const twilioGatherLanguage = process.env.TWILIO_GATHER_LANGUAGE?.trim() || undefined;
  const twilioVoicePitch = process.env.TWILIO_VOICE_PITCH?.trim() || undefined;
  const twilioVoiceRate = process.env.TWILIO_VOICE_RATE?.trim() || undefined;
  const adminToken = process.env.JARVIS_ADMIN_TOKEN?.trim() || undefined;
  const webSearchEnabled = process.env.JARVIS_WEB_SEARCH?.trim().toLowerCase() === "true";
  const webSearchMaxUses = Number(process.env.JARVIS_WEB_SEARCH_MAX_USES ?? "5");

  if (!Number.isInteger(webSearchMaxUses) || webSearchMaxUses <= 0) {
    throw new ConfigError("Invalid JARVIS_WEB_SEARCH_MAX_USES: must be a positive integer");
  }

  const webFetchEnabled = process.env.JARVIS_WEB_FETCH?.trim().toLowerCase() === "true";
  const webFetchMaxUses = Number(process.env.JARVIS_WEB_FETCH_MAX_USES ?? "5");

  if (!Number.isInteger(webFetchMaxUses) || webFetchMaxUses <= 0) {
    throw new ConfigError("Invalid JARVIS_WEB_FETCH_MAX_USES: must be a positive integer");
  }

  const audioWaveformEnabled = process.env.JARVIS_AUDIO_WAVEFORM?.trim().toLowerCase() === "true";
  const anthropicBaseUrl = process.env.JARVIS_ANTHROPIC_BASE_URL?.trim() || undefined;
  const fallbackModel = process.env.JARVIS_FALLBACK_MODEL?.trim() || undefined;
  const publicBaseUrl = process.env.JARVIS_PUBLIC_BASE_URL?.trim() || undefined;
  const googleClientId = process.env.GOOGLE_CLIENT_ID?.trim() || undefined;
  const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim() || undefined;
  const calendarTokenDbPath = process.env.JARVIS_CALENDAR_TOKEN_DB_PATH ?? "./data/jarvis-calendar-tokens.sqlite";

  if (Boolean(googleClientId) !== Boolean(googleClientSecret)) {
    throw new ConfigError("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set together (or neither) to enable Calendar integration");
  }
  if (googleClientId && googleClientSecret && !publicBaseUrl) {
    throw new ConfigError(
      "JARVIS_PUBLIC_BASE_URL is required once Calendar integration is configured (GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET) — " +
        "Google needs a real, fixed redirect URI for the OAuth flow, the same way TWILIO_PUBLIC_BASE_URL is required for Twilio."
    );
  }
  if (googleClientId && googleClientSecret && !adminToken) {
    throw new ConfigError(
      "JARVIS_ADMIN_TOKEN is required once Calendar integration is configured — GET /calendar/oauth/start starts " +
        "an OAuth flow linking a real Google account and must not be triggerable by an unauthenticated request."
    );
  }

  const spotifyClientId = process.env.SPOTIFY_CLIENT_ID?.trim() || undefined;
  const spotifyClientSecret = process.env.SPOTIFY_CLIENT_SECRET?.trim() || undefined;
  const spotifyTokenDbPath = process.env.JARVIS_SPOTIFY_TOKEN_DB_PATH ?? "./data/jarvis-spotify-tokens.sqlite";

  if (Boolean(spotifyClientId) !== Boolean(spotifyClientSecret)) {
    throw new ConfigError("SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET must be set together (or neither) to enable Spotify integration");
  }
  if (spotifyClientId && spotifyClientSecret && !publicBaseUrl) {
    throw new ConfigError(
      "JARVIS_PUBLIC_BASE_URL is required once Spotify integration is configured (SPOTIFY_CLIENT_ID/SPOTIFY_CLIENT_SECRET) — " +
        "Spotify needs a real, fixed redirect URI for the OAuth flow."
    );
  }
  if (spotifyClientId && spotifyClientSecret && !adminToken) {
    throw new ConfigError(
      "JARVIS_ADMIN_TOKEN is required once Spotify integration is configured — GET /spotify/oauth/start starts " +
        "an OAuth flow linking a real Spotify account and must not be triggerable by an unauthenticated request."
    );
  }

  const studioBaseUrl = process.env.JARVIS_STUDIO_BASE_URL?.trim() || undefined;
  const studioSecret = process.env.JARVIS_STUDIO_SECRET?.trim() || undefined;
  if (Boolean(studioBaseUrl) !== Boolean(studioSecret)) {
    throw new ConfigError(
      "JARVIS_STUDIO_BASE_URL and JARVIS_STUDIO_SECRET must be set together (or neither) to enable the video studio integration"
    );
  }

  const twilioAccountSid = process.env.TWILIO_ACCOUNT_SID?.trim() || undefined;
  const twilioFromNumber = process.env.TWILIO_FROM_NUMBER?.trim() || undefined;
  const ownerPhoneNumber = process.env.JARVIS_OWNER_PHONE_NUMBER?.trim() || undefined;
  const wakeUpCallDbPath = process.env.JARVIS_WAKEUP_CALL_DB_PATH ?? "./data/jarvis-wakeup-calls.sqlite";
  const alarmDbPath = process.env.JARVIS_ALARM_DB_PATH ?? "./data/jarvis-alarms.sqlite";

  const outboundCallFieldsSet = [twilioAccountSid, twilioFromNumber, ownerPhoneNumber].filter(Boolean).length;
  if (outboundCallFieldsSet > 0 && outboundCallFieldsSet < 3) {
    throw new ConfigError(
      "TWILIO_ACCOUNT_SID, TWILIO_FROM_NUMBER, and JARVIS_OWNER_PHONE_NUMBER must all be set together " +
        "(or none of them) to enable outbound calls (e.g. scheduled wake-up calls)"
    );
  }

  const maxOutboundCallsPerDayRaw = process.env.JARVIS_MAX_OUTBOUND_CALLS_PER_DAY?.trim();
  const maxOutboundCallsPerDay = maxOutboundCallsPerDayRaw ? Number(maxOutboundCallsPerDayRaw) : 10;
  if (!Number.isInteger(maxOutboundCallsPerDay) || maxOutboundCallsPerDay < 1) {
    throw new ConfigError("JARVIS_MAX_OUTBOUND_CALLS_PER_DAY must be a positive integer");
  }

  if (twilioAuthToken && twilioPublicBaseUrl && !adminToken) {
    throw new ConfigError(
      "JARVIS_ADMIN_TOKEN is required once the phone gateway is configured (TWILIO_AUTH_TOKEN/TWILIO_PUBLIC_BASE_URL) — " +
        "this server becomes reachable from the public internet, and POST /pairing/approve needs a secret independent of " +
        "the pairing code itself to stay safe from self-approved fake devices. Set JARVIS_ADMIN_TOKEN to any long random value."
    );
  }

  const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN?.trim() || undefined;
  const telegramWebhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim() || undefined;
  const telegramAllowedChatIds = process.env.TELEGRAM_ALLOWED_CHAT_IDS?.split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  const telegramOwnerChatId = process.env.TELEGRAM_OWNER_CHAT_ID?.trim() || undefined;
  // Same reasoning as twilioAllowOpenAccess above — an empty
  // TELEGRAM_ALLOWED_CHAT_IDS used to silently leave the bot open to
  // anyone who found and messaged it.
  const telegramAllowOpenAccess = process.env.TELEGRAM_ALLOW_OPEN_ACCESS?.trim().toLowerCase() === "true";

  const telegramFieldsSet = [telegramBotToken, telegramWebhookSecret].filter(Boolean).length;
  if (telegramFieldsSet > 0 && telegramFieldsSet < 2) {
    throw new ConfigError(
      "TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET must both be set together (or neither) to enable the " +
        "Telegram gateway — the secret is what proves an incoming webhook request actually came from Telegram."
    );
  }

  const weatherLatitudeRaw = process.env.JARVIS_WEATHER_LATITUDE?.trim();
  const weatherLongitudeRaw = process.env.JARVIS_WEATHER_LONGITUDE?.trim();
  const weatherLatitude = weatherLatitudeRaw ? Number(weatherLatitudeRaw) : undefined;
  const weatherLongitude = weatherLongitudeRaw ? Number(weatherLongitudeRaw) : undefined;

  if ((weatherLatitudeRaw && Number.isNaN(weatherLatitude)) || (weatherLongitudeRaw && Number.isNaN(weatherLongitude))) {
    throw new ConfigError("JARVIS_WEATHER_LATITUDE and JARVIS_WEATHER_LONGITUDE must be valid numbers");
  }
  if (
    (weatherLatitude !== undefined && (weatherLatitude < -90 || weatherLatitude > 90)) ||
    (weatherLongitude !== undefined && (weatherLongitude < -180 || weatherLongitude > 180))
  ) {
    throw new ConfigError(
      "JARVIS_WEATHER_LATITUDE must be between -90 and 90, and JARVIS_WEATHER_LONGITUDE between -180 and 180"
    );
  }

  const weatherFieldsSet = [weatherLatitude, weatherLongitude].filter((v) => v !== undefined).length;
  if (weatherFieldsSet > 0 && weatherFieldsSet < 2) {
    throw new ConfigError(
      "JARVIS_WEATHER_LATITUDE and JARVIS_WEATHER_LONGITUDE must both be set together (or neither) to enable weather lookups"
    );
  }

  const newsRssUrl = process.env.JARVIS_NEWS_RSS_URL?.trim() || undefined;

  const weeklyDigestDayRaw = process.env.JARVIS_WEEKLY_DIGEST_DAY?.trim();
  const weeklyDigestTime = process.env.JARVIS_WEEKLY_DIGEST_TIME?.trim() || undefined;
  const weeklyDigestDayOfWeek = weeklyDigestDayRaw ? Number(weeklyDigestDayRaw) : undefined;

  if (
    weeklyDigestDayRaw &&
    (Number.isNaN(weeklyDigestDayOfWeek) || weeklyDigestDayOfWeek! < 0 || weeklyDigestDayOfWeek! > 6)
  ) {
    throw new ConfigError("JARVIS_WEEKLY_DIGEST_DAY must be an integer from 0 (Sunday) to 6 (Saturday)");
  }
  if (weeklyDigestTime && !/^([01]\d|2[0-3]):[0-5]\d$/.test(weeklyDigestTime)) {
    throw new ConfigError("JARVIS_WEEKLY_DIGEST_TIME must be in HH:MM 24-hour format");
  }

  const weeklyDigestFieldsSet = [weeklyDigestDayOfWeek, weeklyDigestTime].filter((v) => v !== undefined).length;
  if (weeklyDigestFieldsSet > 0 && weeklyDigestFieldsSet < 2) {
    throw new ConfigError(
      "JARVIS_WEEKLY_DIGEST_DAY and JARVIS_WEEKLY_DIGEST_TIME must both be set together (or neither)"
    );
  }

  const checkinAfterHoursRaw = process.env.JARVIS_CHECKIN_AFTER_HOURS?.trim();
  const checkinAfterHours = checkinAfterHoursRaw ? Number(checkinAfterHoursRaw) : undefined;
  if (checkinAfterHoursRaw && (Number.isNaN(checkinAfterHours) || checkinAfterHours! <= 0)) {
    throw new ConfigError("JARVIS_CHECKIN_AFTER_HOURS must be a positive number");
  }

  const morningBriefingTime = process.env.JARVIS_MORNING_BRIEFING_TIME?.trim() || undefined;
  if (morningBriefingTime && !/^([01]\d|2[0-3]):[0-5]\d$/.test(morningBriefingTime)) {
    throw new ConfigError("JARVIS_MORNING_BRIEFING_TIME must be in HH:MM 24-hour format");
  }

  const costAlertThresholdRaw = process.env.JARVIS_COST_ALERT_THRESHOLD_USD?.trim();
  const costAlertThresholdUsd = costAlertThresholdRaw ? Number(costAlertThresholdRaw) : undefined;
  if (costAlertThresholdRaw && (Number.isNaN(costAlertThresholdUsd) || costAlertThresholdUsd! <= 0)) {
    throw new ConfigError("JARVIS_COST_ALERT_THRESHOLD_USD must be a positive number");
  }

  const commitmentsDbPath = process.env.JARVIS_COMMITMENTS_DB_PATH ?? "./data/jarvis-commitments.sqlite";

  const staleCommitmentDaysRaw = process.env.JARVIS_STALE_COMMITMENT_DAYS?.trim();
  const staleCommitmentDays = staleCommitmentDaysRaw ? Number(staleCommitmentDaysRaw) : 3;
  if (staleCommitmentDaysRaw && (Number.isNaN(staleCommitmentDays) || staleCommitmentDays <= 0)) {
    throw new ConfigError("JARVIS_STALE_COMMITMENT_DAYS must be a positive number");
  }

  const HHMM_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
  const quietHoursStart = process.env.JARVIS_QUIET_HOURS_START?.trim() || undefined;
  const quietHoursEnd = process.env.JARVIS_QUIET_HOURS_END?.trim() || undefined;
  if (quietHoursStart && !HHMM_PATTERN.test(quietHoursStart)) {
    throw new ConfigError("JARVIS_QUIET_HOURS_START must be in HH:MM 24-hour format");
  }
  if (quietHoursEnd && !HHMM_PATTERN.test(quietHoursEnd)) {
    throw new ConfigError("JARVIS_QUIET_HOURS_END must be in HH:MM 24-hour format");
  }
  if (Boolean(quietHoursStart) !== Boolean(quietHoursEnd)) {
    throw new ConfigError(
      "JARVIS_QUIET_HOURS_START and JARVIS_QUIET_HOURS_END must be set together (or neither) to enable quiet hours"
    );
  }

  const maxToolCallsPerRunRaw = process.env.JARVIS_MAX_TOOL_CALLS_PER_RUN?.trim();
  const maxToolCallsPerRun = maxToolCallsPerRunRaw ? Number(maxToolCallsPerRunRaw) : 30;
  if (maxToolCallsPerRunRaw && (!Number.isInteger(maxToolCallsPerRun) || maxToolCallsPerRun <= 0)) {
    throw new ConfigError("JARVIS_MAX_TOOL_CALLS_PER_RUN must be a positive integer");
  }

  const localToolTimeoutMsRaw = process.env.JARVIS_LOCAL_TOOL_TIMEOUT_MS?.trim();
  const localToolTimeoutMs = localToolTimeoutMsRaw ? Number(localToolTimeoutMsRaw) : 30_000;
  if (localToolTimeoutMsRaw && (!Number.isInteger(localToolTimeoutMs) || localToolTimeoutMs < 0)) {
    throw new ConfigError("JARVIS_LOCAL_TOOL_TIMEOUT_MS must be a non-negative integer");
  }

  const agentMailApiKey = process.env.AGENTMAIL_API_KEY?.trim() || undefined;
  const agentMailInboxId = process.env.AGENTMAIL_INBOX_ID?.trim() || undefined;
  if (Boolean(agentMailApiKey) !== Boolean(agentMailInboxId)) {
    throw new ConfigError(
      "AGENTMAIL_API_KEY and AGENTMAIL_INBOX_ID must be set together (or neither) to enable the AgentMail integration"
    );
  }
  const agentMailMaxSendsPerDayRaw = process.env.AGENTMAIL_MAX_SENDS_PER_DAY?.trim();
  const agentMailMaxSendsPerDay = agentMailMaxSendsPerDayRaw ? Number(agentMailMaxSendsPerDayRaw) : 20;
  if (
    agentMailMaxSendsPerDayRaw &&
    (!Number.isInteger(agentMailMaxSendsPerDay) || agentMailMaxSendsPerDay < 1)
  ) {
    throw new ConfigError("AGENTMAIL_MAX_SENDS_PER_DAY must be a positive integer");
  }

  const ollamaBaseUrl = process.env.OLLAMA_BASE_URL?.trim() || "http://localhost:11434";
  const ollamaEmbeddingModel = process.env.OLLAMA_EMBEDDING_MODEL?.trim() || undefined;

  return {
    brainProvider,
    brainProviderExplicit,
    anthropicApiKey,
    groqApiKey,
    groqModel,
    openrouterApiKey,
    openrouterModel,
    promptCachingEnabled,
    aiFreeFirst,
    aiFallbackProvider,
    maxDailyCostUsd,
    maxMonthlyCostUsd,
    maxCostPerRunUsd,
    zeroCostMode,
    softBudgetCapRatio,
    aiCircuitBreakerThreshold,
    aiCircuitBreakerCooldownMs,
    aiCostDbPath,
    toolResultCacheTtlMs,
    port,
    memoryDbPath,
    webauthnDbPath,
    remindersDbPath,
    automationRulesDbPath,
    automationFailuresDbPath,
    activityLogDbPath,
    conversationHistoryDbPath,
    pairingDbPath,
    deviceRegistryDbPath,
    toolAuditLogDbPath,
    tokenUsageDbPath,
    agentTaskDbPath,
    agentQueueTickMs,
    timezone,
    twilioAuthToken,
    twilioPublicBaseUrl,
    twilioAllowedCallers,
    twilioAllowOpenAccess,
    twilioVoice,
    twilioVoiceHebrew,
    twilioGatherLanguage,
    twilioVoicePitch,
    twilioVoiceRate,
    twilioAccountSid,
    twilioFromNumber,
    ownerPhoneNumber,
    maxOutboundCallsPerDay,
    wakeUpCallDbPath,
    alarmDbPath,
    adminToken,
    webSearchEnabled,
    webSearchMaxUses,
    webFetchEnabled,
    webFetchMaxUses,
    audioWaveformEnabled,
    anthropicBaseUrl,
    fallbackModel,
    publicBaseUrl,
    googleClientId,
    googleClientSecret,
    calendarTokenDbPath,
    spotifyClientId,
    spotifyClientSecret,
    spotifyTokenDbPath,
    studioBaseUrl,
    studioSecret,
    commitmentsDbPath,
    staleCommitmentDays,
    quietHoursStart,
    quietHoursEnd,
    telegramBotToken,
    telegramWebhookSecret,
    telegramAllowedChatIds,
    telegramAllowOpenAccess,
    telegramOwnerChatId,
    weatherLatitude,
    weatherLongitude,
    newsRssUrl,
    weeklyDigestDayOfWeek,
    weeklyDigestTime,
    checkinAfterHours,
    morningBriefingTime,
    costAlertThresholdUsd,
    maxToolCallsPerRun,
    localToolTimeoutMs,
    agentMailApiKey,
    agentMailInboxId,
    agentMailMaxSendsPerDay,
    ollamaBaseUrl,
    ollamaEmbeddingModel,
  };
}

/**
 * Explicit allowlist of `JarvisConfig` fields known to hold a secret —
 * kept in addition to (not instead of) the pattern match below, so a
 * secret whose name happens not to contain "token"/"secret"/"key" is
 * still caught by name, and a future secret field is still caught by
 * pattern even if someone forgets to add it here. Belt-and-suspenders:
 * Config Center (JARVIS_ROADMAP_AUDIT.md #208) must never leak one of
 * these, the same care GET /status and GET /health already take.
 */
const KNOWN_SECRET_CONFIG_FIELDS: ReadonlySet<keyof JarvisConfig> = new Set([
  "anthropicApiKey",
  "groqApiKey",
  "openrouterApiKey",
  "twilioAuthToken",
  "telegramBotToken",
  "telegramWebhookSecret",
  "adminToken",
  "googleClientSecret",
  "spotifyClientSecret",
  "studioSecret",
  "agentMailApiKey",
]);

/** Case-insensitive fallback pattern catching any field name that reads as a secret, even one not in the explicit list above. */
const SECRET_FIELD_NAME_PATTERN = /token|secret|apikey|api_key|password|credential/i;

function isSecretConfigField(field: string): boolean {
  // A field ending in "Path" is a filesystem path (e.g. tokenUsageDbPath,
  // calendarTokenDbPath, spotifyTokenDbPath) — never a credential value
  // itself, even though its name happens to contain "token"/"secret". The
  // fallback pattern below is for secret *values* (API keys, auth tokens),
  // so path fields must be excluded from it or a real path silently turns
  // into a useless {"configured": true} in the config viewer, defeating
  // the whole point of showing paths unredacted (see doc comment above).
  if (field.endsWith("Path")) {
    return false;
  }
  return KNOWN_SECRET_CONFIG_FIELDS.has(field as keyof JarvisConfig) || SECRET_FIELD_NAME_PATTERN.test(field);
}

/**
 * A version of the loaded config safe to show in a UI or return from an
 * HTTP endpoint (Config Center — JARVIS_ROADMAP_AUDIT.md #208): every
 * secret-shaped field is replaced with a boolean "is it set" instead of
 * its real value. Everything else (paths, timeouts, feature flags,
 * non-secret IDs like `twilioAccountSid`/`googleClientId`) passes
 * through unchanged, since none of it is a credential and seeing the
 * real value is the entire point of a config viewer.
 */
export function redactConfigForDisplay(config: JarvisConfig): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(config)) {
    redacted[field] = isSecretConfigField(field) ? { configured: value !== undefined && value !== "" } : value;
  }
  return redacted;
}

export { ConfigError };
