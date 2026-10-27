// REQUIRES REAL macOS VALIDATION — Speech/AVAudioEngine cannot be
// exercised outside a real macOS runtime with microphone/speech
// permissions granted. Never compiled or run in this environment.

import AVFoundation
import Speech

/// Always-on "Hey JARVIS" wake-word listening: continuously transcribes
/// the microphone on-device via Apple's own Speech framework (no
/// third-party wake-word engine, no cloud dependency, no API key —
/// matching this project's "as close to free as possible" goal the same
/// way GET_WEATHER picked Open-Meteo over a paid weather API), watches
/// the running transcript for the wake phrase, and hands everything said
/// after it to `onTranscriptReady` once the user pauses.
///
/// Deliberately full continuous transcription rather than a dedicated
/// low-power wake-word model: this is what ships free and in the box.
/// The tradeoff (more CPU than a purpose-built wake-word engine) is
/// acceptable for a Mac that's usually plugged in; nothing here is ever
/// sent anywhere until the wake phrase is actually heard.
final class WakeWordListener: NSObject, SFSpeechRecognizerDelegate, AVSpeechSynthesizerDelegate {
    /// Called with the text spoken after the wake phrase, once a pause is
    /// detected, plus which language the reply should be forced into:
    /// "en", "he", or "" (no forced language — let Claude auto-detect, as
    /// it does everywhere else) for a clap-triggered command with no
    /// wake phrase to signal a language from.
    var onTranscriptReady: ((String, String) -> Void)?

    /// Two distinct wake phrases, deliberately mapped to two distinct
    /// forced reply languages — "Hey/Hi/OK JARVIS" always gets an English
    /// reply, "Jarvis Shomea"/"ג'רוויס שומע" always gets a Hebrew one,
    /// regardless of what language the command itself is spoken in. Matched
    /// case-insensitively, loose on purpose (a few natural variants) since
    /// real speech recognition rarely produces the exact same wording
    /// twice. NOTE: the recognizer below is locked to en-US (see its own
    /// comment) — a genuinely Hebrew utterance is unlikely to transcribe
    /// as Hebrew script at all, so the Hebrew-lettered patterns here are
    /// mostly a no-op today; "jarvis shomea"/"jarvis shoma" (said in an
    /// English-sounding way) is what actually reaches this list in
    /// practice until multi-locale recognition is added.
    private static let englishWakePhrases = ["hey jarvis", "hi jarvis", "ok jarvis"]
    private static let hebrewWakePhrases = ["jarvis shomea", "jarvis shoma", "ג'רוויס שומע", "גרוויס שומע", "היי ג'רוויס", "היי גרוויס"]
    private static let wakePhrasePatterns = englishWakePhrases + hebrewWakePhrases

    private let audioEngine = AVAudioEngine()
    private let speechRecognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
    private let synthesizer = AVSpeechSynthesizer()

    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?

    private var lastTranscriptUpdate = Date()
    private var pendingCommandText: String?
    /// Set the moment the wake phrase itself is heard with nothing after
    /// it yet; cleared once either a command follows (see
    /// `pendingCommandText`) or the silence check speaks the standing
    /// greeting instead. Without this, "Hey JARVIS" said alone did
    /// nothing at all — `checkForSilence` only ever fired for a
    /// non-empty command.
    private var awaitingCommandAfterWake = false
    /// Which wake phrase bucket matched — "en" or "he" — used both for the
    /// bare-wake-phrase standing greeting and, once a command follows, the
    /// language directive sent to Core in `onTranscriptReady`.
    private var pendingCommandLanguage = "en"
    private var silenceCheckTimer: Timer?
    /// Diagnostics only (roadmap #71): true once the wake phrase has been
    /// announced via `print()` for the current recognition-task cycle, so
    /// the terminal gets one clear "wake phrase heard" line instead of one
    /// per partial-transcript update (which fires many times a second
    /// while the recognizer keeps refining the same match). Reset every
    /// time `beginRecognitionTask()` starts a fresh cycle.
    private var hasAnnouncedWakePhraseThisCycle = false

    /// The specific voice to prefer for English speech, before falling back
    /// to "any Premium-tier voice installed" and then "any Enhanced-tier
    /// voice installed" (see `bestAvailableVoice`). Named here rather than
    /// buried inline so David can swap it for a different voice with a
    /// one-line change once he's actually heard this on real hardware —
    /// per CLAUDE.md wishlist #21, he wants something that sounds genuinely
    /// human (his reference point is ChatGPT's voice mode), not a cloned
    /// voice and not whatever system voice happens to be installed.
    ///
    /// "Ava (Premium)" is Apple's own Premium-tier US English voice
    /// (identifier confirmed via Apple's own AVSpeechSynthesisVoice API
    /// surface and widely corroborated third-party voice listings as of
    /// macOS Sequoia/macOS 15) and is consistently cited as one of the most
    /// natural-sounding Premium voices Apple ships — a reasonable default
    /// pending David's own listening test. It is NOT guaranteed to be
    /// installed: Premium/Enhanced voices are an extra download (System
    /// Settings → Accessibility → Spoken Content → Voices), so
    /// `bestAvailableVoice` only uses this identifier when it's actually
    /// present in `AVSpeechSynthesisVoice.speechVoices()`, and otherwise
    /// falls through to the quality-tier search below.
    ///
    /// No equivalent constant for Hebrew: as of this writing, Apple ships
    /// only a Default-quality Hebrew voice ("Carmit") with no Enhanced or
    /// Premium tier, so Hebrew always falls through to the quality-tier
    /// search (and from there to the plain default) regardless.
    private static let preferredEnglishVoiceIdentifier = "com.apple.voice.premium.en-US.Ava"

    /// How much to lower `AVSpeechUtterance.pitchMultiplier` below its
    /// default of 1.0. Apple documents the valid range as 0.5–2.0; 0.9 is a
    /// light, conservative drop chosen to read as a deeper, calmer,
    /// less "chipmunk-y"/synthetic tone without pushing far enough to sound
    /// distorted or obviously pitch-shifted — the failure mode of leaning
    /// much below ~0.85 on a system voice. A named constant for the same
    /// reason as the voice identifier above: easy for David to nudge once
    /// he's heard it for real.
    private static let pitchMultiplier: Float = 0.9

    /// Spoken when the wake phrase is heard with no command following it —
    /// "Hey JARVIS" alone should always get an answer, not silence.
    private static let wakeOnlyGreetingEnglish = "Hey David, how can I help you today?"
    private static let wakeOnlyGreetingHebrew = "היי דיוויד, איך אפשר לעזור?"
    /// Spoken immediately on a detected clap, before any command is heard —
    /// a clap alone (no "Hey JARVIS" needed) should get an instant reply.
    private static let clapGreeting = "Yes? What do you need?"

    /// Whether a hand clap can wake JARVIS instead of the wake phrase.
    ///
    /// Off unless `JARVIS_CLAP_TO_ACTIVATE=1` is set in the Agent's
    /// environment. `ClapDetector` recognises a clap only by its shape — a
    /// fast, loud transient after relative quiet — and in a normal office
    /// that describes a dropped pen, a door, a keyboard slammed, or
    /// JARVIS's own greeting coming back through the speakers. Each false
    /// positive doesn't just say "Yes? What do you need?" into an empty
    /// room: it also restarts the recognition task and puts the listener
    /// in clap-command mode, where the *whole* next transcript is treated
    /// as a command and the wake phrase is never looked for. So a room
    /// noisy enough to trigger claps takes "Hey JARVIS" down with it,
    /// which is exactly what happened on David's Mac — 20 claps, zero wake
    /// phrases heard. Until the detector can tell a clap from a door, the
    /// wake phrase alone is the reliable path.
    private static let clapToActivateEnabled = ProcessInfo.processInfo.environment["JARVIS_CLAP_TO_ACTIVATE"] == "1"

    private let clapDetector = ClapDetector()
    /// True from the moment a clap is detected until either a command
    /// follows it (dispatched the same way a wake-phrase command is) or
    /// `clapCommandModeTimeout` elapses with nothing said. Distinct from
    /// `awaitingCommandAfterWake`: a clap has no wake phrase in the
    /// transcript to strip, so the *entire* next transcript is the
    /// command, not just the text after a matched phrase.
    private var clapCommandModeActive = false
    private var clapCommandModeStartedAt = Date.distantPast
    private static let clapCommandModeTimeout: TimeInterval = 8.0

    /// How long to wait after speech stops updating before treating whatever
    /// followed the wake phrase as the complete command.
    ///
    /// Raised from 1.5s to 2.5s (2026-10-27) after real hands-on testing: 1.5s
    /// repeatedly cut off natural speech mid-sentence (especially composing a
    /// sentence, or switching between Hebrew/English), causing the wake-only
    /// "how can I help you" greeting to fire before an actual command was
    /// captured — the user never reached a real Core round-trip. Still short
    /// enough to feel responsive once speech has genuinely stopped.
    private static let silenceThresholdSeconds: TimeInterval = 2.5

    /// True from the moment a proactive (JARVIS-initiated) announcement
    /// finishes speaking until either something is captured or
    /// `proactiveReplyTimeoutSeconds` elapses with nothing heard. Distinct
    /// from `awaitingCommandAfterWake`/`clapCommandModeActive`: this
    /// capture requires no wake phrase and no clap — the device itself
    /// just spoke first, so the very next thing heard (if anything) is the
    /// candidate reply, full stop. See `speakProactiveAnnouncement`.
    private var proactiveReplyModeActive = false
    private var proactiveReplyStartedAt = Date.distantPast
    private var proactiveReplyTimeoutSeconds: TimeInterval = 20.0
    private var pendingProactiveReplyText: String?
    /// Called with whatever was captured, or `nil` if the reply window
    /// elapsed with nothing heard. Core (not this Agent) is responsible for
    /// deciding whether the captured text actually authenticates as the
    /// owner — see `ProactiveReplyPayload`'s own doc comment.
    private var proactiveReplyCallback: ((String?) -> Void)?

    /// Continuous conversation mode (2026-10-27) — see CLAUDE.md's same-dated
    /// section for the full research writeup this is based on. David's
    /// explicit, repeated complaint tonight: he had to say "Hey JARVIS"
    /// before every single turn, making a real back-and-forth conversation
    /// impossible. This opens a short follow-up listening window, with no
    /// wake phrase required, right after JARVIS finishes speaking a REAL
    /// reply from Core (see `speakReply`, used only for actual `voice.reply`
    /// messages — never for the wake-only greeting, the clap greeting, or a
    /// proactive announcement, each of which has its own, already-correct
    /// listening behavior that must not be double-triggered by this).
    ///
    /// Window length: real documented precedent, not invented from nothing.
    /// Amazon's Alexa "Follow-Up Mode" (shipped 2018) listens for 5 seconds
    /// after a response before requiring the wake word again — consistently
    /// reported across its own contemporary tech-press coverage (e.g.
    /// TechRadar, How-To Geek). Google's "Continued Conversation" (also
    /// 2018) uses a published ~6-8 second window per Google's own
    /// spokesperson statements (Voicebot.ai, 9to5Google). Both are real,
    /// shipped, widely-used features, not just blog opinion — confidence:
    /// documented via contemporary primary tech coverage, though neither
    /// company has republished an updated number since 2018-2019, so an
    /// unverified assumption that this hasn't changed since is baked in.
    /// `conversationFollowUpTimeoutSeconds` is set to 6 seconds — squarely
    /// inside that well-precedented 5-8s range, not a number invented for
    /// this codebase.
    ///
    /// Distinct from `silenceThresholdSeconds`: that governs how long to
    /// wait *after speech has started* before treating it as a complete
    /// utterance (same role Alexa/Google's own end-of-utterance detection
    /// plays). This window instead bounds how long to wait, with *nothing
    /// said yet*, before giving up and requiring the wake phrase again —
    /// exactly the same two-timer shape `speakProactiveAnnouncement`
    /// already uses for its own reply-capture window, reused here rather
    /// than inventing a third pattern.
    private var conversationFollowUpModeActive = false
    private var conversationFollowUpStartedAt = Date.distantPast
    private static let conversationFollowUpTimeoutSeconds: TimeInterval = 6.0
    /// Set by `speakReply` right before `speak()` is called, and consumed
    /// (cleared) the moment that utterance either finishes normally
    /// (`speechSynthesizer(_:didFinish:)`, which then opens the follow-up
    /// window) or is cut short by a barge-in (`stopSpeakingForBargeIn`,
    /// which must NOT open it — see that method's own note). Without this
    /// flag, `didFinish` would have no way to tell "a real Core reply just
    /// finished speaking" apart from every other kind of utterance this
    /// listener speaks (greetings, clap ack, proactive announcements), each
    /// of which already has its own correct post-speech behavior.
    private var pendingConversationFollowUpAfterSpeech = false

    /// True from the moment `speak()` hands an utterance to
    /// `AVSpeechSynthesizer` until it finishes, is cancelled, or is
    /// stopped by a barge-in — see `speak()`, the
    /// `AVSpeechSynthesizerDelegate` callbacks below, and
    /// `stopSpeakingForBargeIn()`.
    private var isSpeaking = false
    /// The exact text currently being spoken, tracked so
    /// `SpeechEchoClassifier` has something to compare a concurrently
    /// heard transcript against. `nil` whenever `isSpeaking` is false.
    private var currentlySpokenText: String?

    override init() {
        super.init()
        // Needed for self-echo rejection / barge-in (see
        // `handleTranscriptUpdate`): without this delegate, nothing ever
        // clears `isSpeaking`/`currentlySpokenText` when an utterance
        // finishes on its own, and the classifier would think JARVIS was
        // still speaking forever after its first reply.
        synthesizer.delegate = self
    }

    func start() {
        // print() here is deliberate, not a duplicate of the os_log call
        // below it (roadmap #71 — wake diagnostics): `os_log`/`Logger`
        // output only shows up in Console.app/`log stream`, invisible in a
        // plain terminal session running this executable directly —
        // exactly the gap JARVIS_ROADMAP_AUDIT.md's Phase 11 notes
        // identifies as the single most likely cause of "Hey JARVIS
        // producing zero log output" reports. `main.swift`'s own
        // connection logging already does this (`print(...)` next to
        // `Logger.shared.log(...)`); this listener didn't, until now.
        print("[JarvisAgent] WakeWordListener: requesting Speech + microphone authorization...")
        SFSpeechRecognizer.requestAuthorization { [weak self] authStatus in
            guard authStatus == .authorized else {
                let message = "Speech recognition not authorized (\(authStatus.rawValue)) — wake-word listening disabled."
                print("[JarvisAgent] \(message)")
                Logger.shared.log(message)
                return
            }
            AVCaptureDevice.requestAccess(for: .audio) { granted in
                guard granted else {
                    let message = "Microphone access not granted — wake-word listening disabled."
                    print("[JarvisAgent] \(message)")
                    Logger.shared.log(message)
                    return
                }
                DispatchQueue.main.async {
                    self?.startListening()
                }
            }
        }
    }

    func stop() {
        silenceCheckTimer?.invalidate()
        silenceCheckTimer = nil
        recognitionTask?.cancel()
        recognitionRequest?.endAudio()
        if audioEngine.isRunning {
            audioEngine.stop()
            audioEngine.inputNode.removeTap(onBus: 0)
        }
    }

    /// Speaks a reply aloud — the response to a voice.reply from Core.
    /// Without an explicit voice, AVSpeechSynthesizer falls back to the
    /// system's default language voice regardless of what the text is
    /// actually in — a Hebrew reply came out in an English voice
    /// whenever the Mac's own language wasn't set to Hebrew. Picks the
    /// voice from the reply's own script instead (same idea as the phone
    /// gateway's and the browser voice mode's per-language selection).
    ///
    /// This is the actual "Hey JARVIS" voice the user talks to day to
    /// day — distinct from (and more important than) the Twilio phone
    /// gateway's voice. `AVSpeechSynthesisVoice(language:)` alone picks
    /// whatever the *system default* voice happens to be for that
    /// language, which on a fresh macOS install is almost always the
    /// bundled ".Compact" quality voice — deliberately low-fidelity
    /// (small download size), and the reason this sounded robotic/"AI"
    /// rather than human even though a language-matched voice was
    /// already being selected. `bestAvailableVoice` instead prefers a
    /// `.premium` or `.enhanced` quality voice for the language when one
    /// is installed, only falling back to the plain default if neither
    /// is available on this Mac.
    func speak(_ text: String) {
        print("[JarvisAgent] Speaking: \"\(text)\"")
        let utterance = AVSpeechUtterance(string: text)
        utterance.rate = AVSpeechUtteranceDefaultSpeechRate
        // A light, deliberate drop from the default 1.0 for a deeper, more
        // natural tone — see `pitchMultiplier`'s own doc comment for why
        // 0.9 specifically. Rate is left at the system default: nothing in
        // research suggested the default conversational rate reads as
        // unnaturally fast or slow, so it isn't touched without a real
        // reason to.
        utterance.pitchMultiplier = Self.pitchMultiplier
        let isHebrew = text.unicodeScalars.contains { (0x0590...0x05FF).contains($0.value) }
        if let voice = Self.bestAvailableVoice(languagePrefix: isHebrew ? "he" : "en") {
            utterance.voice = voice
        }
        // Tracked for self-echo rejection / barge-in — see
        // `handleTranscriptUpdate` and `SpeechEchoClassifier`. Set before
        // `speak(_:)` is called (rather than in a delegate "did start"
        // callback) so there's no window where the recognizer could pick
        // up the very first word of the utterance before this is in
        // place.
        isSpeaking = true
        currentlySpokenText = text
        synthesizer.speak(utterance)
    }

    /// Stops JARVIS mid-sentence because a concurrently heard transcript
    /// was classified as genuine new user speech (a cancel command or
    /// otherwise) rather than JARVIS hearing its own voice — see
    /// `handleTranscriptUpdate`. `AVSpeechSynthesizer.stopSpeaking(at:)`
    /// (passing `.immediate`) is the real, current API for this; it does
    /// not itself fire `didCancel`'s delegate callback reliably across all
    /// macOS versions in every case, so this clears the tracking state
    /// directly rather than relying solely on the delegate.
    private func stopSpeakingForBargeIn() {
        guard isSpeaking else { return }
        synthesizer.stopSpeaking(at: .immediate)
        isSpeaking = false
        currentlySpokenText = nil
        // A barge-in means the user already started talking over JARVIS —
        // that speech is handled by the normal fall-through in
        // `handleTranscriptUpdate` right after this call returns, so there
        // is nothing left to "follow up" on: opening the follow-up window
        // here as well would just be a second, redundant listening mode
        // layered on top of speech that's already mid-capture.
        pendingConversationFollowUpAfterSpeech = false
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        isSpeaking = false
        currentlySpokenText = nil
        if pendingConversationFollowUpAfterSpeech {
            pendingConversationFollowUpAfterSpeech = false
            beginConversationFollowUp()
        }
    }

    /// Speaks a REAL reply from Core (a `voice.reply`, i.e. an actual
    /// answer to something the user asked) — as opposed to this listener's
    /// own internal greetings/acknowledgements, which keep calling `speak`
    /// directly. Opens the continuous-conversation follow-up window once
    /// this finishes speaking normally; see `conversationFollowUpModeActive`'s
    /// own doc comment for the full reasoning and the window length's
    /// sourcing.
    func speakReply(_ text: String) {
        pendingConversationFollowUpAfterSpeech = true
        speak(text)
    }

    /// Opens the no-wake-phrase follow-up window after a real reply has
    /// finished playing. Mirrors `speakProactiveAnnouncement`'s own
    /// fresh-buffer/fresh-clock pattern exactly, rather than inventing a
    /// different shape for what is functionally the same kind of window.
    private func beginConversationFollowUp() {
        conversationFollowUpModeActive = true
        conversationFollowUpStartedAt = Date()
        pendingCommandText = nil
        lastTranscriptUpdate = Date()
        // Fresh transcript buffer so nothing said before/during the reply
        // itself lingers into the follow-up capture.
        beginRecognitionTask()
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        isSpeaking = false
        currentlySpokenText = nil
    }

    /// Speaks a proactive (JARVIS-initiated) announcement aloud, then
    /// listens for whatever is said next within `replyWindowMs` as a
    /// candidate reply — unlike a normal conversational turn, no wake
    /// phrase or clap is required here, since the device itself just
    /// interrupted the user, not the other way around. `onCaptured` fires
    /// exactly once, with the captured text or `nil` if the window elapses
    /// with nothing heard.
    ///
    /// This Agent never decides whether the captured reply is really
    /// David — it only reports what was literally heard; Core's
    /// SpeakerAuthenticator (passphrase matching today, see
    /// `src/core/confirmation/SpeakerAuthenticator.ts`) makes that call.
    func speakProactiveAnnouncement(_ text: String, replyWindowMs: Int, onCaptured: @escaping (String?) -> Void) {
        speak(text)
        pendingProactiveReplyText = nil
        proactiveReplyCallback = onCaptured
        proactiveReplyTimeoutSeconds = max(1.0, Double(replyWindowMs) / 1000.0)
        proactiveReplyStartedAt = Date()
        proactiveReplyModeActive = true
        lastTranscriptUpdate = Date()
        // Fresh transcript buffer so nothing said before this announcement
        // lingers into the capture window.
        beginRecognitionTask()
    }

    /// Picks the highest-fidelity installed voice for a language: premium
    /// over enhanced over the plain default quality, matched by language
    /// prefix (e.g. "en" matches both "en-US" and "en-GB") since the
    /// exact best-quality voice's region code isn't known in advance.
    private static func bestAvailableVoice(languagePrefix: String) -> AVSpeechSynthesisVoice? {
        let candidates = AVSpeechSynthesisVoice.speechVoices()
            .filter { $0.language.hasPrefix(languagePrefix) }
        // The specific named voice first, but only if it's actually
        // installed on this Mac (Premium/Enhanced voices are an extra
        // download, never assumed present) — otherwise fall through to the
        // generic quality-tier search exactly as before.
        if languagePrefix == "en",
           let preferred = candidates.first(where: { $0.identifier == preferredEnglishVoiceIdentifier }) {
            return preferred
        }
        if let premium = candidates.first(where: { $0.quality == .premium }) {
            return premium
        }
        if let enhanced = candidates.first(where: { $0.quality == .enhanced }) {
            return enhanced
        }
        return AVSpeechSynthesisVoice(language: languagePrefix == "he" ? "he-IL" : "en-US")
    }

    private func startListening() {
        guard let speechRecognizer, speechRecognizer.isAvailable else {
            let message = "Speech recognizer unavailable — wake-word listening disabled."
            print("[JarvisAgent] \(message)")
            Logger.shared.log(message)
            return
        }
        speechRecognizer.delegate = self

        let inputNode = audioEngine.inputNode
        let recordingFormat = inputNode.outputFormat(forBus: 0)
        print("[JarvisAgent] WakeWordListener: input format \(recordingFormat)")
        inputNode.installTap(onBus: 0, bufferSize: 1024, format: recordingFormat) { [weak self] buffer, _ in
            self?.recognitionRequest?.append(buffer)
            // Skipped entirely rather than detected-and-ignored: with the
            // feature off there's no reason to run peak analysis on every
            // buffer, and nothing downstream can act on the result.
            guard Self.clapToActivateEnabled else { return }
            if self?.clapDetector.process(buffer) == true {
                DispatchQueue.main.async {
                    self?.handleClapDetected()
                }
            }
        }

        audioEngine.prepare()
        do {
            try audioEngine.start()
        } catch {
            let message = "Failed to start audio engine: \(error.localizedDescription)"
            print("[JarvisAgent] \(message)")
            Logger.shared.log(message)
            return
        }

        beginRecognitionTask()

        silenceCheckTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
            self?.checkForSilence()
        }
        print("[JarvisAgent] Wake-word listening started — say \"Hey JARVIS\"\(Self.clapToActivateEnabled ? " or clap" : "").")
        Logger.shared.log("Wake-word listening started.")
    }

    /// Recognition tasks accumulate transcript for their whole lifetime,
    /// so this is restarted every time a command is dispatched (or the
    /// listener otherwise needs a clean slate) — the audio engine itself
    /// keeps running throughout, so the mic never actually drops.
    private func beginRecognitionTask() {
        recognitionTask?.cancel()
        recognitionTask = nil
        hasAnnouncedWakePhraseThisCycle = false

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        // On-device recognition, when available, keeps this fully local —
        // no audio leaves the machine for anything short of the wake
        // phrase actually being heard.
        if #available(macOS 13, *) {
            request.requiresOnDeviceRecognition = speechRecognizer?.supportsOnDeviceRecognition ?? false
        }
        recognitionRequest = request

        recognitionTask = speechRecognizer?.recognitionTask(with: request) { [weak self] result, error in
            guard let self else { return }
            if let result {
                self.handleTranscriptUpdate(result.bestTranscription.formattedString)
            }
            if error != nil || result?.isFinal == true {
                // The task ends itself after ~1 minute of continuous audio
                // regardless of silence — restart transparently so
                // listening never actually stops.
                self.beginRecognitionTask()
            }
        }
    }

    /// Fired on a detected clap (see ClapDetector) — the audio-tap
    /// equivalent of `handleTranscriptUpdate` matching a wake phrase.
    /// Ignored while already in an active clap-command window so a
    /// clap's own decay/room echo, or a second clap David makes on
    /// purpose per "once or twice," doesn't reset the greeting or the
    /// listening window.
    private func handleClapDetected() {
        guard !clapCommandModeActive else { return }
        print("[JarvisAgent] Clap detected — listening for a command.")
        clapCommandModeActive = true
        clapCommandModeStartedAt = Date()
        lastTranscriptUpdate = Date()
        speak(Self.clapGreeting)
        // Fresh transcript buffer so whatever's said next is the command
        // on its own, not appended to anything already in the buffer.
        beginRecognitionTask()
    }

    private func handleTranscriptUpdate(_ transcript: String) {
        lastTranscriptUpdate = Date()

        // Self-echo rejection + barge-in. The microphone tap never stops
        // while JARVIS itself is speaking — a normal spoken reply, the
        // clap/wake-phrase greetings, and especially PR #146's
        // `speakProactiveAnnouncement` (JARVIS speaks first, unprompted,
        // then listens for a reply with no wake phrase required) all run
        // the recognizer and the synthesizer at the same time. Without
        // this check, JARVIS's own voice coming back through the mic gets
        // treated as whatever the current listening mode is waiting for —
        // a wake phrase, a clap-triggered command, or (most visibly) a
        // proactive-reply capture. See `SpeechEchoClassifier` for the
        // actual heuristic and its honest limitations.
        if isSpeaking {
            switch SpeechEchoClassifier.classify(heardTranscript: transcript, currentlySpokenText: currentlySpokenText) {
            case .likelyEcho:
                // Almost certainly JARVIS hearing itself. Don't let this
                // reach any of the capture logic below — forwarding it
                // would risk a false proactive-reply/clap-command capture,
                // or JARVIS re-triggering on its own voice.
                return
            case .cancelCommand, .genuineUserSpeech:
                // The user said something real while JARVIS was still
                // talking. Stop talking immediately and let whatever they
                // said fall through to the normal handling below in this
                // same call, rather than losing it while waiting for the
                // next transcript update.
                print("[JarvisAgent] Barge-in: \"\(transcript)\" read as real user speech, not an echo — stopping speech.")
                stopSpeakingForBargeIn()
            }
        }

        if proactiveReplyModeActive {
            let trimmed = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
            pendingProactiveReplyText = trimmed.isEmpty ? nil : trimmed
            return
        }

        if conversationFollowUpModeActive {
            // A wake phrase said during the follow-up window should still
            // work exactly like an ordinary wake-triggered turn, not get
            // folded verbatim into the follow-up capture (which would send
            // Core a transcript still containing the literal words "hey
            // jarvis"). Close out follow-up mode here and fall through to
            // the normal wake-phrase handling below, rather than returning —
            // this is the one case in this method that intentionally
            // doesn't return early from its own branch.
            let lowered = transcript.lowercased()
            if Self.wakePhrasePatterns.contains(where: { lowered.contains($0) }) {
                conversationFollowUpModeActive = false
            } else {
                let trimmed = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
                pendingCommandText = trimmed.isEmpty ? nil : trimmed
                return
            }
        }

        if clapCommandModeActive {
            let trimmed = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
            pendingCommandText = trimmed.isEmpty ? nil : trimmed
            return
        }

        let lowered = transcript.lowercased()
        guard
            let matchedPhrase = Self.wakePhrasePatterns.first(where: { lowered.contains($0) }),
            let range = lowered.range(of: matchedPhrase)
        else {
            return
        }

        if !hasAnnouncedWakePhraseThisCycle {
            hasAnnouncedWakePhraseThisCycle = true
            print("[JarvisAgent] Wake phrase heard: \"\(matchedPhrase)\" — listening for a command.")
        }

        let afterWakePhrase = String(transcript[range.upperBound...]).trimmingCharacters(in: .whitespacesAndNewlines)
        pendingCommandText = afterWakePhrase.isEmpty ? nil : afterWakePhrase
        pendingCommandLanguage = Self.hebrewWakePhrases.contains(matchedPhrase) ? "he" : "en"
        awaitingCommandAfterWake = afterWakePhrase.isEmpty
    }

    private func checkForSilence() {
        // Handled first and returns unconditionally either way: while
        // awaiting a proactive reply, nothing said should ever fall through
        // to the wake-phrase/clap handling below, since this capture
        // requires neither.
        if proactiveReplyModeActive {
            if let pendingProactiveReplyText, !pendingProactiveReplyText.isEmpty,
               Date().timeIntervalSince(lastTranscriptUpdate) >= Self.silenceThresholdSeconds {
                let captured = pendingProactiveReplyText
                self.pendingProactiveReplyText = nil
                proactiveReplyModeActive = false
                let callback = proactiveReplyCallback
                proactiveReplyCallback = nil
                print("[JarvisAgent] Proactive reply captured: \"\(captured)\"")
                callback?(captured)
                beginRecognitionTask()
                return
            }
            if Date().timeIntervalSince(proactiveReplyStartedAt) >= proactiveReplyTimeoutSeconds {
                proactiveReplyModeActive = false
                pendingProactiveReplyText = nil
                let callback = proactiveReplyCallback
                proactiveReplyCallback = nil
                print("[JarvisAgent] Proactive reply window elapsed with nothing heard.")
                callback?(nil)
                beginRecognitionTask()
                return
            }
            return
        }

        // Handled next, same two-part shape as the proactive-reply block
        // above (a bounded "did anything start" window, then the normal
        // silence-after-speech capture once something has): a continuous-
        // conversation follow-up command is sent straight to Core via
        // `onTranscriptReady`, exactly like any other transcript — unlike
        // the proactive-reply path, there's no separate authentication
        // decision to make here, so no dedicated callback is needed.
        if conversationFollowUpModeActive {
            if let pendingCommandText, !pendingCommandText.isEmpty,
               Date().timeIntervalSince(lastTranscriptUpdate) >= Self.silenceThresholdSeconds {
                let captured = pendingCommandText
                self.pendingCommandText = nil
                conversationFollowUpModeActive = false
                print("[JarvisAgent] Conversation follow-up command captured (no wake phrase needed): \"\(captured)\"")
                // No wake phrase said this turn, so there's no forced-
                // language signal to carry — same "" auto-detect choice
                // already made for clap-triggered commands.
                onTranscriptReady?(captured, "")
                beginRecognitionTask()
                return
            }
            if Date().timeIntervalSince(conversationFollowUpStartedAt) >= Self.conversationFollowUpTimeoutSeconds {
                conversationFollowUpModeActive = false
                pendingCommandText = nil
                print("[JarvisAgent] Conversation follow-up window elapsed with nothing heard — \"Hey JARVIS\" required again.")
                beginRecognitionTask()
                return
            }
            return
        }

        // A clap with nothing ever said after it shouldn't leave the
        // listener stuck treating the next ordinary sentence (with no
        // wake phrase in it) as a command — time it out independently of
        // the shorter per-word silence threshold below.
        if clapCommandModeActive, pendingCommandText == nil,
           Date().timeIntervalSince(clapCommandModeStartedAt) >= Self.clapCommandModeTimeout {
            clapCommandModeActive = false
        }

        guard Date().timeIntervalSince(lastTranscriptUpdate) >= Self.silenceThresholdSeconds else { return }

        if let pendingCommandText, !pendingCommandText.isEmpty {
            self.pendingCommandText = nil
            let wasClapTriggered = clapCommandModeActive
            print("[JarvisAgent] Command captured (\(wasClapTriggered ? "clap" : "wake phrase")-triggered), sending to Core: \"\(pendingCommandText)\"")
            awaitingCommandAfterWake = false
            clapCommandModeActive = false
            // A clap has no wake phrase to signal a language from — pass
            // "" so Core lets Claude auto-detect, same as every other
            // channel, instead of forcing whatever `pendingCommandLanguage`
            // happens to still hold from a previous wake-phrase turn.
            onTranscriptReady?(pendingCommandText, wasClapTriggered ? "" : pendingCommandLanguage)
            // Fresh transcript buffer for the next wake phrase, so the
            // just-dispatched command's words can't linger and get
            // matched again.
            beginRecognitionTask()
            return
        }

        if awaitingCommandAfterWake {
            awaitingCommandAfterWake = false
            speak(pendingCommandLanguage == "he" ? Self.wakeOnlyGreetingHebrew : Self.wakeOnlyGreetingEnglish)
            beginRecognitionTask()
        }
    }
}
