// NEVER COMPILED OR RUN — no Xcode/iOS toolchain in this sandbox. Written
// against real, current Speech/AVFoundation API names as of iOS 17+;
// AVAudioApplication.requestRecordPermission(completionHandler:) (the
// current replacement for the now-deprecated
// AVAudioSession.requestRecordPermission, confirmed via Apple's own
// current documentation before writing this file — see this task's PR
// description/report for the exact search) is the one API choice here
// that's genuinely new relative to the Mac agent's equivalent file; the
// Speech framework calls are identical on both platforms.
//
// HONEST PLATFORM CONSTRAINT (read this before assuming this behaves like
// the Mac agent's always-on WakeWordListener): this only ever listens
// while JarvisApp is in the foreground. iOS gives a third-party app no way
// to keep a live SFSpeechRecognizer + AVAudioEngine session running with
// the app closed or merely backgrounded — there is no "background audio"
// entitlement that covers continuous speech recognition for this purpose,
// and even the most permissive background modes (audio playback, voice
// processing) are meant for apps actively playing/recording audio the
// user explicitly started, not an always-listening wake-word daemon. This
// is a hard platform limitation, not a bug or a corner cut — see the
// README's "What this app can and cannot do" section and
// `Intents/JarvisIntents.swift` for the real mitigation (a Siri Shortcut
// that launches the app directly into a listening state).

import AVFoundation
import Combine
import Speech

/// Foreground "Hey Jarvis" wake-word listening + full conversational
/// barge-in, modeled directly on `agents/imac/JarvisAgent`'s
/// `WakeWordListener.swift` (read in full before writing this file) —
/// same wake-phrase matching, same silence-threshold command capture, same
/// `SpeechEchoClassifier`-based self-echo rejection/barge-in. The
/// differences from the Mac version are all platform-forced, not design
/// choices: iOS needs an explicit `AVAudioSession` category/activation
/// (macOS has no such session concept for `AVAudioEngine`), and iOS's
/// speech/microphone permission APIs are `Speech`/`AVAudioApplication`
/// rather than `Speech`/`AVCaptureDevice`.
final class VoiceController: NSObject, ObservableObject, SFSpeechRecognizerDelegate, AVSpeechSynthesizerDelegate {
    /// Called with the text spoken after the wake phrase, once a pause is
    /// detected, plus which language the reply should be forced into — see
    /// the Mac agent's identical property for the full "en"/"he"/""
    /// contract.
    var onTranscriptReady: ((String, String) -> Void)?

    @Published private(set) var isListening = false
    @Published private(set) var isAwaitingCommand = false
    @Published private(set) var isSpeaking = false
    @Published private(set) var lastPermissionError: String?

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
    private var awaitingCommandAfterWake = false
    private var pendingCommandLanguage = "en"
    private var silenceCheckTimer: Timer?
    private var hasAnnouncedWakePhraseThisCycle = false

    /// Light pitch drop for a deeper, less synthetic tone — same constant
    /// and same reasoning as the Mac agent's `pitchMultiplier`. Whether
    /// this reads as natural on an iPhone's speaker (much smaller/different
    /// than an iMac's) is unverified; David's own listening test on a real
    /// device is what actually settles this, same as wishlist #21 already
    /// says for the Mac agent.
    private static let pitchMultiplier: Float = 0.9

    private static let wakeOnlyGreetingEnglish = "Hey David, how can I help you today?"
    private static let wakeOnlyGreetingHebrew = "היי דיוויד, איך אפשר לעזור?"

    private static let silenceThresholdSeconds: TimeInterval = 1.5

    private var currentlySpokenText: String?

    override init() {
        super.init()
        synthesizer.delegate = self
    }

    /// Requests Speech + microphone authorization once (standard iOS
    /// permission persistence then applies — asked again automatically
    /// only if the user later changes it in Settings). Call once at launch
    /// or first use, per the task's own instructions — not on every
    /// foreground.
    func requestPermissionsIfNeeded(completion: @escaping (Bool) -> Void) {
        SFSpeechRecognizer.requestAuthorization { [weak self] authStatus in
            guard authStatus == .authorized else {
                DispatchQueue.main.async {
                    self?.lastPermissionError = "Speech recognition not authorized (\(authStatus.rawValue))."
                    completion(false)
                }
                return
            }
            // AVAudioApplication.requestRecordPermission(completionHandler:)
            // is the current (iOS 17+) replacement for the deprecated
            // AVAudioSession.sharedInstance().requestRecordPermission —
            // confirmed against Apple's own current documentation before
            // writing this file.
            AVAudioApplication.requestRecordPermission { granted in
                DispatchQueue.main.async {
                    if !granted {
                        self?.lastPermissionError = "Microphone access not granted."
                    }
                    completion(granted)
                }
            }
        }
    }

    /// Starts foreground listening. Safe to call repeatedly (e.g. every
    /// `scenePhase == .active` transition) — a no-op if already listening.
    func startListening() {
        guard !isListening else { return }
        guard let speechRecognizer, speechRecognizer.isAvailable else {
            lastPermissionError = "Speech recognizer unavailable on this device."
            return
        }
        speechRecognizer.delegate = self

        let session = AVAudioSession.sharedInstance()
        do {
            // .playAndRecord (not just .record) because this app both
            // listens continuously AND speaks replies back — the same
            // simultaneous-record-and-playback requirement the Mac agent's
            // AVAudioEngine satisfies for free (macOS has no audio session
            // category system). .defaultToSpeaker keeps playback audible
            // without the user having to hold the phone to their ear like
            // a call; .allowBluetooth/.allowBluetoothA2DP let a connected
            // headset carry both directions if one is in use.
            try session.setCategory(
                .playAndRecord,
                mode: .default,
                options: [.defaultToSpeaker, .allowBluetooth, .allowBluetoothA2DP]
            )
            try session.setActive(true, options: .notifyOthersOnDeactivation)
        } catch {
            Logger.error("Failed to configure AVAudioSession: \(error.localizedDescription)")
            lastPermissionError = "Audio session configuration failed."
            return
        }

        let inputNode = audioEngine.inputNode
        let recordingFormat = inputNode.outputFormat(forBus: 0)
        inputNode.installTap(onBus: 0, bufferSize: 1024, format: recordingFormat) { [weak self] buffer, _ in
            self?.recognitionRequest?.append(buffer)
        }

        audioEngine.prepare()
        do {
            try audioEngine.start()
        } catch {
            Logger.error("Failed to start audio engine: \(error.localizedDescription)")
            lastPermissionError = "Failed to start listening."
            return
        }

        beginRecognitionTask()

        silenceCheckTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
            self?.checkForSilence()
        }
        isListening = true
        Logger.log("Foreground wake-word listening started.")
    }

    /// Stops listening — called on background/inactive (see
    /// `RootView`'s `scenePhase` handling) and whenever the camera is open
    /// (avoids two audio-session consumers fighting, and the user is
    /// visually focused on the camera, not talking to JARVIS, while it's
    /// up — a deliberate simplification for this first pass, not a
    /// technical requirement; a future pass could run both at once).
    func stopListening() {
        silenceCheckTimer?.invalidate()
        silenceCheckTimer = nil
        recognitionTask?.cancel()
        recognitionRequest?.endAudio()
        recognitionTask = nil
        recognitionRequest = nil
        if audioEngine.isRunning {
            audioEngine.stop()
            audioEngine.inputNode.removeTap(onBus: 0)
        }
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        isListening = false
    }

    /// Speaks a reply aloud — identical language-matched voice selection
    /// logic to the Mac agent's `speak()`, minus the one hardcoded
    /// "preferred identifier" (unverified whether that specific Premium
    /// voice identifier is even installed/available on iOS at all — left
    /// out here rather than guessed at; the quality-tier search below
    /// (premium → enhanced → default) is the same real mechanism and needs
    /// no specific identifier to work).
    func speak(_ text: String) {
        let utterance = AVSpeechUtterance(string: text)
        utterance.rate = AVSpeechUtteranceDefaultSpeechRate
        utterance.pitchMultiplier = Self.pitchMultiplier
        let isHebrew = text.unicodeScalars.contains { (0x0590...0x05FF).contains($0.value) }
        if let voice = Self.bestAvailableVoice(languagePrefix: isHebrew ? "he" : "en") {
            utterance.voice = voice
        }
        isSpeaking = true
        currentlySpokenText = text
        synthesizer.speak(utterance)
    }

    private func stopSpeakingForBargeIn() {
        guard isSpeaking else { return }
        synthesizer.stopSpeaking(at: .immediate)
        isSpeaking = false
        currentlySpokenText = nil
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        isSpeaking = false
        currentlySpokenText = nil
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        isSpeaking = false
        currentlySpokenText = nil
    }

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

    private func beginRecognitionTask() {
        recognitionTask?.cancel()
        recognitionTask = nil
        hasAnnouncedWakePhraseThisCycle = false

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.requiresOnDeviceRecognition = speechRecognizer?.supportsOnDeviceRecognition ?? false
        recognitionRequest = request

        recognitionTask = speechRecognizer?.recognitionTask(with: request) { [weak self] result, error in
            guard let self else { return }
            if let result {
                self.handleTranscriptUpdate(result.bestTranscription.formattedString)
            }
            if error != nil || result?.isFinal == true {
                self.beginRecognitionTask()
            }
        }
    }

    private func handleTranscriptUpdate(_ transcript: String) {
        lastTranscriptUpdate = Date()

        if isSpeaking {
            switch SpeechEchoClassifier.classify(heardTranscript: transcript, currentlySpokenText: currentlySpokenText) {
            case .likelyEcho:
                return
            case .cancelCommand, .genuineUserSpeech:
                stopSpeakingForBargeIn()
            }
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
            Logger.log("Wake phrase heard: \"\(matchedPhrase)\"")
        }

        let afterWakePhrase = String(transcript[range.upperBound...]).trimmingCharacters(in: .whitespacesAndNewlines)
        pendingCommandText = afterWakePhrase.isEmpty ? nil : afterWakePhrase
        pendingCommandLanguage = Self.hebrewWakePhrases.contains(matchedPhrase) ? "he" : "en"
        awaitingCommandAfterWake = afterWakePhrase.isEmpty
        isAwaitingCommand = true
    }

    private func checkForSilence() {
        guard Date().timeIntervalSince(lastTranscriptUpdate) >= Self.silenceThresholdSeconds else { return }

        if let pendingCommandText, !pendingCommandText.isEmpty {
            self.pendingCommandText = nil
            awaitingCommandAfterWake = false
            isAwaitingCommand = false
            onTranscriptReady?(pendingCommandText, pendingCommandLanguage)
            beginRecognitionTask()
            return
        }

        if awaitingCommandAfterWake {
            awaitingCommandAfterWake = false
            isAwaitingCommand = false
            speak(pendingCommandLanguage == "he" ? Self.wakeOnlyGreetingHebrew : Self.wakeOnlyGreetingEnglish)
            beginRecognitionTask()
        }
    }
}
