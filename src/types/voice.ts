/**
 * Provider-agnostic voice interfaces. Nothing in Core is wired to these
 * yet — they exist so a future microphone-based voice pipeline (Hebrew +
 * English speech in/out on a device, as distinct from the phone-call
 * channel in src/communication/phone/) can be built against a stable
 * contract without locking JARVIS to one paid vendor up front.
 */

export interface TranscriptionResult {
  text: string;
  /** BCP-47 language tag if the provider can report one, e.g. "he-IL", "en-US". */
  language?: string;
}

export interface SpeechToText {
  transcribe(audio: Uint8Array, mimeType: string): Promise<TranscriptionResult>;
}

export interface SynthesisResult {
  audio: Uint8Array;
  mimeType: string;
}

export interface TextToSpeechOptions {
  language?: string;
}

export interface TextToSpeech {
  synthesize(text: string, options?: TextToSpeechOptions): Promise<SynthesisResult>;
}
