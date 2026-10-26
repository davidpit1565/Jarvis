# JARVIS — Competitive / Architectural Research on Other Open-Source AI Assistants

Research date: 2026-10-26. Scope: public web search and public pages (READMEs, docs, blog
write-ups, academic/critique pieces) on real, existing open-source "AI assistant" / voice
assistant / computer-use-agent projects, done to find concrete architectural patterns worth
adopting into JARVIS (`davidpit1565/Jarvis`) — **not** to copy any project's code or prompts.
No GitHub repo-browsing tool was used; only `WebSearch`/`WebFetch` against public pages, per the
task's constraint. Several sources below are third-party blog posts / reviews rather than
primary docs, and are flagged as such — treat unverified specifics (star counts, exact file
names, performance numbers) as indicative, not authoritative, the same evidentiary standard
`JARVIS_AUDIT.md` and `JARVIS_ROADMAP_AUDIT.md` use for this repo's own code.

Legend: each area lists 2-4 named projects/approaches, the **concrete pattern** worth borrowing,
**why** it matters for JARVIS specifically, and a **known pitfall** so we don't walk into it
blind.

---

## 1. Continuous personal memory/profile that updates automatically

JARVIS today: `src/memory/MemoryStore.ts` is a flat SQLite key/value store, written to only when
a tool call explicitly decides to save a fact (roadmap item #14 "Memory Quality Layer" and #15
"Memory Conflict Resolver" are both MISSING/PARTIAL per `JARVIS_ROADMAP_AUDIT.md`). None of the
projects below are drop-in replacements, but each has one load-bearing idea.

- **Letta (formerly MemGPT)** — self-editing, tiered memory. The agent itself holds designated
  memory-editing tools (reported names include `core_memory_append`/`core_memory_replace`) and
  decides, turn by turn, what moves between **in-context "core" memory** (system instructions +
  a few read/write blocks + recent turns) and **out-of-context memory** (archival storage,
  evicted history) — effectively an OS-style paging system where the LLM is its own page-fault
  handler. A "heartbeat" flag lets it chain several memory operations before replying.
  **Worth borrowing:** treating memory writes as a *tool the brain calls*, not a side-channel the
  orchestrator runs outside the model's view — this is exactly what's missing from JARVIS's
  current explicit-save-only model. **Pitfall:** memory quality is entirely a function of the
  model's judgment in that turn, every memory op burns real inference tokens, and (per a Letta
  vs. mem0 comparison) memory is scoped per-agent, not naturally shared/merged across sessions —
  a self-editing memory system without the "conflict resolver" item JARVIS has as MISSING (#15)
  can drift into subtly contradictory or stale facts with no detection. [Letta docs](https://docs.letta.com/concepts/letta), [Letta MemGPT architecture](https://docs.letta.com/guides/agents/architectures/memgpt), [Mem0 vs Letta comparison](https://vectorize.io/articles/mem0-vs-letta)

- **mem0** — a memory layer *between* the agent and storage, not inside the agent's own context
  management. Exposes three ops (`add`/`search`/`update-delete`); on write it extracts facts from
  raw messages into discrete memory items (text + metadata + embeddings); on read it does
  semantic search across a **hybrid vector + key-value + graph store** and applies a scoring pass
  weighing relevance, significance and recency before injecting results into the prompt. Memory
  is scoped at user/session/agent levels, Apache-2.0, self-hostable as a library or Docker stack.
  **Worth borrowing:** the add/search/update API shape and the "extract discrete facts from the
  raw conversation automatically, every turn" write path is the literal missing piece for
  "continuous profile that updates from every conversation" — it doesn't require waiting for the
  model to decide to call a save-tool. **Pitfall:** the headline accuracy numbers (e.g. the
  often-cited "26% better than OpenAI's memory") come from mem0-adjacent benchmarks, not neutral
  third-party evals — don't take vendor-published memory-quality claims (from mem0 or anyone) at
  face value without testing on JARVIS's own data. [mem0 blog](https://mem0.ai/blog/open-source-ai-agents-with-built-in-memory), [mem0 vs OpenAI memory](https://www.mindstudio.ai/blog/agent-memory-infrastructure-mem0-vs-openai)

- **Khoj** — less about *how* memory works internally (public sources don't document its write
  path in detail) and more about **what counts as memory**: it treats a person's own documents
  (notes, PDFs, Markdown, Notion exports) as the persistent "second brain," indexed into
  PostgreSQL+pgvector for semantic retrieval, with local-model support (Ollama/gguf) for a fully
  self-hosted, no-cloud deployment. **Worth borrowing:** the framing that "personal memory" isn't
  only conversational facts extracted by an LLM — it's also raw personal documents retrievable by
  meaning, which is a cheap, deterministic complement to LLM-extracted facts and far less prone
  to hallucinated "facts." **Pitfall:** this only works if the person actually feeds it documents;
  it does nothing for implicit facts mentioned only in passing conversation (the actual gap
  JARVIS has), so it's a complement to mem0/Letta-style extraction, not a substitute.
  [Khoj Railway deployment template](https://railway.com/deploy/khoj), [Khoj self-host template](https://railway.com/deploy/khoj-self-hosted-ai-second-brain--khoj-ai-second-brain)

**Concrete pattern for JARVIS:** none of these are "install and done" — the actionable takeaway
is a **background memory-extraction pass** (mem0-style: run after every conversation turn,
independent of whether the model called a save tool) writing into a **scored, queryable store**
(not flat key/value) with **conflict/contradiction detection** across semantically related keys
(Letta/mem0 both lack a fully solved version of this — it's a real open problem, not something
JARVIS is behind on).

---

## 2. Always-listening / wake-word voice across multiple devices

JARVIS today: no wake-word/continuous-listening pipeline exists yet (voice is push-to-talk via
Telegram/phone or explicit commands); the Mac/iMac agent handles device actions, not ambient
audio capture.

- **openWakeWord + local-stack pattern (as used by Home Assistant and DIY setups)** — a *tiny*,
  dedicated wake-word model runs continuously and locally; it is cheap enough to listen 24/7
  without sending any audio anywhere. Only after the trigger phrase fires does a (larger, costlier)
  STT/LLM pipeline see any audio at all. One documented home-lab stack keeps wake-word detection,
  transcription, and intent dispatch entirely on the local network — no audio leaves the premises
  except after the wake word. **Worth borrowing:** the two-stage gate (cheap always-on local
  classifier → expensive cloud/LLM path only after trigger) is the only architecture that makes
  "always listening" compatible with JARVIS's existing cost-tracking/budget-cap design
  (`AIRouter`/`CostTracker`) — sending raw audio to Claude/Groq continuously would blow both
  privacy and the $0-first cost model. **Pitfall:** a 2019 academic paper (Malkin/Egelman/Wagner,
  NSPW '19) argues existing technical controls are insufficient to actually enforce user limits on
  what an always-listening device captures — i.e. "the wake-word gate is local" is a real mitigation
  but not a complete privacy guarantee on its own; it needs an explicit, visible mute/kill control
  too. [Restrepo local voice stack](https://restrepoinnovations.com/ai/faq/does-the-ai-listen-all-the-time.html), [Privacy Controls for Always-Listening Devices, NSPW'19](https://blues.cs.berkeley.edu/?p=710)

- **Home Assistant Voice Preview Edition** — a concrete, productized version of the same split:
  on-device wake-word (microWakeWord, supports custom phrases like "Hey Jarvis"), audio
  front-end hardware (dual mics + XMOS chip) doing echo cancellation/noise removal *before*
  anything is classified, then a *choice* of speech-processing tiers — fully local
  (Speech-to-Phrase or Whisper, needs an N100-class home server), or cloud offload for weaker
  hardware. Ships with a **hardware mute switch that cuts power to the microphones** — not a
  software toggle. **Worth borrowing:** (a) making local-vs-cloud STT a deployment-time
  configuration knob rather than a single hardcoded path — directly extends JARVIS's existing
  free/paid `AIRouter` tiering concept to the voice pipeline; (b) a hard, physical/explicit
  mute affordance as a trust signal, not just a settings toggle. **Pitfall:** community reports
  that swapping in a custom wake-word model doesn't work with stock firmware without re-flashing
  via ESPHome — i.e. "pluggable wake word" is a stated goal but imperfectly delivered even in a
  well-funded project; budget for real integration friction, not just API compatibility.
  [Home Assistant Voice toolbox](https://toolbox.openhomefoundation.org/home-assistant-voice-preview-edition/), [HA community thread on custom wake words](https://community.home-assistant.io/t/how-can-i-use-a-custom-openwakeword-model-with-home-assistant-voice-preview-edition/1019895)

- **Rhasspy** — fully offline, modular pipeline (wake word → STT → intent recognition → TTS,
  each independently swappable: Kaldi/Pocketsphinx/DeepSpeech for STT) communicating over MQTT
  (the Hermes protocol) so skills can be written in any language that can publish/subscribe JSON.
  Multi-device "satellite" support (cheap ESP32 boards doing mic capture only, streaming audio
  over MQTT to one central Rhasspy brain) is a **community-built pattern**, not core Rhasspy —
  worth noting since it's the direct analog of "phone + Mac, one brain." **Worth borrowing:** a
  message-bus (MQTT-like) decoupling between "device that has a microphone" and "device that runs
  the brain" generalizes cleanly to JARVIS's existing WebSocket device-pairing protocol — the
  phone/Mac don't need to run STT or intent parsing themselves, only stream audio after a local
  wake event. **Pitfall:** one (older, possibly stale) user review claimed Rhasspy "doesn't
  support satellites at all" and requires a full Pi4 per room — a reminder that lightweight
  satellite support is often bolted on later and may not be as turnkey as the README/marketing
  implies; verify end-to-end latency and reliability before committing to a satellite design.
  [LWN: Hopes and promises for open-source voice assistants](https://lwn.net/Articles/926484), [Rhasspy on Raspberry Pi — BoingBoing](https://boingboing.net/2020/01/06/rhasspy-on-raspi.html)

**Concrete pattern for JARVIS:** adopt the two-stage gate (local wake-word classifier, silent and
free, on each device → only post-wake audio goes to STT/Claude) plus a message-bus-style device
protocol so the phone and Mac are "dumb" wake-word+mic satellites talking to one Core brain over
the existing WebSocket pairing channel, not each running their own STT/LLM stack.

---

## 3. Multi-device control (one brain, Mac + phone + browser)

JARVIS today: the Swift native agent already does open-app/type-text/notifications; camera isn't
wired; there's one Orchestrator loop per conversation channel with a 5-iteration tool-call cap.

- **Home Assistant's device/entity/domain model** — the cleanest, most battle-tested abstraction
  found in this research. Three layers: **integration** (one per vendor/protocol, e.g. "Philips
  Hue"), **device** (a physical/logical unit, a grouping container — disabling it cascades to
  everything under it), **entity** (the actual controllable/observable unit, always exactly one
  state at a time plus attributes, named `domain.object_id` e.g. `light.bed_light`). The
  **domain** standardizes what data/controls exist for a category (all `light.*` entities expose
  the same control surface regardless of brand), with integrations allowed to bolt on
  non-standard extra actions beyond the domain's baseline. **Worth borrowing directly:** this maps
  almost one-to-one onto JARVIS's own `LocalTool`/`DeviceTool` split
  (`src/tools/registry/ToolRegistry.ts`, `src/types/tools.ts`) — the missing piece is the
  **domain standardization layer**: today a Mac "open app" tool and a (future) phone "open app"
  tool would likely be two unrelated tool definitions; HA's model says they should both be
  `app.open` entities under an `app` domain with brand/device-specific integrations underneath,
  so the brain reasons about *capabilities* ("can I open an app on *a* device") not
  *implementations* ("call `MacOpenAppTool` vs `PhoneOpenAppTool`"). This becomes essential once
  JARVIS adds a second controllable device (phone) alongside the Mac. **Pitfall:** HA's own docs
  admit the integration hierarchy is "loose" (an integration can create entities with no backing
  physical device at all), and domain standardization only works as long as someone disciplined
  enforces that new integrations actually conform to the domain's existing data shape instead of
  inventing one-off attributes — the model degrades gracefully but silently if that discipline
  lapses. [HA devices and services docs](https://developers.home-assistant.io/docs/architecture/devices-and-services), [HA entities and domains docs](https://www.home-assistant.io/docs/configuration/entities_domains/)

- **Anthropic's own computer-use pattern** — a tight perception→reasoning→action loop
  (screenshot → model decides an action → execute → new screenshot → repeat until done or a step
  limit), with the *tool* surface kept to a handful of primitives (screenshot, mouse, keyboard)
  and the *application code* — not the model — deciding whether a tool call is allowed and when
  the loop halts. **Worth borrowing:** this is effectively the fallback-of-last-resort for device
  actions JARVIS's Swift agent hasn't wired as a typed tool yet (e.g. "click this specific UI
  element nobody built an API for") — a generic screen-level fallback behind the *same*
  CONFIRM/DANGEROUS permission gate JARVIS already enforces for everything else, not a parallel
  unguarded path. **Pitfall:** multiple sources converge on the same critique — screenshot-driven
  control is slow (seconds per step) and probabilistic/fragile compared to a typed API call, and
  a widely cited guide on Anthropic-style agent loops explicitly recommends **narrow, strictly
  typed tools over a generic catch-all "run an action" tool** — i.e. computer-use/screen-control
  should be the exception path for untyped actions, not the default way JARVIS controls the Mac,
  which already has typed Swift tools and should keep adding more rather than regressing to
  screen-scraping. [DeepLearning.AI computer use course](https://learn.deeplearning.ai/courses/building-toward-computer-use-with-anthropic/lesson/8/computer-use), [Anthropic agent loop build guide](https://blog.promptlayer.com/how-to-build-an-anthropic-agent-loop/)

- **Open Interpreter** — splits into an orchestrator (conversation loop), an LLM handler
  abstracting multiple providers (via LiteLLM), and a `Computer` class that is the actual OS
  control surface (code execution, screenshots, OS APIs) — i.e. it cleanly separates "which brain
  answered" from "what the brain can physically do," so swapping the model provider never touches
  the device-control code. **Worth borrowing:** this maps onto JARVIS's existing `AIRouter`
  provider abstraction — the lesson is to make sure the *device tool layer* (Swift agent /
  `DeviceTool`) stays equally decoupled from *which brain* (Claude/Groq/OpenRouter/Cloudflare) is
  driving it, which the current architecture already does reasonably well per the audit, so this
  is more a "don't regress this" confirmation than a new idea. **Pitfall:** write-code-execute-observe
  as the core loop (arbitrary code execution as the action primitive) is powerful but is the
  single highest-blast-radius design in this entire research set — it is architecturally the
  opposite of JARVIS's PermissionLevel/CONFIRM/DANGEROUS model; the "generic code execution tool"
  pattern should specifically **not** be adopted as-is for a personal assistant that also has
  SMS/email/calendar access, without wrapping every execution in the same confirmation gate as any
  other DANGEROUS tool. [DeepWiki Open Interpreter architecture](https://deepwiki.com/openinterpreter/open-interpreter), [How It's Built: Open Interpreter](https://sean.lyn.ch/how-its-built-open-interpreter/)

**Concrete pattern for JARVIS:** adopt a Home-Assistant-style **domain/entity abstraction** on top
of the existing `LocalTool`/`DeviceTool` split (e.g. a `device.app.open`, `device.notify.send`
domain contract that both the Mac Swift agent and a future phone agent implement identically),
and keep any future "generic screen/code control" fallback strictly behind the existing
CONFIRM/DANGEROUS gate rather than as a new unguarded capability.

---

## 4. Personal-assistant personality/prompt design in real "Jarvis clone" repos

JARVIS already has a fixed `JARVIS_SYSTEM_PROMPT` (`src/core/brain/systemPrompt.ts`). The
research here is about *patterns* in how other Jarvis-style projects structure persona, not about
reusing anyone's actual prompt text (several of these are small/unverified repos; treat all of
the below as illustrative of *approach*, not proof of quality).

- **ethanplusai/jarvis** — voice-first macOS assistant whose README explicitly commits to a
  specific, narrow persona ("British accent, dry wit") plus deep OS integration (Calendar, Mail,
  Notes) rather than a generic "helpful assistant" tone. **Worth borrowing:** a narrow, specific
  personality brief (not "be helpful and friendly") is what makes a Jarvis-style assistant feel
  like *a character* rather than a chatbot with a wake word — this is a one-line addition to
  JARVIS's existing fixed system prompt, essentially free to try. **Pitfall:** personality tone is
  a config file away from actually mattering less than it seems — none of the search results
  describe any project *measuring* whether the personality persisted across tool-calling turns,
  long conversations, or error states; a persona that's only visible in a demo but vanishes during
  a 5-tool-call confirmation flow (JARVIS's real workload) is a known soft spot worth explicitly
  testing for, not just writing into the prompt and assuming it holds.

- **Project-JARVIS (dynamic MCP tool discovery)** — described as "privacy-first, local-first"
  with *dynamic* tool discovery via MCP orchestration rather than a fixed, hardcoded tool list.
  **Worth borrowing:** the "privacy-first, local-first" framing as an explicit product value, not
  an afterthought — JARVIS already leans this way (free providers, $0 hosting path per
  `JARVIS_AUDIT.md`) but doesn't yet state it as a design principle the way this project's README
  apparently does; making it explicit in JARVIS's own prompt/docs ("prefer local/free action,
  minimize data leaving the device") gives the model and the user a shared, legible policy instead
  of an implicit one. **Pitfall:** none independently verifiable from search alone — this project
  is thin on public detail; don't adopt specific claims about it without reading its actual repo
  (out of scope here).

- **Common pattern across the small Jarvis clones (Mano11x/JARVIS, BlackTechX011/JARVIS,
  MichalKacprzak99/jarvis, sukeesh/Jarvis)** — nearly all of them describe themselves primarily by
  **feature list** (weather, notes, timers, Wikipedia search, file management) rather than by
  persona or safety model. **Worth noting as an anti-pattern to avoid repeating:** a feature-list
  identity ("I can do X, Y, Z") is generic and doesn't differentiate JARVIS, which already has a
  much stronger differentiator in its permission-level/confirmation/audit system — that safety
  architecture, not the tool count, is the actual competitive advantage over these hobby clones,
  and the system prompt/dashboard framing should foreground it rather than imitate the
  feature-list style of smaller clones that have no such model at all.
  [ethanplusai/jarvis](https://github.com/ethanplusai/jarvis), [Mano11x/JARVIS](https://github.com/Mano11x/JARVIS), [sukeesh/Jarvis fork](https://github.com/MLDaily/Jarvis)

**Concrete pattern for JARVIS:** tighten the existing fixed system prompt with (a) a narrow,
specific personality brief instead of generic helpfulness language, (b) an explicit stated
privacy/local-first policy the model can reason from when choosing between providers/tools, and
(c) lead with the permission/confirmation/audit model as the identity, not a tool-count feature
list — then actually test persona persistence across a multi-tool-call CONFIRM flow, since no
reference project in this research demonstrates that it survives one.

---

## 5. Structuring ~1000 tools without conflicts (registry/namespacing at scale)

JARVIS today: roadmap audit reports ~50 local + 17 device tools (`JARVIS_ROADMAP_AUDIT.md` #5) —
nowhere near 1000 yet, but the question is about the architecture to get there without collapse.

- **OpenAI's own function-calling guidance** — a directly-quoted fragment from OpenAI's current
  docs: *"aim for fewer than 20 functions available"* in a single request/context. OpenAI's
  answer for going beyond that is a first-party **tool search** feature: tools can be declared
  "deferred," and either OpenAI's own hosted search picks a relevant subset at request time, or
  the application runs its own lookup (`tool_search_call`/`tool_search_output`) when the right
  subset depends on tenant/session/project state the platform can't know in advance. **Worth
  borrowing directly:** this is the single most concrete, authoritative number found in this
  research — JARVIS should treat "more than ~20 tools visible to the model in one turn" as the
  threshold past which *some* form of retrieval/filtering becomes necessary, not a nice-to-have;
  ~67 tools today is already arguably past a comfortable margin, well before the roadmap's
  eventual ~1000-tool target. **Pitfall:** OpenAI explicitly says tool search is model-gated
  (only certain models support `tool_search`), so a cross-provider router like JARVIS's `AIRouter`
  (Claude + Groq + OpenRouter + Cloudflare) can't lean on a single vendor's hosted tool-search
  feature uniformly — it needs its own provider-agnostic filtering layer if it wants this to work
  the same way regardless of which brain is active that turn. [OpenAI function calling guide](https://developers.openai.com/docs/guides/function-calling), [OpenAI tool search guide](https://developers.openai.com/api/docs/guides/tools-tool-search)

- **LangGraph `bigtool`** — LangChain's own library for "agents that work with massive
  toolsets." Pattern: keep a flat dictionary mapping stable tool IDs to tool implementations
  (the full registry, never sent to the model directly), separately index each tool's
  name+description as embeddings in a vector store, and give the model exactly **one** meta-tool —
  a retrieval tool — that searches that index and returns a small set of matching tool IDs/specs
  for the model to then call. **Worth borrowing:** this generalizes cleanly to JARVIS's own
  `ToolRegistry` — the registry object itself doesn't need to change, only the step where "all
  registered tools" get serialized into the brain's request needs an interposed semantic-search
  filter once the count passes OpenAI's ~20 threshold above; namespacing (e.g. `calendar.*`,
  `reminders.*`, `device.mac.*`) can double as a cheap pre-filter before even reaching embeddings.
  **Pitfall:** a semantic-search tool-selection step is itself a new point of failure — if the
  retrieval step picks the wrong 5-10 tools for an ambiguous request, the model never even sees
  the right tool and silently fails or hallucinates one; this needs its own test coverage (does
  "remind me to call mom" reliably retrieve the reminders tools and not e.g. a phone-calling
  tool?) the same way JARVIS tests `ToolRegistry` today. [LangGraph bigtool overview](https://cobusgreyling.substack.com/p/bigtool-from-langchain), [bigtool repo docs](https://docsearch.algolia.com/mcp/docs/repo/langchain-ai/langgraph-bigtool)

- **LlamaIndex's retrieval-augmented OpenAI agent** — an older but conceptually identical
  pattern predating bigtool: an `ObjectRetriever` fetches a relevant subset of tool objects at
  query time, and only *those* function signatures go into the OpenAI function-calling request,
  explicitly to "remove the complexity of having too many functions to fit in the prompt."
  **Worth borrowing:** confirms the retrieval-before-dispatch pattern isn't a LangChain-specific
  idea but a convergent solution across multiple agent frameworks — reinforces that this is the
  right general shape to build toward rather than inventing a bespoke scheme. **Pitfall:** none
  beyond the one already named above; this is the same pattern as bigtool with the same tradeoff.
  [LlamaIndex retrieval-augmented OpenAI agent](https://docs.llamaindex.ai/en/latest/examples/agent/openai_agent_retrieval/)

- **AutoGPT, as a cautionary tale for scale, not a pattern to copy** — not a tool-registry
  pattern per se, but directly relevant to "many tools without conflicts": academic/practitioner
  write-ups describe AutoGPT's large nested task/tool lists as resource- and time-intensive, prone
  to getting stuck in loops, with unpredictable performance as complexity grows, plus three
  recurring failure modes general to plan-execute agents — **hallucinated tool arguments**,
  **infinite loops** (same tool, slightly different parameters, repeated), and **unintended
  actions**. One commentary's math is a useful gut-check: a 10-step task at 95% per-step success
  is only ~60% reliable end-to-end — compounding error, not tool conflicts, is often the real
  failure mode once a tool roster gets large enough that multi-tool chains become common.
  **Worth borrowing:** JARVIS's existing `MAX_TOOL_ITERATIONS=5` cap and fail-closed
  `ConfirmationService` are already exactly the right category of mitigation AutoGPT-style
  projects lacked — this is confirmation to keep and tighten those guards as the tool count grows,
  not a new idea. **Pitfall for JARVIS specifically:** as the tool count rises toward the roadmap's
  ~1000-tool target, schema validation of tool arguments (per the practitioner guide's
  mitigation list) becomes more important, not less, since a bigger registry raises the odds of
  near-duplicate tools the model confuses, which looks exactly like "hallucinated arguments" in
  practice. [AutoGPT analysis, arXiv PDF](https://arxiv.org/pdf/2605.21497), [LLM failure modes practitioner guide](https://dev.to/theaiprism/building-autonomous-ai-agents-a-practical-guide-for-2026-28c5)

**Concrete pattern for JARVIS:** adopt namespaced tool names now (`calendar.create_event` style,
not ad hoc names) while the registry is still small — it's nearly free today and becomes the
pre-filter layer for semantic retrieval later; treat ~20 tools visible per turn as the real
ceiling and start designing the retrieval-before-dispatch step (LangGraph-bigtool-style: one
meta "find_tool" call, full registry never sent raw to the model) well before the roadmap's
~1000-tool target, not after.

---

## Prioritized list: most actionable ideas to adopt first

Ordered by (impact on existing, documented gaps) × (how cheaply it fits the current
architecture), not by research-area order:

1. **Namespace tool names now** (`domain.action` convention, e.g. `calendar.create_event`,
   `device.mac.open_app`) in `ToolRegistry`/`src/types/tools.ts` — zero behavior change today,
   but it's the prerequisite for every later scaling fix (area 5) and costs almost nothing while
   the registry is still ~67 tools.
2. **Two-stage voice gate design** (local wake-word classifier → only post-wake audio hits
   STT/Claude) as the target architecture *before* building any always-listening feature — bakes
   in both the privacy story and compatibility with JARVIS's existing `AIRouter`/`CostTracker`
   budget model from day one, rather than retrofitting cost controls onto an always-on audio
   stream later (area 2).
3. **Background memory-extraction pass** modeled on mem0's add/search API shape — run after every
   conversation turn regardless of whether a tool explicitly saved anything — directly closes the
   "continuous profile" gap and gives roadmap item #14 (Memory Quality Layer) a concrete shape to
   build toward (area 1).
4. **Domain/entity abstraction over `LocalTool`/`DeviceTool`** (Home-Assistant-style: a shared
   contract like `app.open` that Mac and a future phone agent both implement) — do this *before*
   adding the first phone-control tool, since retrofitting an abstraction after two divergent
   implementations exist is much more expensive (area 3).
5. **Start the retrieval-before-dispatch design now**, even if it's a no-op below ~20 tools —
   stub a single `find_tool` meta-tool path in the Orchestrator so the architecture is ready well
   ahead of the ~1000-tool roadmap target, per OpenAI's own stated ~20-tool guidance and
   LangGraph-bigtool's pattern (area 5).
6. **Tighten the fixed system prompt**: narrow, specific persona language (not generic
   "helpful assistant" copy), an explicit stated local-first/privacy policy, and leading with the
   permission/confirmation/audit model as JARVIS's identity rather than a feature list — then add
   a test that exercises persona/tone persistence across a multi-tool CONFIRM flow, since no
   reference project in this research demonstrably tests for that (area 4).
7. **Keep any future "generic screen/code control" fallback (computer-use-style or Open-Interpreter-
   style code execution) strictly behind the existing CONFIRM/DANGEROUS gate**, and prefer adding
   more typed Swift tools over expanding screen-control scope — multiple independent sources
   converge on typed tools being faster and more reliable than screenshot-driven control, and
   generic code execution is the highest-blast-radius pattern found in this entire research pass
   (area 3).
8. **Add schema/argument validation and an iteration-cap discipline as the tool count grows**,
   not just at 1000 tools — AutoGPT-style compounding-error math (95% per-step → ~60% over 10
   steps) means the existing `MAX_TOOL_ITERATIONS=5` cap and fail-closed `ConfirmationService`
   need to scale in rigor alongside tool count, not stay static while the registry grows 10-20x
   (area 5).
