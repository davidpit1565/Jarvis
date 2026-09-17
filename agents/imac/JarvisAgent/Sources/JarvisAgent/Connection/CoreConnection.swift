// REQUIRES REAL macOS VALIDATION — never compiled or run in this environment.
//
// Uses URLSessionWebSocketTask rather than Network.framework: this agent
// only needs a single outbound WebSocket client connection to Core, not
// raw TCP/UDP or a listener. URLSessionWebSocketTask gives us that with
// far less boilerplate (built-in TLS, ping/pong support, and delegate-based
// lifecycle) and is the standard choice for "my app is a WebSocket client"
// on macOS. Network.framework would only earn its complexity if this
// agent needed to *listen* for connections or speak a non-WebSocket
// transport — neither applies here.

import Foundation

protocol CoreConnectionDelegate: AnyObject {
    func coreConnection(_ connection: CoreConnection, didReceive envelopeData: Data)
    func coreConnectionDidOpen(_ connection: CoreConnection)
    func coreConnectionDidClose(_ connection: CoreConnection, error: Error?)
}

/// Owns the single WebSocket connection to JARVIS Core: connecting,
/// receiving, sending, and reconnecting with backoff. Knows nothing about
/// tool semantics — that's ToolRegistry's job. This class never exposes a
/// way to send arbitrary/unvalidated data on the device's behalf; callers
/// always pass an already-constructed, already-validated Envelope.
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
        print("[JarvisAgent] Connecting to \(coreURL.absoluteString)...")
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

    /// Sends a pre-built, already-Codable-encoded envelope. This is the
    /// only way data leaves the agent — there is no generic "send raw
    /// string/command" entry point, by design.
    func send(data: Data) {
        task?.send(.data(data)) { error in
            if let error {
                Logger.shared.log("CoreConnection send failed: \(error.localizedDescription)")
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
                print("[JarvisAgent] Connection error: \(error.localizedDescription)")
                Logger.shared.log("CoreConnection receive failed: \(error.localizedDescription)")
                self.scheduleReconnect(after: error)
            }
        }
    }

    private func scheduleReconnect(after error: Error) {
        guard !isStopped else { return }
        delegate?.coreConnectionDidClose(self, error: error)

        reconnectAttempt += 1
        let backoff = min(pow(2.0, Double(reconnectAttempt)), maxBackoffSeconds)
        print("[JarvisAgent] Reconnecting in \(backoff)s (attempt \(reconnectAttempt))")
        Logger.shared.log("Reconnecting in \(backoff)s (attempt \(reconnectAttempt))")

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
        print("[JarvisAgent] WebSocket connected.")
        reconnectAttempt = 0
        delegate?.coreConnectionDidOpen(self)
    }

    func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didCompleteWithError error: Error?
    ) {
        print("[JarvisAgent] Task completed with error: \(error?.localizedDescription ?? "none")")
    }

    func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
        reason: Data?
    ) {
        print("[JarvisAgent] WebSocket closed with code \(closeCode.rawValue).")
        scheduleReconnect(after: NSError(domain: "CoreConnection", code: closeCode.rawValue))
    }
}
