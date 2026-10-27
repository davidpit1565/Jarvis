// REQUIRES REAL macOS VALIDATION — the thresholds below are reasonable
// starting points, not tuned results. Real microphone/speaker bleed
// (room acoustics, mic gain, speaker volume) determines how well this
// actually tells JARVIS's own voice apart from David's on a real iMac,
// and that can only be exercised on real hardware. Never compiled or run
// in this environment.

import Foundation

/// Pure, unit-testable heuristics for telling JARVIS's own synthesized
/// voice apart from something new the user actually said, used by
/// `WakeWordListener` whenever `AVSpeechSynthesizer` is actively speaking
/// while the always-on speech recognizer keeps listening through the same
/// microphone — which is exactly what happens during a normal spoken
/// reply, the clap/wake-phrase greetings, and especially PR #146's
/// `speakProactiveAnnouncement` (JARVIS speaks first, unprompted, then
/// listens for a reply with no wake phrase required at all).
///
/// Inspired by the pattern recorded in `CLAUDE.md` item #16 from reading
/// `ethanplusai/jarvis`'s `speech.py` `SpeechScheduler` — token-overlap and
/// stem-matching against the text currently being spoken, plus a fast path
/// for short cancel words — but this is our own reimplementation written
/// against this codebase, not ported code (that project's license is
/// non-commercial; CLAUDE.md is explicit that only the idea travels, not
/// the source).
///
/// Honesty note, same standard as `ClapDetector`'s own doc comment: this is
/// a cheap text-level heuristic, not a lab-grade acoustic-echo-cancellation
/// solution. It never sees the actual audio being played back (no AEC, no
/// cross-correlation against the synthesizer's output) — only the text
/// strings involved — so it will occasionally get it wrong in both
/// directions: a user who happens to repeat several of JARVIS's own words
/// back (e.g. echoing part of a question while answering it) could be
/// wrongly suppressed as an echo, and conversely a short, mostly-unrelated
/// genuine utterance could in theory score high enough on overlap to be
/// mistaken for an echo. `echoOverlapThreshold` is a starting guess, not a
/// tuned value — expect to adjust it against David's actual Mac and room.
enum SpeechEchoClassifier {

    enum Intent: Equatable {
        /// Heard while JARVIS was speaking; scored as JARVIS hearing its
        /// own voice, not something the user said. `overlapScore` is 0-1
        /// (higher = more confidently an echo).
        case likelyEcho(overlapScore: Double)
        /// A short, deliberate interruption word/phrase ("stop", "wait",
        /// "enough", "quiet", ...), matched even through a somewhat
        /// garbled ASR transcription — always treated as a genuine
        /// barge-in regardless of overlap score, since these are exactly
        /// the utterances most likely to coincidentally share a word with
        /// whatever JARVIS happens to be saying at that moment.
        case cancelCommand
        /// Heard while JARVIS was speaking, scored as real new user
        /// speech worth interrupting JARVIS for. `overlapScore` is 0-1
        /// (lower = more confidently genuine).
        case genuineUserSpeech(overlapScore: Double)
    }

    /// Short, deliberate interruption phrases. Kept small and unambiguous
    /// on purpose — this is a fast path for "stop talking right now," not
    /// general intent recognition (that remains Core/Claude's job once a
    /// turn actually reaches it).
    private static let cancelPhrases = [
        "stop", "wait", "cancel", "enough", "quiet", "shush",
        "stop talking", "never mind", "nevermind", "hold on",
    ]

    /// Above this token-overlap score (0-1), a heard transcript is treated
    /// as JARVIS hearing itself rather than new user speech. Deliberately
    /// biased toward NOT barging in on a false positive, since a missed
    /// echo just costs one spurious listen cycle, while a wrongly-missed
    /// genuine barge-in means the user had to wait out JARVIS's whole
    /// sentence anyway. REQUIRES REAL iMac VALIDATION.
    private static let echoOverlapThreshold = 0.55

    /// Utterances at or below this token count go through the cancel-word
    /// fast path check — a two- or three-word genuine interruption ("no,
    /// stop", "wait a second") is exactly the case most likely to
    /// accidentally share a word with whatever JARVIS is mid-sentence on,
    /// so it needs to bypass the overlap score entirely rather than risk
    /// being scored as an echo.
    private static let shortUtteranceTokenCount = 3

    /// Classifies one heard transcript against the text JARVIS is
    /// currently speaking (or `nil`/empty if nothing trackable is
    /// speaking, in which case this always reports genuine speech — fail
    /// open toward treating it as real rather than silently dropping
    /// something the user said).
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

    /// Lowercases, strips punctuation, and splits on whitespace. No
    /// locale-aware word breaking — good enough for the English/loosely-
    /// transliterated-Hebrew transcripts this recognizer actually produces
    /// (see `WakeWordListener`'s own note on its en-US-locked recognizer).
    static func tokenize(_ text: String) -> [String] {
        text.lowercased()
            .components(separatedBy: CharacterSet.alphanumerics.inverted)
            .filter { !$0.isEmpty }
    }

    /// A deliberately crude suffix-stripping stemmer — not Porter/Snowball,
    /// just enough to match "listening"/"listen", "stops"/"stop" and
    /// similar ASR near-variants without pulling in a dependency. Only
    /// strips when the remaining stem is still long enough to be a real
    /// word root, so short words like "is" or "was" are left alone.
    static func stem(_ token: String) -> String {
        let suffixes = ["ing", "ed", "es", "s", "ly"]
        for suffix in suffixes where token.hasSuffix(suffix) {
            let stemmed = String(token.dropLast(suffix.count))
            if stemmed.count >= 3 { return stemmed }
        }
        return token
    }

    // MARK: - Overlap scoring

    /// Overlap over stemmed token sets, normalized against the SMALLER of
    /// the two sets (usually the heard fragment) rather than their union —
    /// so a short heard fragment that's fully contained in a long spoken
    /// sentence scores close to 1.0, matching the real self-echo shape
    /// (JARVIS says a full sentence, the mic only catches a fragment of
    /// it), instead of being diluted toward 0 by the sentence's many
    /// non-overlapping words.
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
                // Allow a one-edit ASR slip ("shop"/"top" for "stop") on a
                // single-word cancel phrase only — garbled transcription
                // of exactly the word that matters most to catch cleanly.
                if heardStems.contains(where: { levenshteinDistance($0, phraseTokens[0]) <= 1 }) {
                    return true
                }
            } else if heardStems == phraseTokens {
                return true
            }
        }
        return false
    }

    /// Minimal iterative Levenshtein distance — only ever called here on
    /// short single words, so no need for anything fancier.
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
