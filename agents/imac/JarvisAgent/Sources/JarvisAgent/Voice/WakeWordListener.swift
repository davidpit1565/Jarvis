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
    /// Called with the text spoken after the wake phrase, once a pause is detected.
    var onTranscriptReady: ((String) -> Void)?

    /// English + Hebrew wake phrases — matched case-insensitively against
    /// the running transcript. Loose on purpose (a few natural variants)
    /// since real speech recognition rarely produces the exact same
    /// wording twice.
    private static let wakePhrasePatterns = ["hey jarvis", "hi jarvis", "ok jarvis", "היי ג'רוויס", "היי גרוויס"]

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
    private var wakePhraseWasHebrew = false
    private var silenceCheckTimer: Timer?

    /// Spoken when the wake phrase is heard with no command following it —
    /// "Hey JARVIS" alone should always get an answer, not silence.
    private static let wakeOnlyGreetingEnglish = "Hey David, how can I help you today?"
    private static let wakeOnlyGreetingHebrew = "היי דיוויד, איך אפשר לעזור?"
    /// Spoken immediately on a detected clap, before any command is heard —
    /// a clap alone (no "Hey JARVIS" needed) should get an instant reply.
    private static let clapGreeting = "Yes? What do you need?"

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
        SFSpeechRecognizer.requestAuthorization { [weak self] authStatus in
            guard authStatus == .authorized else {
                Logger.shared.log("Speech recognition not authorized (\(authStatus.rawValue)) — wake-word listening disabled.")
                return
            }
            AVCaptureDevice.requestAccess(for: .audio) { granted in
                guard granted else {
                    Logger.shared.log("Microphone access not granted — wake-word listening disabled.")
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
    func speak(_ text: String) {
        let utterance = AVSpeechUtterance(string: text)
        utterance.rate = AVSpeechUtteranceDefaultSpeechRate
        let isHebrew = text.unicodeScalars.contains { (0x0590...0x05FF).contains($0.value) }
        if let voice = AVSpeechSynthesisVoice(language: isHebrew ? "he-IL" : "en-US") {
            utterance.voice = voice
        }
        synthesizer.speak(utterance)
    }

    private func startListening() {
        guard let speechRecognizer, speechRecognizer.isAvailable else {
            Logger.shared.log("Speech recognizer unavailable — wake-word listening disabled.")
            return
        }
        speechRecognizer.delegate = self

        let inputNode = audioEngine.inputNode
        let recordingFormat = inputNode.outputFormat(forBus: 0)
        inputNode.installTap(onBus: 0, bufferSize: 1024, format: recordingFormat) { [weak self] buffer, _ in
            self?.recognitionRequest?.append(buffer)
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
            Logger.shared.log("Failed to start audio engine: \(error.localizedDescription)")
            return
        }

        beginRecognitionTask()

        silenceCheckTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
            self?.checkForSilence()
        }
        Logger.shared.log("Wake-word listening started.")
    }

    /// Recognition tasks accumulate transcript for their whole lifetime,
    /// so this is restarted every time a command is dispatched (or the
    /// listener otherwise needs a clean slate) — the audio engine itself
    /// keeps running throughout, so the mic never actually drops.
    private func beginRecognitionTask() {
        recognitionTask?.cancel()
        recognitionTask = nil

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

        let afterWakePhrase = String(transcript[range.upperBound...]).trimmingCharacters(in: .whitespacesAndNewlines)
        pendingCommandText = afterWakePhrase.isEmpty ? nil : afterWakePhrase
        if afterWakePhrase.isEmpty {
            awaitingCommandAfterWake = true
            wakePhraseWasHebrew = matchedPhrase.contains("ג'רוויס") || matchedPhrase.contains("גרוויס")
        } else {
            awaitingCommandAfterWake = false
        }
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
            awaitingCommandAfterWake = false
            clapCommandModeActive = false
            onTranscriptReady?(pendingCommandText)
            // Fresh transcript buffer for the next wake phrase, so the
            // just-dispatched command's words can't linger and get
            // matched again.
            beginRecognitionTask()
            return
        }

        if awaitingCommandAfterWake {
            awaitingCommandAfterWake = false
            speak(wakePhraseWasHebrew ? Self.wakeOnlyGreetingHebrew : Self.wakeOnlyGreetingEnglish)
            beginRecognitionTask()
        }
    }
}
