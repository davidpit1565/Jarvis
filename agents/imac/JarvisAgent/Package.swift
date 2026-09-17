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
            path: "Sources/JarvisAgent"
        )
    ]
)
