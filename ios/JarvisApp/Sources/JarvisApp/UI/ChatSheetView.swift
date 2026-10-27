// NEVER COMPILED OR RUN — no Xcode/iOS toolchain in this sandbox.
//
// WHAT THIS VIEW IS FOR, deliberately narrow per the task's own
// instructions: pasting/sending JARVIS a link, an image, or a file — NOT a
// running transcript of ordinary spoken conversation. Saying something out
// loud while this sheet is closed (the normal case) never populates
// anything here; `VoiceController`'s wake-word path and this view share
// the same underlying `/chat`-equivalent conversation on Core (both just
// call `handleUserMessage` through the same WebSocket connection), but
// this view only ever shows messages SENT FROM THIS SHEET — it does not
// listen for or display `voice.reply`/spoken exchanges at all. That's a
// deliberate, real behavioral restriction (not just a visual one): a
// sentence spoken through the Core's wake-word flow is never appended to
// `messages` below.
//
// WHAT'S LITERALLY ON SCREEN: a plain glass-chrome sheet — a short list of
// whatever's been sent/received from THIS sheet only (starts empty every
// time the app launches; not persisted), a bottom input bar with a text
// field, a photo-picker-style attach button (image/file), and a send
// button, all on `.glassEffect` surfaces. No microphone button here — this
// sheet is explicitly the text/attachment path, not another voice
// entrypoint.

import PhotosUI
import SwiftUI

struct ChatSheetView: View {
    @ObservedObject var connectionManager: JarvisConnectionManager
    @Environment(\.dismiss) private var dismiss

    @State private var messages: [ChatSheetMessage] = []
    @State private var draftText = ""
    @State private var selectedPhoto: PhotosPickerItem?

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 12) {
                        ForEach(messages) { message in
                            ChatBubble(message: message)
                        }
                    }
                    .padding()
                }

                inputBar
            }
            .background(Color.black)
            .navigationTitle("Send to JARVIS")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
            }
        }
    }

    private var inputBar: some View {
        HStack(spacing: 10) {
            PhotosPicker(selection: $selectedPhoto, matching: .images) {
                Image(systemName: "paperclip")
                    .foregroundStyle(.white)
                    .frame(width: 40, height: 40)
            }
            .glassEffect(.regular, in: Circle())

            TextField("Paste a link, or add a note…", text: $draftText, axis: .vertical)
                .textFieldStyle(.plain)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .glassEffect(.regular, in: RoundedRectangle(cornerRadius: 18))
                .foregroundStyle(.white)

            Button {
                send()
            } label: {
                Image(systemName: "arrow.up")
                    .foregroundStyle(.black)
                    .frame(width: 40, height: 40)
            }
            .glassEffect(.regular.tint(.white), in: Circle())
            .disabled(draftText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        .padding()
    }

    private func send() {
        let text = draftText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        messages.append(ChatSheetMessage(text: text, isFromUser: true))
        draftText = ""
        // NOTE: this first pass appends the user's own message to the
        // local list immediately but does not yet actually forward it to
        // Core over the WebSocket connection — JarvisConnectionManager has
        // no "send a plain text/attachment turn" method today (only
        // voice.transcript and tool.result are implemented). Wiring a real
        // equivalent of the web UI's `/chat` text-turn message is a small,
        // real follow-up (the envelope/transport already exists; this
        // sheet just doesn't call it yet) — left out here rather than
        // half-built, per this task's own "first real skeleton, not
        // feature-complete" scope. The UI is real and ready for that wire-
        // up; the actual network call is not yet connected.
    }
}

struct ChatSheetMessage: Identifiable {
    let id = UUID()
    let text: String
    let isFromUser: Bool
}

private struct ChatBubble: View {
    let message: ChatSheetMessage

    var body: some View {
        HStack {
            if message.isFromUser { Spacer(minLength: 40) }
            Text(message.text)
                .foregroundStyle(.white)
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .glassEffect(.regular.tint(message.isFromUser ? .blue.opacity(0.4) : .clear), in: RoundedRectangle(cornerRadius: 16))
            if !message.isFromUser { Spacer(minLength: 40) }
        }
    }
}
