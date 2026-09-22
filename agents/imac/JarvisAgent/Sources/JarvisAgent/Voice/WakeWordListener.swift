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
final class WakeWordListener: NSObject, SFSpeechRecognizerDelegate {
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
    private static let silenceThresholdSeconds: TimeInterval = 1.5

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
        let isHebrew = text.unicodeScalars.contains { (0x0590...0x05FF).contains($0.value) }
        if let voice = Self.bestAvailableVoice(languagePrefix: isHebrew ? "he" : "en") {
            utterance.voice = voice
        }
        synthesizer.speak(utterance)
    }

    /// Picks the highest-fidelity installed voice for a language: premium
    /// over enhanced over the plain default quality, matched by language
    /// prefix (e.g. "en" matches both "en-US" and "en-GB") since the
    /// exact best-quality voice's region code isn't known in advance.
    private static func bestAvailableVoice(languagePrefix: String) -> AVSpeechSynthesisVoice? {
        let candidates = AVSpeechSynthesisVoice.speechVoices()
            .filter { $0.language.hasPrefix(languagePrefix) }
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
