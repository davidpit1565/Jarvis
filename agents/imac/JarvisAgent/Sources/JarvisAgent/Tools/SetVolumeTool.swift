// REQUIRES REAL macOS VALIDATION — CoreAudio device I/O cannot be
// exercised outside a real macOS runtime. Never compiled or run in this
// environment.

import CoreAudio
import Foundation

/// Sets the system's default output volume via CoreAudio's own public
/// HAL API (AudioObjectSetPropertyData on kAudioDevicePropertyVolumeScalar)
/// — a real Apple framework call, not a shell command or a scripted Finder
/// command (see ToolRegistry.swift's own comment on why there is no
/// process execution anywhere in this Agent). Clamped to 0-100 before it
/// ever reaches CoreAudio.
enum SetVolumeTool {
    static func make() -> AgentTool {
        AgentTool(name: "set_volume") { input in
            guard let rawLevel = input["level"]?.value as? Double else {
                return ToolResultPayload(success: false, data: nil, error: "level (0-100) is required")
            }
            let level = min(100, max(0, rawLevel))
            let scalar = Float32(level / 100.0)

            var defaultOutputDeviceID = AudioDeviceID(0)
            var deviceIDSize = UInt32(MemoryLayout<AudioDeviceID>.size)
            var defaultDeviceAddress = AudioObjectPropertyAddress(
                mSelector: kAudioHardwarePropertyDefaultOutputDevice,
                mScope: kAudioObjectPropertyScopeGlobal,
                mElement: kAudioObjectPropertyElementMain
            )

            let deviceStatus = AudioObjectGetPropertyData(
                AudioObjectID(kAudioObjectSystemObject),
                &defaultDeviceAddress,
                0,
                nil,
                &deviceIDSize,
                &defaultOutputDeviceID
            )
            guard deviceStatus == noErr else {
                return ToolResultPayload(success: false, data: nil, error: "Could not find the default output device (status \(deviceStatus))")
            }

            var volumeAddress = AudioObjectPropertyAddress(
                mSelector: kAudioDevicePropertyVolumeScalar,
                mScope: kAudioDevicePropertyScopeOutput,
                mElement: kAudioObjectPropertyElementMain
            )
            var mutableScalar = scalar
            let setStatus = AudioObjectSetPropertyData(
                defaultOutputDeviceID,
                &volumeAddress,
                0,
                nil,
                UInt32(MemoryLayout<Float32>.size),
                &mutableScalar
            )
            guard setStatus == noErr else {
                return ToolResultPayload(
                    success: false, data: nil,
                    error: "This output device doesn't support a single master volume control (status \(setStatus)) — some Macs/external outputs need per-channel volume instead"
                )
            }

            let result: [String: AnyCodable] = ["level": AnyCodable(level)]
            return ToolResultPayload(success: true, data: AnyCodable(result), error: nil)
        }
    }
}
