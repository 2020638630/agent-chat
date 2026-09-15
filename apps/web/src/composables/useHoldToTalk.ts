import { ref } from 'vue';

function writeString(view: DataView, offset: number, str: string) {
  for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
}

/** Encode Float32 mono PCM as 16-bit PCM WAV at targetRate. */
export function encodeWavMono(samples: Float32Array, sampleRate: number, targetRate = 16000): Blob {
  let data = samples;
  let rate = sampleRate;
  if (sampleRate !== targetRate && samples.length > 0) {
    const ratio = sampleRate / targetRate;
    const newLen = Math.max(1, Math.floor(samples.length / ratio));
    const resampled = new Float32Array(newLen);
    for (let i = 0; i < newLen; i++) {
      const src = i * ratio;
      const i0 = Math.floor(src);
      const i1 = Math.min(i0 + 1, samples.length - 1);
      const t = src - i0;
      resampled[i] = samples[i0] * (1 - t) + samples[i1] * t;
    }
    data = resampled;
    rate = targetRate;
  }

  const buffer = new ArrayBuffer(44 + data.length * 2);
  const view = new DataView(buffer);
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + data.length * 2, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(view, 36, 'data');
  view.setUint32(40, data.length * 2, true);
  let offset = 44;
  for (let i = 0; i < data.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, data[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

export function useHoldToTalk() {
  const holding = ref(false);
  const recording = ref(false);
  const error = ref('');

  let stream: MediaStream | null = null;
  let audioCtx: AudioContext | null = null;
  let processor: ScriptProcessorNode | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  const chunks: Float32Array[] = [];
  let inputRate = 48000;

  async function start() {
    error.value = '';
    if (recording.value) return;
    holding.value = true;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      audioCtx = new AudioContext();
      inputRate = audioCtx.sampleRate;
      source = audioCtx.createMediaStreamSource(stream);
      processor = audioCtx.createScriptProcessor(4096, 1, 1);
      chunks.length = 0;
      processor.onaudioprocess = (ev) => {
        if (!holding.value) return;
        const input = ev.inputBuffer.getChannelData(0);
        chunks.push(new Float32Array(input));
      };
      source.connect(processor);
      processor.connect(audioCtx.destination);
      recording.value = true;
    } catch (e) {
      holding.value = false;
      recording.value = false;
      error.value = e instanceof Error ? e.message : '无法打开麦克风';
      cleanup();
    }
  }

  function cleanup() {
    try {
      processor?.disconnect();
      source?.disconnect();
    } catch {
      /* ignore */
    }
    processor = null;
    source = null;
    if (audioCtx) {
      void audioCtx.close().catch(() => undefined);
      audioCtx = null;
    }
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }
  }

  async function stop(): Promise<Blob | null> {
    holding.value = false;
    if (!recording.value) {
      cleanup();
      return null;
    }
    recording.value = false;
    const rate = inputRate;
    const parts = chunks.slice();
    cleanup();
    chunks.length = 0;
    if (!parts.length) return null;
    let total = 0;
    for (const p of parts) total += p.length;
    const merged = new Float32Array(total);
    let off = 0;
    for (const p of parts) {
      merged.set(p, off);
      off += p.length;
    }
    // drop very short taps (< ~0.2s)
    if (merged.length < rate * 0.2) return null;
    return encodeWavMono(merged, rate, 16000);
  }

  function cancel() {
    holding.value = false;
    recording.value = false;
    chunks.length = 0;
    cleanup();
  }

  return { holding, recording, error, start, stop, cancel };
}
