/**
 * Chat session: conversations list, active thread, draft/send, emoji, image bubble, msg menus.
 * D-02 P0 extract from App.vue — behavior unchanged.
 * D-02 P2: voice STT via useVoiceInput; memory whisper via useMemoryUi (opts callbacks).
 */
import { computed, nextTick, onMounted, onUnmounted, ref, type Ref } from 'vue';
import { api, type ChatMessage, type Conversation } from '../api/client';
import type { Tab } from './useAppShell';

export function useChatSession(opts: {
  tab: Ref<Tab>;
  menuOpen: Ref<boolean>;
  setStatus: (msg: string) => void;
  closeProfile: () => void | Promise<void>;
  markReadOnOpen: (conversationId: string) => void;
  scheduleMemoryWhisper: (characterId: string, conversationId?: string) => void;
  clearUnreadMemoryNotices: (characterId: string, conversationId?: string) => void | Promise<void>;
  isVoiceActive: () => boolean;
}) {
  const conversations = ref<Conversation[]>([]);
  const messages = ref<ChatMessage[]>([]);
  const activeConversationId = ref<string | null>(null);
  const draft = ref('');
  const draftInput = ref<HTMLTextAreaElement | null>(null);
  const emojiOpen = ref(false);
  const emojiPopover = ref<HTMLElement | null>(null);
  const sending = ref(false);
  const chatBody = ref<HTMLElement | null>(null);
  const mentionId = ref<string>('');
  const msgMenuId = ref<string | null>(null);
  const pendingDeleteMessage = ref<ChatMessage | null>(null);
  let confirmRefreshTimers: ReturnType<typeof setTimeout>[] = [];
  let confirmRefreshGen = 0;
  const chatImageInput = ref<HTMLInputElement | null>(null);
  const imageBusy = ref(false);
  const lightboxUrl = ref<string | null>(null);

  const activeConversation = computed(
    () => conversations.value.find((c) => c.id === activeConversationId.value) ?? null,
  );

  function privatePeer(c: Conversation | null | undefined) {
    if (!c || c.type !== 'private') return null;
    return (c.members && c.members[0]) || null;
  }

  async function scrollChatToBottom() {
    await nextTick();
    if (chatBody.value) chatBody.value.scrollTop = chatBody.value.scrollHeight;
  }

  async function refreshConversations() {
    const res = await api.listConversations();
    conversations.value = res.conversations;
  }

  async function openConversation(id: string) {
    await opts.closeProfile();
    activeConversationId.value = id;
    opts.tab.value = 'chat';
    mentionId.value = '';
    opts.menuOpen.value = false;
    msgMenuId.value = null;
    const conv = conversations.value.find((c) => c.id === id) ?? null;
    const peer = privatePeer(conv);
    if (peer?.id) void opts.clearUnreadMemoryNotices(peer.id, id);
    const res = await api.listMessages(id);
    messages.value = res.messages;
    // C-03: clear badge via useUnread (server marks read on GET messages)
    opts.markReadOnOpen(id);
    await scrollChatToBottom();
  }

  async function startPrivate(characterId: string) {
    await refreshConversations();
    const existing = conversations.value.find(
      (c) => c.type === 'private' && c.members?.length === 1 && c.members[0].id === characterId,
    );
    if (existing) {
      await openConversation(existing.id);
      return;
    }
    const { conversation } = await api.createConversation([characterId], undefined, 'private');
    await refreshConversations();
    await openConversation(conversation.id);
  }

  function toggleEmojiPicker() {
    emojiOpen.value = !emojiOpen.value;
  }

  function closeEmojiPicker() {
    emojiOpen.value = false;
  }

  function insertEmoji(emoji: string) {
    const el = draftInput.value;
    const cur = draft.value;
    if (!el) {
      draft.value = cur + emoji;
      return;
    }
    const start = el.selectionStart ?? cur.length;
    const end = el.selectionEnd ?? cur.length;
    draft.value = cur.slice(0, start) + emoji + cur.slice(end);
    void nextTick(() => {
      const pos = start + emoji.length;
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  }

  function onEmojiDocPointerDown(e: PointerEvent) {
    if (!emojiOpen.value) return;
    const target = e.target as Node | null;
    if (!target) return;
    if (emojiPopover.value?.contains(target)) return;
    const btn = (target as HTMLElement).closest?.('.wx-emoji-btn');
    if (btn) return;
    closeEmojiPicker();
  }

  function onEmojiKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape' && emojiOpen.value) {
      e.preventDefault();
      closeEmojiPicker();
    }
  }


  function clearConfirmRefreshTimers() {
    for (const t of confirmRefreshTimers) clearTimeout(t);
    confirmRefreshTimers = [];
  }

  /** X05-D1: after extract may insert memory_confirm async — poll listMessages briefly. */
  function scheduleConfirmMessageRefresh() {
    const id = activeConversationId.value;
    if (!id) return;
    clearConfirmRefreshTimers();
    const gen = ++confirmRefreshGen;
    const offsetsMs = [2500, 6000, 11000, 18000, 28000, 42000];
    for (const ms of offsetsMs) {
      const t = setTimeout(async () => {
        if (gen !== confirmRefreshGen) return;
        if (activeConversationId.value !== id) return;
        try {
          const res = await api.listMessages(id);
          const next = res.messages || [];
          const prevLen = messages.value.length;
          const hasNewConfirm =
            next.length > prevLen &&
            next.slice(prevLen).some((m) => m.source === 'memory_confirm');
          const grew = next.length > prevLen;
          if (grew) {
            messages.value = next;
            if (hasNewConfirm) {
              await scrollChatToBottom();
              // stop further polls once confirm landed
              confirmRefreshGen++;
              clearConfirmRefreshTimers();
            }
          }
        } catch {
          // best-effort
        }
      }, ms);
      confirmRefreshTimers.push(t);
    }
  }

  /** X05-D1: send chip text (改/不改) without touching the composer draft. */
  async function sendQuickText(text: string) {
    closeEmojiPicker();
    const trimmed = String(text || '').trim();
    if (!trimmed || !activeConversationId.value || sending.value) return;
    sending.value = true;
    opts.setStatus('发送中…');
    try {
      const mention = mentionId.value || undefined;
      const res = await api.sendMessage(activeConversationId.value, trimmed, mention);
      messages.value.push(res.userMessage, ...res.assistantMessages);
      const peer = privatePeer(activeConversation.value);
      if (peer?.id && (res.assistantMessages?.length ?? 0) > 0) {
        opts.scheduleMemoryWhisper(peer.id, activeConversationId.value || undefined);
        scheduleConfirmMessageRefresh();
      }
      await refreshConversations();
      await scrollChatToBottom();
      opts.setStatus('');
    } catch (err) {
      opts.setStatus(err instanceof Error ? err.message : String(err));
    } finally {
      sending.value = false;
    }
  }

  async function send() {
    closeEmojiPicker();

    const text = draft.value.trim();
    if (!text || !activeConversationId.value || sending.value) return;
    sending.value = true;
    opts.setStatus('发送中…');
    try {
      const mention = mentionId.value || undefined;
      const res = await api.sendMessage(activeConversationId.value, text, mention);
      draft.value = '';
      messages.value.push(res.userMessage, ...res.assistantMessages);
      const peer = privatePeer(activeConversation.value);
      if (peer?.id && (res.assistantMessages?.length ?? 0) > 0) {
        opts.scheduleMemoryWhisper(peer.id, activeConversationId.value || undefined);
        scheduleConfirmMessageRefresh();
      }
      await refreshConversations();
      await scrollChatToBottom();
      opts.setStatus('');
    } catch (err) {
      opts.setStatus(err instanceof Error ? err.message : String(err));
    } finally {
      sending.value = false;
    }
  }

  async function onChatImageChange(ev: Event) {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file || !activeConversationId.value || sending.value || imageBusy.value) return;
    imageBusy.value = true;
    sending.value = true;
    opts.setStatus('发送图片…');
    try {
      const res = await api.sendChatImage(activeConversationId.value, file);
      messages.value.push(res.userMessage);
      await refreshConversations();
      await scrollChatToBottom();
      opts.setStatus('');
    } catch (err) {
      opts.setStatus(err instanceof Error ? err.message : String(err));
    } finally {
      imageBusy.value = false;
      sending.value = false;
    }
  }

  function openChatImagePicker() {
    if (sending.value || imageBusy.value || opts.isVoiceActive() || !activeConversationId.value) {
      opts.setStatus(!activeConversationId.value ? '请先打开会话' : '请稍候…');
      return;
    }
    chatImageInput.value?.click();
  }

  function openLightbox(url: string) {
    lightboxUrl.value = url;
  }

  function closeLightbox() {
    lightboxUrl.value = null;
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

  async function renameGroup() {
    opts.menuOpen.value = false;
    const conv = activeConversation.value;
    if (!conv || conv.type !== 'group') return;
    const next = window.prompt('修改群名', conv.title);
    if (next == null) return;
    const title = next.trim();
    if (!title) {
      opts.setStatus('群名称不能为空');
      return;
    }
    try {
      await api.renameConversation(conv.id, title);
      await refreshConversations();
      opts.setStatus('');
    } catch (err) {
      opts.setStatus(err instanceof Error ? err.message : String(err));
    }
  }

  async function deleteConversationById(id: string, title: string) {
    const ok = window.confirm(
      `确定删除会话「${title}」？\n会话与其中消息将删除，角色与空间不受影响。`,
    );
    if (!ok) return false;
    try {
      await api.deleteConversation(id);
      if (activeConversationId.value === id) {
        activeConversationId.value = null;
        messages.value = [];
      }
      await refreshConversations();
      if (!activeConversationId.value && conversations.value.length) {
        await openConversation(conversations.value[0].id);
      }
      opts.setStatus('会话已删除');
      return true;
    } catch (err) {
      opts.setStatus(err instanceof Error ? err.message : String(err));
      return false;
    }
  }

  async function dissolveGroup() {
    opts.menuOpen.value = false;
    const conv = activeConversation.value;
    if (!conv) return;
    const label = conv.type === 'group' ? '解散并删除群' : '删除会话';
    const ok = window.confirm(
      conv.type === 'group'
        ? `确定${label}「${conv.title}」？\n群消息与成员关系将删除，角色与其它会话不受影响。`
        : `确定删除会话「${conv.title}」？\n会话与其中消息将删除，角色与空间不受影响。`,
    );
    if (!ok) return;
    try {
      await api.deleteConversation(conv.id);
      activeConversationId.value = null;
      messages.value = [];
      await refreshConversations();
      if (conversations.value.length) {
        await openConversation(conversations.value[0].id);
      }
      opts.setStatus(conv.type === 'group' ? '群已解散' : '会话已删除');
    } catch (err) {
      opts.setStatus(err instanceof Error ? err.message : String(err));
    }
  }

  async function clearChat() {
    opts.menuOpen.value = false;
    const conv = activeConversation.value;
    if (!conv) return;
    const ok = window.confirm('清空当前会话的全部聊天记录？此操作不可恢复。');
    if (!ok) return;
    try {
      await api.clearMessages(conv.id);
      messages.value = [];
      await refreshConversations();
      opts.setStatus('已清空聊天记录');
    } catch (err) {
      opts.setStatus(err instanceof Error ? err.message : String(err));
    }
  }

  function deleteOneMessage(m: ChatMessage) {
    msgMenuId.value = null;
    if (!activeConversationId.value) return;
    pendingDeleteMessage.value = m;
  }

  function cancelDeleteMessage() {
    pendingDeleteMessage.value = null;
  }

  async function confirmDeleteMessage() {
    const m = pendingDeleteMessage.value;
    if (!m || !activeConversationId.value) return;
    try {
      await api.deleteMessage(activeConversationId.value, m.id);
      messages.value = messages.value.filter((x) => x.id !== m.id);
      await refreshConversations();
      pendingDeleteMessage.value = null;
    } catch (err) {
      opts.setStatus(err instanceof Error ? err.message : String(err));
    }
  }

  function toggleMsgMenu(id: string) {
    msgMenuId.value = msgMenuId.value === id ? null : id;
  }

  let conversationsPollTimer: ReturnType<typeof setInterval> | null = null;
  function startConversationsPoll() {
    stopConversationsPoll();
    conversationsPollTimer = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      // Keep sidebar unread dot fresh even when not on the chat tab.
      void refreshConversations();
    }, 20_000);
  }
  function stopConversationsPoll() {
    if (conversationsPollTimer) {
      clearInterval(conversationsPollTimer);
      conversationsPollTimer = null;
    }
  }

  function disposeChatSessionExtras() {
    clearConfirmRefreshTimers();
    confirmRefreshGen++;
  }

  onMounted(() => {
    // D-02b: emoji dismiss + conversations list poll live with session shell
    document.addEventListener('pointerdown', onEmojiDocPointerDown);
    document.addEventListener('keydown', onEmojiKeydown);
    startConversationsPoll();
  });

  onUnmounted(() => {
    stopConversationsPoll();
    disposeChatSessionExtras();
    document.removeEventListener('pointerdown', onEmojiDocPointerDown);
    document.removeEventListener('keydown', onEmojiKeydown);
  });

  return {
    conversations,
    messages,
    activeConversationId,
    activeConversation,
    draft,
    draftInput,
    emojiOpen,
    emojiPopover,
    sending,
    chatBody,
    mentionId,
    msgMenuId,
    pendingDeleteMessage,
    chatImageInput,
    imageBusy,
    lightboxUrl,
    privatePeer,
    refreshConversations,
    openConversation,
    startPrivate,
    toggleEmojiPicker,
    closeEmojiPicker,
    insertEmoji,
    onEmojiDocPointerDown,
    onEmojiKeydown,
    send,
    sendQuickText,
    onChatImageChange,
    openChatImagePicker,
    openLightbox,
    closeLightbox,
    onKeydown,
    renameGroup,
    deleteConversationById,
    dissolveGroup,
    clearChat,
    deleteOneMessage,
    cancelDeleteMessage,
    confirmDeleteMessage,
    toggleMsgMenu,
    startConversationsPoll,
    stopConversationsPoll,
    scrollChatToBottom,
  };
}
