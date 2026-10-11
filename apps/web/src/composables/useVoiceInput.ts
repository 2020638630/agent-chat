/**
 * Voice STT input orchestration (hold-to-talk + upload + cancel gesture).
 * D-02 P2 extract from App.vue — behavior unchanged.
 * Mic capture stays in useHoldToTalk; TTS playback stays in useTtsPlayback.
 */
import { computed, nextTick, ref, type ComputedRef, type Ref } from 'vue';
import { api, type ChatMessage, type Conversation } from '../api/client';
import { useHoldToTalk } from './useHoldToTalk';

type MemberLike = { id: string; name: string; avatar_path?: string | null } | null;

export function useVoiceInput(opts: {
  sending: Ref<boolean>;
  activeConversationId: Ref<string | null>;
  activeConversation: ComputedRef<Conversation | null>;
  messages: Ref<ChatMessage[]>;
  mentionId: Ref<string>;
  chatBody: Ref<HTMLElement | null>;
  privatePeer: (c: Conversation | null | undefined) => MemberLike;
  scheduleMemoryWhisper: (characterId: string, conversationId?: string) => void;
  refreshConversations: () => Promise<void>;
  setStatus: (msg: string) => void;
}) {
  const {
    holding: voiceHolding,
    recording: voiceRecording,
    error: voiceError,
    start: voiceStart,
    stop: voiceStop,
    cancel: voiceCancel,
  } = useHoldToTalk();

  const voiceActive = computed(() => voiceHolding.value || voiceRecording.value);
  const voiceBusy = ref(false);
  const voiceCancelHint = ref(false);
  let voicePointerStartY = 0;
  let voiceWillCancel = false;

  async function onVoicePointerDown(e: PointerEvent) {
    e.preventDefault();
    if (opts.sending.value || voiceBusy.value || !opts.activeConversationId.value) return;
    voicePointerStartY = e.clientY;
    voiceWillCancel = false;
    voiceCancelHint.value = false;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    await voiceStart();
  }

  function onVoicePointerMove(e: PointerEvent) {
    if (!voiceHolding.value && !voiceRecording.value) return;
    const dy = e.clientY - voicePointerStartY;
    voiceWillCancel = dy < -48;
    voiceCancelHint.value = voiceWillCancel;
  }

  async function onVoicePointerUp() {
    if (!voiceHolding.value && !voiceRecording.value) return;
    const cancel = voiceWillCancel;
    voiceCancelHint.value = false;
    voiceWillCancel = false;
    if (cancel) {
      voiceCancel();
      opts.setStatus('已取消发送');
      return;
    }
    const blob = await voiceStop();
    if (voiceError.value) {
      opts.setStatus(voiceError.value);
      return;
    }
    if (!blob || !opts.activeConversationId.value) {
      opts.setStatus(blob ? '' : '说话时间太短，请按住再说');
      return;
    }
    voiceBusy.value = true;
    opts.sending.value = true;
    opts.setStatus('识别中…');
    try {
      const mention = opts.mentionId.value || undefined;
      const res = await api.sendVoiceMessage(opts.activeConversationId.value, blob, mention);
      opts.messages.value.push(res.userMessage, ...res.assistantMessages);
      const peer = opts.privatePeer(opts.activeConversation.value);
      if (peer?.id && (res.assistantMessages?.length ?? 0) > 0) {
        opts.scheduleMemoryWhisper(peer.id, opts.activeConversationId.value || undefined);
      }
      await opts.refreshConversations();
      await nextTick();
      if (opts.chatBody.value) opts.chatBody.value.scrollTop = opts.chatBody.value.scrollHeight;
      opts.setStatus('');
    } catch (err) {
      opts.setStatus(err instanceof Error ? err.message : String(err));
    } finally {
      voiceBusy.value = false;
      opts.sending.value = false;
    }
  }

  function onVoicePointerCancel() {
    voiceCancelHint.value = false;
    voiceWillCancel = false;
    voiceCancel();
  }

  function isVoiceBubble(m: ChatMessage) {
    return m.source === 'voice';
  }

  return {
    voiceActive,
    voiceBusy,
    voiceCancelHint,
    onVoicePointerDown,
    onVoicePointerMove,
    onVoicePointerUp,
    onVoicePointerCancel,
    isVoiceBubble,
  };
}
