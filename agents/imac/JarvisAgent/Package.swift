// swift-tools-version:5.9
//
// REQUIRES REAL macOS VALIDATION.
// This package has never been compiled or run — this Linux/Claude Code
// environment has no Xcode or macOS SDK. Everything here is source only,
// written to the Phase 2 architecture and awaiting a real build on the
// target iMac.

import PackageDescription

let package = Package(
    name: "JarvisAgent",
    platforms: [
        .macOS(.v13)
    ],
    targets: [
        .executableTarget(
            name: "JarvisAgent",
            path: "Sources/JarvisAgent",
            // Embeds Resources/Info.plist into the compiled binary's own
            // Mach-O __TEXT,__info_plist section — the standard way a raw
            // `swift build` executable (not an .app bundle) gets an
            // Info.plist at all. Without it, macOS/TCC never shows the
            // microphone/Speech-Recognition permission prompts at all,
            // so WakeWordListener silently never starts.
            linkerSettings: [
                // EventKit (macOS Reminders tools) isn't auto-linked for a
                // plain SwiftPM executable the way AppKit/Foundation are —
                // an `import` alone compiles but fails to link without this.
                .linkedFramework("EventKit"),
                .unsafeFlags([
                    "-Xlinker", "-sectcreate",
                    "-Xlinker", "__TEXT",
                    "-Xlinker", "__info_plist",
                    "-Xlinker", "Resources/Info.plist",
                ])
            ]
        )
    ]
)
