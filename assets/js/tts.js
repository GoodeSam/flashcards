// Web Speech API wrapper with graceful degradation.

let cachedVoice = null;

function pickVoice() {
  if (cachedVoice) return cachedVoice;
  if (!("speechSynthesis" in window)) return null;
  const voices = speechSynthesis.getVoices();
  // Prefer en-US/en-GB; fall back to any en-*
  const preferred =
    voices.find((v) => v.lang === "en-US") ||
    voices.find((v) => v.lang === "en-GB") ||
    voices.find((v) => v.lang.startsWith("en"));
  if (preferred) cachedVoice = preferred;
  return cachedVoice;
}

export function isAvailable() {
  return "speechSynthesis" in window;
}

export function speak(text) {
  if (!isAvailable()) return false;
  // Stop anything previously queued
  speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(text);
  const voice = pickVoice();
  if (voice) utter.voice = voice;
  utter.lang = voice?.lang || "en-US";
  utter.rate = 0.9;
  utter.pitch = 1.0;
  speechSynthesis.speak(utter);
  return true;
}

// Some browsers need this kick to populate voices async.
if ("speechSynthesis" in window) {
  speechSynthesis.onvoiceschanged = () => {
    cachedVoice = null;
    pickVoice();
  };
}
