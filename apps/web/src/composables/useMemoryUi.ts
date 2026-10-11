/**
 * Memory whisper UI + profile memory list.
 * D-02 P2 extract from App.vue — behavior unchanged.
 * Owns: profileMemories, whisper three-state toast, highlight flash,
 * schedule/clear unread notices. Chat session calls schedule/clear via opts.
 */
import { onUnmounted, ref } from 'vue';
import { api, type MemoryNote } from '../api/client';
import type { ProfileView } from './useMoments';

export function useMemoryUi(opts: {
  getActiveConversationId: () => string | null | undefined;
  getProfileView: () => ProfileView;
}) {
  const profileMemories = ref<MemoryNote[]>([]);
  const memoryWhisperText = ref('记下了');
  const memoryWhisperVisible = ref(false);
  const memoryWhisperOpaque = ref(false);
  const memoryHighlightIds = ref<string[]>([]);

  let whisperDelayTimer: ReturnType<typeof setTimeout> | null = null;
  let whisperHideTimer: ReturnType<typeof setTimeout> | null = null;
  let whisperFadeTimer: ReturnType<typeof setTimeout> | null = null;
  let memoryHighlightTimer: ReturnType<typeof setTimeout> | null = null;
  let whisperPollTimers: ReturnType<typeof setTimeout>[] = [];
  let whisperPollGen = 0;

  function clearWhisperTimers() {
    if (whisperDelayTimer) {
      clearTimeout(whisperDelayTimer);
      whisperDelayTimer = null;
    }
    if (whisperHideTimer) {
      clearTimeout(whisperHideTimer);
      whisperHideTimer = null;
    }
    if (whisperFadeTimer) {
      clearTimeout(whisperFadeTimer);
      whisperFadeTimer = null;
    }
    for (const t of whisperPollTimers) clearTimeout(t);
    whisperPollTimers = [];
  }

  function showMemoryWhisper(summary?: string) {
    const body = String(summary || '').trim() || '新的记忆';
    memoryWhisperText.value = body;
    memoryWhisperVisible.value = true;
    memoryWhisperOpaque.value = false;
    if (whisperHideTimer) {
      clearTimeout(whisperHideTimer);
      whisperHideTimer = null;
    }
    if (whisperFadeTimer) {
      clearTimeout(whisperFadeTimer);
      whisperFadeTimer = null;
    }
    // Slow fade-in (~1.5s), hold, slow fade-out (~3.5s) — total ~10s.
    whisperFadeTimer = setTimeout(() => {
      memoryWhisperOpaque.value = true;
    }, 40);
    whisperHideTimer = setTimeout(() => {
      memoryWhisperOpaque.value = false;
      whisperHideTimer = setTimeout(() => {
        memoryWhisperVisible.value = false;
        whisperHideTimer = null;
      }, 3500);
    }, 6500);
  }

  function flashMemoryHighlights(ids: string[]) {
    if (!ids.length) return;
    memoryHighlightIds.value = [...ids];
    if (memoryHighlightTimer) clearTimeout(memoryHighlightTimer);
    memoryHighlightTimer = setTimeout(() => {
      memoryHighlightIds.value = [];
      memoryHighlightTimer = null;
    }, 2500);
  }

  function clearProfileMemories() {
    profileMemories.value = [];
  }

  async function loadProfileMemories(characterId: string) {
    if (!characterId) {
      profileMemories.value = [];
      return;
    }
    try {
      const mem = await api.listCharacterMemories(characterId);
      profileMemories.value = (mem.memories || []).slice(0, 6);
    } catch {
      profileMemories.value = [];
    }
  }

  /** Swallow stale unread whispers when opening a private chat (no UI). */
  async function clearUnreadMemoryNotices(characterId: string, conversationId?: string) {
    if (!characterId) return;
    try {
      await api.markCharacterMemoryNoticesRead(characterId, {
        all: true,
        conversation_id: conversationId,
      });
    } catch {
      // best-effort
    }
  }

  function scheduleMemoryWhisper(characterId: string, conversationId?: string) {
    if (!characterId) return;
    for (const t of whisperPollTimers) clearTimeout(t);
    whisperPollTimers = [];
    if (whisperDelayTimer) {
      clearTimeout(whisperDelayTimer);
      whisperDelayTimer = null;
    }
    const gen = ++whisperPollGen;
    const convId = conversationId || opts.getActiveConversationId() || undefined;
    // Poll unread notices (written when extract commits) — not the full memory list.
    const offsetsMs = [3000, 7000, 12000, 18000, 25000, 35000, 50000, 70000, 90000];
    for (const ms of offsetsMs) {
      const t = setTimeout(async () => {
        if (gen !== whisperPollGen) return;
        try {
          const res = await api.listCharacterMemoryNotices(characterId, {
            conversationId: convId,
          });
          const notices = res.notices || [];
          if (!notices.length) return;
          const ids = notices.map((n) => n.id);
          const summary = notices
            .map((n) => String(n.summary || '').trim())
            .filter(Boolean)
            .join('；');
          whisperPollGen++;
          for (const x of whisperPollTimers) clearTimeout(x);
          whisperPollTimers = [];
          showMemoryWhisper(summary);
          void api.markCharacterMemoryNoticesRead(characterId, { ids }).catch(() => {});
          const pv = opts.getProfileView();
          if (pv?.kind === 'character' && pv.id === characterId) {
            try {
              const mem = await api.listCharacterMemories(characterId);
              const prevIds = new Set(profileMemories.value.map((m) => m.id));
              profileMemories.value = (mem.memories || []).slice(0, 6);
              const newIds = profileMemories.value.map((m) => m.id).filter((id) => !prevIds.has(id));
              flashMemoryHighlights(newIds);
            } catch {
              // ignore
            }
          }
        } catch {
          // silent — whisper is best-effort
        }
      }, ms);
      whisperPollTimers.push(t);
    }
  }

  function disposeMemoryUi() {
    clearWhisperTimers();
    if (memoryHighlightTimer) {
      clearTimeout(memoryHighlightTimer);
      memoryHighlightTimer = null;
    }
  }

  onUnmounted(() => {
    disposeMemoryUi();
  });

  return {
    profileMemories,
    memoryWhisperText,
    memoryWhisperVisible,
    memoryWhisperOpaque,
    memoryHighlightIds,
    clearProfileMemories,
    loadProfileMemories,
    clearUnreadMemoryNotices,
    scheduleMemoryWhisper,
    disposeMemoryUi,
  };
}
