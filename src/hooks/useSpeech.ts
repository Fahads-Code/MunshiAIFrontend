import { useCallback, useEffect, useRef, useState } from "react";

type SpeechAlternative = { transcript: string };
type SpeechResult = {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: SpeechAlternative;
};
type SpeechResultList = { readonly length: number; readonly [index: number]: SpeechResult };
type SpeechEvent = { resultIndex: number; results: SpeechResultList };
type SpeechErrorEvent = { error: string };

interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: SpeechEvent) => void) | null;
  onerror: ((e: SpeechErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type RecognitionCtor = new () => Recognition;

function getCtor(): RecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: RecognitionCtor;
    webkitSpeechRecognition?: RecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

const Ctor = getCtor();
export const speechSupported = Ctor !== null;

function speechErrorMessage(code: string): string {
  switch (code) {
    case "not-allowed":
    case "service-not-allowed":
      return "Mic ki ijazat nahi mili. Browser mein microphone allow karein.";
    case "no-speech":
      return "Awaz nahi aayi. Dobara bolein.";
    case "network":
      return "Voice ke liye internet chahiye (Chrome Google ke server se samajhta hai).";
    case "audio-capture":
      return "Microphone nahi mila.";
    case "aborted":
      return "";
    default:
      return `Voice error: ${code}`;
  }
}

/**
 * Tap-to-talk speech recognition. `onFinal` receives the full recognised sentence
 * once the engine stops listening.
 */
export function useSpeech(lang: string, onFinal: (text: string) => void) {
  const recRef = useRef<Recognition | null>(null);
  const onFinalRef = useRef(onFinal);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    onFinalRef.current = onFinal;
  });

  useEffect(() => {
    return () => {
      recRef.current?.abort();
    };
  }, []);

  const start = useCallback(() => {
    if (!Ctor) return;
    setError(null);
    setInterim("");

    const rec = new Ctor();
    rec.lang = lang;
    rec.continuous = false;
    rec.interimResults = true;

    let finalText = "";

    rec.onresult = (e) => {
      let interimText = "";
      for (let i = e.resultIndex; i < e.results.length; i += 1) {
        const result = e.results[i];
        const piece = result[0].transcript;
        if (result.isFinal) finalText += ` ${piece}`;
        else interimText += piece;
      }
      setInterim(interimText || finalText.trim());
    };

    rec.onerror = (e) => {
      const msg = speechErrorMessage(e.error);
      if (msg) setError(msg);
    };

    rec.onend = () => {
      setListening(false);
      setInterim("");
      recRef.current = null;
      const text = finalText.trim();
      if (text) onFinalRef.current(text);
    };

    recRef.current = rec;
    setListening(true);
    try {
      rec.start();
    } catch {
      setListening(false);
      setError("Voice shuru nahi ho saki. Dobara koshish karein.");
    }
  }, [lang]);

  const stop = useCallback(() => {
    recRef.current?.stop();
  }, []);

  return { supported: speechSupported, listening, interim, error, start, stop };
}
