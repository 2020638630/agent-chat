/**
 * TTS playback: loading / playing / idle + real progress (audio.currentTime).
 * X-06 — migrated from App.vue so UI-4 visuals listen to real progress while playing;
 * loading bar stays CSS-indeterminate. No seek.
 */
import { onUnmounted, ref } from 'vue';
import { api } from '../api/client';

export function useTtsPlayback(opts: { setStatus: (msg: string) => void }) {
  const playingId = ref<string | null>(null);
  const loadingId = ref<string | null>(null);
  /** 0–1 while the active clip is playing; 0 otherwise. */
  const progressRatio = ref(0);

  let audio: HTMLAudioElement | null = null;

  function detachAudio() {
    if (!audio) return;
    audio.onended = null;
    audio.onerror = null;
    audio.ontimeupdate = null;
    audio.onloadedmetadata = null;
    try {
      audio.pause();
    } catch {
      /* ignore */
    }
    audio = null;
  }

  function reset() {
    detachAudio();
    playingId.value = null;
    loadingId.value = null;
    progressRatio.value = 0;
  }

  function updateProgress() {
    if (!audio) {
      progressRatio.value = 0;
      return;
    }
    const dur = audio.duration;
    if (!Number.isFinite(dur) || dur <= 0) {
      progressRatio.value = 0;
      return;
    }
    progressRatio.value = Math.min(1, Math.max(0, audio.currentTime / dur));
  }

  async function play(messageId: string) {
    // tap again on the playing bubble -> pause / stop
    if (playingId.value === messageId && audio) {
      reset();
      return;
    }
    detachAudio();
    loadingId.value = messageId;
    playingId.value = null;
    progressRatio.value = 0;
    try {
      const url = api.messageTtsUrl(messageId) + '?t=' + Date.now();
      const next = new Audio(url);
      audio = next;
      next.ontimeupdate = updateProgress;
      next.onloadedmetadata = updateProgress;
      next.onended = () => {
        if (playingId.value === messageId) playingId.value = null;
        progressRatio.value = 0;
        detachAudio();
      };
      next.onerror = () => {
        opts.setStatus('\u6717\u8bfb\u5931\u8d25\uff0c\u8bf7\u68c0\u67e5 TTS \u914d\u7f6e');
        reset();
      };
      await next.play();
      loadingId.value = null;
      playingId.value = messageId;
      updateProgress();
    } catch (err) {
      loadingId.value = null;
      progressRatio.value = 0;
      detachAudio();
      opts.setStatus(err instanceof Error ? err.message : '\u6717\u8bfb\u5931\u8d25');
    }
  }

  onUnmounted(() => {
    reset();
  });

  return {
    playingId,
    loadingId,
    progressRatio,
    play,
    stop: reset,
  };
}
