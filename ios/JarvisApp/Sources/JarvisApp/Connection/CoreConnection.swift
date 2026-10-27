// NEVER COMPILED OR RUN — no Xcode/iOS toolchain in this sandbox. Ported
// nearly verbatim from agents/imac/JarvisAgent/Sources/JarvisAgent/Connection/CoreConnection.swift:
// URLSessionWebSocketTask is pure Foundation, fully portable to iOS with no
// changes — same rationale for choosing it over Network.framework applies
// identically here (a single outbound WebSocket client connection, no
// listener, no raw transport needed).

import Foundation

protocol CoreConnectionDelegate: AnyObject {
    func coreConnection(_ connection: CoreConnection, didReceive envelopeData: Data)
    func coreConnectionDidOpen(_ connection: CoreConnection)
    func coreConnectionDidClose(_ connection: CoreConnection, error: Error?)
}

/// Owns the single WebSocket connection to JARVIS Core. Identical
/// responsibilities to the Mac agent's class of the same name — see its
/// doc comment. This class never exposes a way to send arbitrary/
/// unvalidated data; callers always pass an already-constructed envelope.
final class CoreConnection: NSObject {
    weak var delegate: CoreConnectionDelegate?

    private let coreURL: URL
    private var session: URLSession?
    private var task: URLSessionWebSocketTask?
    private var reconnectAttempt = 0
    private let maxBackoffSeconds: TimeInterval = 30
    private var isStopped = false

    init(coreURL: URL) {
        self.coreURL = coreURL
    }

    func connect() {
        Logger.log("Connecting to \(coreURL.absoluteString)...")
        isStopped = false
        let session = URLSession(configuration: .default, delegate: self, delegateQueue: nil)
        self.session = session
        let task = session.webSocketTask(with: coreURL)
        self.task = task
        task.resume()
        receiveLoop()
    }

    func stop() {
        isStopped = true
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        session = nil
    }

    /// Sends a pre-built, already-Codable-encoded envelope — the only way
    /// data leaves this app toward Core.
    func send(data: Data) {
        task?.send(.data(data)) { error in
            if let error {
                Logger.error("CoreConnection send failed: \(error.localizedDescription)")
            }
        }
    }

    private func receiveLoop() {
        task?.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let message):
                switch message {
                case .data(let data):
                    self.delegate?.coreConnection(self, didReceive: data)
                case .string(let text):
                    if let data = text.data(using: .utf8) {
                        self.delegate?.coreConnection(self, didReceive: data)
                    }
                @unknown default:
                    break
                }
                self.receiveLoop()
            case .failure(let error):
                Logger.error("Connection error: \(error.localizedDescription)")
                self.scheduleReconnect(after: error)
            }
        }
    }

    private func scheduleReconnect(after error: Error) {
        guard !isStopped else { return }
        delegate?.coreConnectionDidClose(self, error: error)

        reconnectAttempt += 1
        let backoff = min(pow(2.0, Double(reconnectAttempt)), maxBackoffSeconds)
        Logger.log("Reconnecting in \(backoff)s (attempt \(reconnectAttempt))")

        DispatchQueue.global().asyncAfter(deadline: .now() + backoff) { [weak self] in
            guard let self, !self.isStopped else { return }
            self.connect()
        }
    }
}

extension CoreConnection: URLSessionWebSocketDelegate {
    func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didOpenWithProtocol protocol: String?
    ) {
        Logger.log("WebSocket connected.")
        reconnectAttempt = 0
        delegate?.coreConnectionDidOpen(self)
    }

    func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didCompleteWithError error: Error?
    ) {
        if let error {
            Logger.error("Task completed with error: \(error.localizedDescription)")
        }
    }

    func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
        reason: Data?
    ) {
        Logger.log("WebSocket closed with code \(closeCode.rawValue).")
        scheduleReconnect(after: NSError(domain: "CoreConnection", code: closeCode.rawValue))
    }
}
