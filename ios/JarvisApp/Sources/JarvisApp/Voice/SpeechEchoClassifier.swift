// NEVER COMPILED OR RUN — no Xcode/iOS toolchain in this sandbox. Ported
// verbatim from agents/imac/JarvisAgent's Voice/SpeechEchoClassifier.swift —
// this heuristic is pure Foundation string logic with no AppKit/macOS
// dependency, so it is copied as-is rather than reimplemented. If you tune
// the thresholds after real device testing on one platform, check whether
// the same tuning belongs on the other. The Mac agent's own file carries
// its own "REQUIRES REAL macOS VALIDATION" note on these thresholds; the
// equivalent note here is "REQUIRES REAL iOS VALIDATION" — a phone's
// speaker-to-mic acoustic path (much closer together, different speaker)
// is NOT the same as an iMac's, so don't assume thresholds tuned on one
// device transfer cleanly to the other even after both are tested.

import Foundation

/// Pure, unit-testable heuristics for telling JARVIS's own synthesized
/// voice apart from something new the user actually said, used by
/// `VoiceController` whenever `AVSpeechSynthesizer` is actively speaking
/// while recognition keeps listening through the same microphone.
///
/// Inspired by the pattern recorded in `CLAUDE.md` item #16 from reading
/// `ethanplusai/jarvis`'s `speech.py` `SpeechScheduler` — token-overlap and
/// stem-matching against the text currently being spoken, plus a fast path
/// for short cancel words — but this is our own reimplementation written
/// against this codebase, not ported code (that project's license is
/// non-commercial; CLAUDE.md is explicit that only the idea travels, not
/// the source).
///
/// Honesty note, same standard as the Mac agent's own copy: this is a
/// cheap text-level heuristic, not a lab-grade acoustic-echo-cancellation
/// solution. It never sees the actual audio being played back — only the
/// text strings involved — so it will occasionally get it wrong in both
/// directions.
enum SpeechEchoClassifier {

    enum Intent: Equatable {
        /// Heard while JARVIS was speaking; scored as JARVIS hearing its
        /// own voice, not something the user said. `overlapScore` is 0-1
        /// (higher = more confidently an echo).
        case likelyEcho(overlapScore: Double)
        /// A short, deliberate interruption word/phrase ("stop", "wait",
        /// "enough", "quiet", ...), matched even through a somewhat
        /// garbled ASR transcription — always treated as a genuine
        /// barge-in regardless of overlap score.
        case cancelCommand
        /// Heard while JARVIS was speaking, scored as real new user
        /// speech worth interrupting JARVIS for. `overlapScore` is 0-1
        /// (lower = more confidently genuine).
        case genuineUserSpeech(overlapScore: Double)
    }

    private static let cancelPhrases = [
        "stop", "wait", "cancel", "enough", "quiet", "shush",
        "stop talking", "never mind", "nevermind", "hold on",
    ]

    /// Above this token-overlap score (0-1), a heard transcript is treated
    /// as JARVIS hearing itself rather than new user speech. REQUIRES REAL
    /// iOS VALIDATION — see this file's header comment.
    private static let echoOverlapThreshold = 0.55

    private static let shortUtteranceTokenCount = 3

    static func classify(heardTranscript: String, currentlySpokenText: String?) -> Intent {
        let heardTokens = tokenize(heardTranscript)
        guard !heardTokens.isEmpty else { return .likelyEcho(overlapScore: 0) }

        if isCancelCommand(heardTokens) {
            return .cancelCommand
        }

        guard let spokenText = currentlySpokenText, !spokenText.isEmpty else {
            return .genuineUserSpeech(overlapScore: 0)
        }

        let spokenTokens = tokenize(spokenText)
        let score = overlapScore(heardTokens: heardTokens, spokenTokens: spokenTokens)
        return score >= echoOverlapThreshold
            ? .likelyEcho(overlapScore: score)
            : .genuineUserSpeech(overlapScore: score)
    }

    // MARK: - Tokenization & stemming

    static func tokenize(_ text: String) -> [String] {
        text.lowercased()
            .components(separatedBy: CharacterSet.alphanumerics.inverted)
            .filter { !$0.isEmpty }
    }

    static func stem(_ token: String) -> String {
        let suffixes = ["ing", "ed", "es", "s", "ly"]
        for suffix in suffixes where token.hasSuffix(suffix) {
            let stemmed = String(token.dropLast(suffix.count))
            if stemmed.count >= 3 { return stemmed }
        }
        return token
    }

    // MARK: - Overlap scoring

    static func overlapScore(heardTokens: [String], spokenTokens: [String]) -> Double {
        guard !heardTokens.isEmpty, !spokenTokens.isEmpty else { return 0 }
        let heardStems = Set(heardTokens.map(stem))
        let spokenStems = Set(spokenTokens.map(stem))
        let shared = heardStems.intersection(spokenStems)
        let smaller = min(heardStems.count, spokenStems.count)
        guard smaller > 0 else { return 0 }
        return Double(shared.count) / Double(smaller)
    }

    // MARK: - Cancel-word fast path

    private static func isCancelCommand(_ heardTokens: [String]) -> Bool {
        guard heardTokens.count <= shortUtteranceTokenCount else { return false }
        let heardStems = heardTokens.map(stem)
        for phrase in cancelPhrases {
            let phraseTokens = tokenize(phrase).map(stem)
            if phraseTokens.count == 1 {
                if heardStems.contains(where: { levenshteinDistance($0, phraseTokens[0]) <= 1 }) {
                    return true
                }
            } else if heardStems == phraseTokens {
                return true
            }
        }
        return false
    }

    static func levenshteinDistance(_ a: String, _ b: String) -> Int {
        let aChars = Array(a)
        let bChars = Array(b)
        if aChars.isEmpty { return bChars.count }
        if bChars.isEmpty { return aChars.count }
        var previous = Array(0...bChars.count)
        var current = [Int](repeating: 0, count: bChars.count + 1)
        for i in 1...aChars.count {
            current[0] = i
            for j in 1...bChars.count {
                if aChars[i - 1] == bChars[j - 1] {
                    current[j] = previous[j - 1]
                } else {
                    current[j] = 1 + min(previous[j - 1], previous[j], current[j - 1])
                }
            }
            previous = current
        }
        return previous[bChars.count]
    }
}
