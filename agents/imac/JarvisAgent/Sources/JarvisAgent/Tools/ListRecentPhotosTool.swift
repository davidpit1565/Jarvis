// REQUIRES REAL macOS VALIDATION — PhotosUI/Photos-framework access
// cannot be exercised outside a real macOS runtime with Photos Library
// permission granted. Never compiled or run in this environment.

import Foundation
import Photos

/// The first real Photos-library capability in this codebase — explicitly
/// called out as deferred, separate work in README.md ("A photo-library
/// integration is a separate, larger piece of work... intentionally not
/// bundled into this change"). Metadata only, by design: filename,
/// creation date, dimensions, and media type (photo/video) for the most
/// recent N items — never the image/video bytes themselves. Fetching
/// actual image data is real additional work (PHImageManager,
/// resolution/format choices, much larger payloads) intentionally not
/// bundled into this first step either.
enum ListRecentPhotosTool {
    private static let maxLimit = 50
    private static let defaultLimit = 20

    static func make() -> AgentTool {
        AgentTool(name: "list_recent_photos") { input in
            // AnyCodable.init(from:) (see MessageProtocol.swift) decodes
            // every JSON number as Double, never Int — `as? Int` here
            // always failed and silently discarded any caller-supplied
            // limit, always falling back to defaultLimit. Same fix
            // ScheduleMacNotificationTool already uses for its own
            // numeric input.
            let requestedLimit = (input["limit"]?.value as? Double).map { Int($0) } ?? defaultLimit
            guard requestedLimit > 0 else {
                return ToolResultPayload(success: false, data: nil, error: "limit must be a positive integer")
            }
            let limit = min(requestedLimit, maxLimit)

            let authStatus = PHPhotoLibrary.authorizationStatus(for: .readWrite)
            switch authStatus {
            case .authorized, .limited:
                break
            case .notDetermined:
                // requestAuthorization is async; a synchronous AgentTool
                // can't await it mid-call. The first invocation triggers
                // the system permission prompt and returns this error;
                // once the user grants it, the *next* call succeeds.
                let semaphore = DispatchSemaphore(value: 0)
                PHPhotoLibrary.requestAuthorization(for: .readWrite) { _ in semaphore.signal() }
                _ = semaphore.wait(timeout: .now() + 30)
                let updatedStatus = PHPhotoLibrary.authorizationStatus(for: .readWrite)
                guard updatedStatus == .authorized || updatedStatus == .limited else {
                    return ToolResultPayload(
                        success: false,
                        data: nil,
                        error: "Photos Library access not yet granted — check the permission prompt and try again"
                    )
                }
            default:
                return ToolResultPayload(success: false, data: nil, error: "Photos Library access denied")
            }

            let fetchOptions = PHFetchOptions()
            fetchOptions.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
            fetchOptions.fetchLimit = limit

            let assets = PHAsset.fetchAssets(with: fetchOptions)
            let isoFormatter = ISO8601DateFormatter()

            // AnyCodable.encode(to:) only special-cases [AnyCodable] for
            // arrays (not [[String: AnyCodable]] directly) — each entry
            // must itself be boxed in AnyCodable for the nested dictionary
            // to encode correctly rather than silently falling through to
            // encodeNil().
            var photos: [AnyCodable] = []
            assets.enumerateObjects { asset, _, _ in
                let resources = PHAssetResource.assetResources(for: asset)
                let filename = resources.first?.originalFilename ?? asset.localIdentifier

                let entry: [String: AnyCodable] = [
                    "filename": AnyCodable(filename),
                    "createdAt": AnyCodable(asset.creationDate.map { isoFormatter.string(from: $0) } ?? NSNull()),
                    "width": AnyCodable(asset.pixelWidth),
                    "height": AnyCodable(asset.pixelHeight),
                    "isVideo": AnyCodable(asset.mediaType == .video),
                    "isFavorite": AnyCodable(asset.isFavorite),
                ]
                photos.append(AnyCodable(entry))
            }

            let result: [String: AnyCodable] = [
                "photos": AnyCodable(photos),
                "count": AnyCodable(photos.count),
            ]
            return ToolResultPayload(success: true, data: AnyCodable(result), error: nil)
        }
    }
}
