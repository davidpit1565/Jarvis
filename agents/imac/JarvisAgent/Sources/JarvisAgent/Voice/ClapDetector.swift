// REQUIRES REAL macOS VALIDATION — clap detection depends entirely on
// real microphone/room acoustics that can't be exercised outside a real
// macOS runtime. Never compiled or run in this environment; the
// thresholds below are a reasonable starting point, not a tuned result,
// and will likely need adjusting against David's actual Mac and room.

import AVFoundation

/// Detects a hand clap from the same raw microphone buffers
/// WakeWordListener already taps for speech recognition — reusing the one
/// tap rather than opening a second audio session. A clap is a loud,
/// very short, broadband transient that arrives right after relative
/// quiet; this deliberately does NOT try to tell a clap apart from every
/// other sharp sound (a dropped object, a door) by its spectrum — only by
/// its shape (fast attack, short duration, preceded by quiet) — since a
/// simple, cheap on-device detector can't do real spectral analysis
/// without adding a class of false negatives on real hardware. A
/// deliberately loose false-positive rate is the accepted tradeoff for
/// "should react to at least one or two claps," per the explicit request
/// this exists for.
final class ClapDetector {
    /// How many times louder than the recent noise floor a buffer's peak
    /// must be to count as a clap's onset.
    private static let onsetThresholdMultiplier: Float = 6.0
    /// Minimum peak amplitude (0-1) required regardless of noise floor,
    /// so a clap can't be detected purely because the room is dead silent.
    private static let minimumPeakAmplitude: Float = 0.15
    /// Refractory period after a detected clap before another can fire —
    /// stops one clap's own decay tail (spanning a couple of buffers)
    /// from being counted as a second clap.
    private static let refractoryPeriod: TimeInterval = 0.4
    /// Exponential moving average factor for the ambient noise floor.
    private static let noiseFloorSmoothing: Float = 0.05

    private var noiseFloor: Float = 0.01
    private var lastDetectionAt: Date = .distantPast

    /// Feeds one buffer of raw microphone audio; returns true exactly once
    /// per detected clap (respecting the refractory period).
    func process(_ buffer: AVAudioPCMBuffer) -> Bool {
        guard let channelData = buffer.floatChannelData else { return false }
        let frameCount = Int(buffer.frameLength)
        guard frameCount > 0 else { return false }

        var peak: Float = 0
        let samples = channelData[0]
        for i in 0..<frameCount {
            let magnitude = abs(samples[i])
            if magnitude > peak { peak = magnitude }
        }

        defer {
            // Only let quiet-to-moderate buffers pull the noise floor up —
            // a clap itself (or ongoing speech) must never teach the
            // detector to treat loud sound as "normal," or it would stop
            // detecting claps for the rest of the session.
            if peak < Self.minimumPeakAmplitude {
                noiseFloor = noiseFloor * (1 - Self.noiseFloorSmoothing) + peak * Self.noiseFloorSmoothing
                noiseFloor = max(noiseFloor, 0.001)
            }
        }

        guard peak >= Self.minimumPeakAmplitude else { return false }
        guard peak >= noiseFloor * Self.onsetThresholdMultiplier else { return false }
        guard Date().timeIntervalSince(lastDetectionAt) >= Self.refractoryPeriod else { return false }

        lastDetectionAt = Date()
        return true
    }
}
