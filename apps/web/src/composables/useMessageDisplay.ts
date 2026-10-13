/**
 * D-02b: message list / chat header display helpers (pure UI glue).
 * Extracted from App.vue — behavior unchanged. Not a state-migration knife.
 */
import type { Ref } from 'vue';
import type { Character, ChatMessage, Conversation, Profile } from '../api/client';

export type CollageMember = { id: string; name: string; avatar_path?: string | null };

export type PrivatePeer = {
  id: string;
  name: string;
  avatar_path?: string | null;
} | null;

export function useMessageDisplay(opts: {
  messages: Ref<ChatMessage[]>;
  activeConversation: Ref<Conversation | null | undefined> | { value: Conversation | null | undefined };
  meProfile: Ref<Profile | null | undefined> | { value: Profile | null | undefined };
  characters: Ref<Character[]>;
  privatePeer: (c: Conversation | null | undefined) => PrivatePeer;
  sending: Ref<boolean>;
  sendQuickText: (text: string) => void | Promise<void>;
}) {
  function avatarText(name?: string) {
    return (name || '?').slice(0, 1);
  }

  function collageMembers(c: Conversation | null | undefined): CollageMember[] {
    if (!c || c.type !== 'group') return [];
    const me: CollageMember = {
      id: 'me',
      name: opts.meProfile.value?.name || '旅人',
      avatar_path: opts.meProfile.value?.avatar_path || null,
    };
    const chars = (c.members || []).map((m) => ({
      id: m.id,
      name: m.name,
      avatar_path: m.avatar_path ?? null,
    }));
    // user counts as one seat; fill remaining with characters (max 4 tiles)
    return [me, ...chars].slice(0, 4);
  }

  function speakerKey(m: ChatMessage) {
    if (m.role === 'user') return 'user';
    return `assistant:${m.character_id || m.character_name || 'unknown'}`;
  }

  function dayKey(iso?: string) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  }

  function isContinued(i: number) {
    if (i <= 0) return false;
    const prev = opts.messages.value[i - 1];
    const cur = opts.messages.value[i];
    if (!prev || !cur) return false;
    if (speakerKey(prev) !== speakerKey(cur)) return false;
    return dayKey(prev.created_at) === dayKey(cur.created_at);
  }

  function dayLabel(iso?: string) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const now = new Date();
    const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startMsg = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const diffDays = Math.round((startToday.getTime() - startMsg.getTime()) / 86400000);
    if (diffDays === 0) return '今天';
    if (diffDays === 1) return '昨天';
    const mo = String(d.getMonth() + 1).padStart(2, '0');
    const da = String(d.getDate()).padStart(2, '0');
    if (d.getFullYear() === now.getFullYear()) return `${mo}-${da}`;
    return `${d.getFullYear()}-${mo}-${da}`;
  }

  function showDayDivider(i: number) {
    if (i === 0) return true;
    const prev = opts.messages.value[i - 1];
    const cur = opts.messages.value[i];
    if (!prev || !cur) return false;
    return dayKey(prev.created_at) !== dayKey(cur.created_at);
  }

  function formatTime(iso?: string) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const now = new Date();
    if (d.toDateString() === now.toDateString()) return `${hh}:${mm}`;
    const mo = String(d.getMonth() + 1).padStart(2, '0');
    const da = String(d.getDate()).padStart(2, '0');
    if (d.getFullYear() === now.getFullYear()) return `${mo}-${da}`;
    return `${d.getFullYear()}-${mo}-${da}`;
  }

  function isMemoryConfirmPending(m: ChatMessage, index: number) {
    if (m.role !== 'assistant' || m.source !== 'memory_confirm') return false;
    for (let j = index + 1; j < opts.messages.value.length; j++) {
      if (opts.messages.value[j].role === 'user') return false;
    }
    return true;
  }

  function onMemoryConfirmChoice(choice: '改' | '不改') {
    if (opts.sending.value) return;
    void opts.sendQuickText(choice);
  }

  function speakerName(m: ChatMessage) {
    if (m.role === 'user') return '我';
    return m.character_name || opts.activeConversation.value?.title || '角色';
  }

  /** Same avatar source as contacts / timeline: uploaded path, else letter circle. */
  function messageAvatarUrl(m: ChatMessage): string | null {
    if (m.role === 'user') return opts.meProfile.value?.avatar_path || null;
    if (m.character_id) {
      const fromList = opts.characters.value.find((c) => c.id === m.character_id);
      if (fromList?.avatar_path) return fromList.avatar_path;
      const fromMembers = opts.activeConversation.value?.members?.find((mem) => mem.id === m.character_id);
      if (fromMembers?.avatar_path) return fromMembers.avatar_path;
    }
    const peer = opts.privatePeer(opts.activeConversation.value);
    if (peer?.avatar_path && opts.activeConversation.value?.type === 'private') return peer.avatar_path;
    return null;
  }

  function messageAvatarLetter(m: ChatMessage) {
    if (m.role === 'user') return avatarText(opts.meProfile.value?.name || '我');
    return avatarText(m.character_name || opts.activeConversation.value?.title || '?');
  }

  function escapeHtml(s: string) {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function mentionHtml(text: string) {
    return escapeHtml(text).replace(
      /@[\w\u4e00-\u9fff·\-\.]+/g,
      '<span class="wx-mention">$&</span>',
    );
  }

  function headerStatus(c: Conversation | null) {
    if (!c) return '';
    if (c.type === 'group') {
      const n = c.members?.length || 0;
      return n ? `${n} 位成员` : '群聊';
    }
    return '私聊';
  }

  function headerAvatar(c: Conversation | null | undefined) {
    const peer = opts.privatePeer(c);
    if (peer?.avatar_path) return peer.avatar_path;
    return null;
  }

  return {
    avatarText,
    collageMembers,
    speakerKey,
    isContinued,
    dayKey,
    dayLabel,
    showDayDivider,
    formatTime,
    isMemoryConfirmPending,
    onMemoryConfirmChoice,
    speakerName,
    messageAvatarUrl,
    messageAvatarLetter,
    escapeHtml,
    mentionHtml,
    headerStatus,
    headerAvatar,
  };
}
