<script setup lang="ts">
/**
 * Agent-chat web shell (Vue 3 + Vite).
 *
 * Layout: left nav → mid list (chat / contacts / space tools) → main pane
 * (profile | moments feed | conversation). Talks to apps/server via ./api/client.
 * Composables: useMoments, usePersonaEditor, useProactiveSettings (ARCH-3),
 * useTtsPlayback (X-06), useMessageReactions (UI-5), useUnread (D-02 C-03),
 * useAppShell / useChatSession (D-02 P0), useProfileAppearance / useContactsImport (P1),
 * useMemoryUi / useVoiceInput (P2);
 * Motion tokens: constants/motion.ts + --motion-* CSS vars (UI-1 foundation);
 * UI-6 group alive: ambient avatar float + group typing avatars (CSS; reuses sending).
 * styles in ./styles/wechat.css.
 */

import { onMounted, onUnmounted, ref, watch } from 'vue';
import { api, type ChatMessage, type Conversation } from './api/client';
import { useMoments } from './composables/useMoments';
import { usePersonaEditor } from './composables/usePersonaEditor';
import { useProactiveSettings } from './composables/useProactiveSettings';
import { useTtsPlayback } from './composables/useTtsPlayback';
import { useMessageReactions } from './composables/useMessageReactions';
import { useUnread } from './composables/useUnread';
import { useAppShell } from './composables/useAppShell';
import { useChatSession } from './composables/useChatSession';
import { useProfileAppearance } from './composables/useProfileAppearance';
import { useContactsImport } from './composables/useContactsImport';
import { useMemoryUi } from './composables/useMemoryUi';
import { useVoiceInput } from './composables/useVoiceInput';
import { EMOJI_WHITELIST } from './constants/emojiWhitelist';


// D-02 P0/P1/P2: late-bound bridges so shell/chat/profile/contacts/memory can close over helpers below.
let openConversation!: (id: string) => Promise<void>;
let deleteConversationById!: (id: string, title: string) => Promise<boolean>;
let markReadOnOpen!: (conversationId: string) => void;
let closeProfile!: () => Promise<void>;
let conversations!: import('vue').Ref<Conversation[]>;
let applyProfileMoments!: (list: import('./api/client').Moment[]) => void;
let loadProactiveSettings!: () => Promise<void>;
let refreshConversations!: () => Promise<void>;
let startPrivate!: (characterId: string) => Promise<void>;
let refreshMoments!: () => Promise<void>;
let refreshCharacters!: () => Promise<void>;
let activeConversationId!: import('vue').Ref<string | null>;
let messages!: import('vue').Ref<ChatMessage[]>;
let profileView!: import('vue').Ref<import('./composables/useMoments').ProfileView>;
const status = ref('');

const {
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
} = useMemoryUi({
  getActiveConversationId: () => activeConversationId?.value ?? null,
  getProfileView: () => profileView?.value ?? null,
});
const {
  playingId: ttsPlayingId,
  loadingId: ttsLoadingId,
  progressRatio: ttsProgressRatio,
  play: playTts,
} = useTtsPlayback({
  setStatus: (msg) => {
    status.value = msg;
  },
});
const setStatus = (msg: string) => {
  status.value = msg;
};

const {
  profileView: profileViewRef,
  profile,
  meProfile,
  mediaBusy,
  uiTheme,
  uiBgOpacity,
  uiSpaceBgOpacity,
  appearanceBusy,
  avatarFileInput,
  bgFileInput,
  spaceBgFileInput,
  profileLoading,
  profileEditing,
  editMood,
  editBio,
  THEME_PRESETS,
  closeProfile: closeProfileImpl,
  selectTheme,
  onBgOpacityInput,
  onBgOpacityCommit,
  onSpaceBgOpacityInput,
  onSpaceBgOpacityCommit,
  refreshMeProfile,
  onAvatarFileChange,
  onBgFileChange,
  onSpaceBgFileChange,
  clearAvatar,
  clearBg,
  clearSpaceBg,
  openMyProfile,
  openCharacterProfile,
  saveMyProfile,
  messageFromProfile,
  onMsgAvatarClick,
} = useProfileAppearance({
  setStatus,
  applyProfileMoments: (list) => applyProfileMoments(list),
  loadProactiveSettings: () => loadProactiveSettings(),
  refreshCharacters: () => refreshCharacters(),
  refreshConversations: () => refreshConversations(),
  startPrivate: (id) => startPrivate(id),
  profileMemories,
  loadProfileMemories,
  clearProfileMemories,
});
profileView = profileViewRef;
closeProfile = closeProfileImpl;

const {
  characters,
  selectedForGroup,
  creatingGroup,
  groupTitleDraft,
  groupSearch,
  contactMenuId,
  fileInput,
  pendingOverwriteImport,
  pendingDeleteCharacter,
  groupPickableCharacters,
  refreshCharacters: refreshCharactersImpl,
  openGroupCreator,
  cancelGroupCreator,
  toggleGroupPick,
  toggleContactMenu,
  createGroup,
  onImport,
  askDeleteCharacter,
  cancelDeleteCharacter,
  confirmDeleteCharacter,
  cancelOverwriteImport,
  confirmOverwriteImport,
  onLeaveContactsTab,
} = useContactsImport({
  setStatus,
  profileView,
  closeProfile: () => closeProfile(),
  refreshConversations: () => refreshConversations(),
  openConversation: (id) => openConversation(id),
  refreshMoments: () => refreshMoments(),
  clearOpenPrivateChatIfPeer: (characterId: string) => {
    const open = conversations.value.find((c) => c.id === activeConversationId.value);
    if (
      open &&
      open.type === 'private' &&
      open.members?.length === 1 &&
      open.members[0].id === characterId
    ) {
      activeConversationId.value = null;
      messages.value = [];
    }
  },
});
refreshCharacters = refreshCharactersImpl;

const {
  tab,
  menuOpen,
  listCtxId,
  listCtxPos,
  swipeId,
  swipeX,
  midTitle,
  switchTab,
  onListContextMenu,
  onListCtxDelete,
  deleteFromList,
  onSwipeStart,
  onSwipeMove,
  onSwipeEnd,
  swipeStyle,
  onListItemClick,
} = useAppShell({
  creatingGroup,
  hasProfile: () => !!profileView.value,
  closeProfile: () => closeProfile(),
  openConversation: (id) => openConversation(id),
  deleteConversationById: (id, title) => deleteConversationById(id, title),
  findConversation: (id) => conversations.value.find((c) => c.id === id),
});

const {
  conversations: conversationsRef,
  messages: messagesRef,
  activeConversationId: activeConversationIdRef,
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
  refreshConversations: refreshConversationsImpl,
  openConversation: openConversationImpl,
  startPrivate: startPrivateImpl,
  toggleEmojiPicker,
  closeEmojiPicker,
  insertEmoji,
  onEmojiDocPointerDown,
  onEmojiKeydown,
  send,
  onChatImageChange,
  openChatImagePicker,
  openLightbox,
  closeLightbox,
  onKeydown,
  renameGroup,
  deleteConversationById: deleteConversationByIdImpl,
  dissolveGroup,
  clearChat,
  deleteOneMessage,
  cancelDeleteMessage,
  confirmDeleteMessage,
  toggleMsgMenu,
  startConversationsPoll,
  stopConversationsPoll,
  scrollChatToBottom,
} = useChatSession({
  tab,
  menuOpen,
  setStatus,
  closeProfile: () => closeProfile(),
  markReadOnOpen: (id) => markReadOnOpen(id),
  scheduleMemoryWhisper: (characterId, conversationId) =>
    scheduleMemoryWhisper(characterId, conversationId),
  clearUnreadMemoryNotices: (characterId, conversationId) =>
    clearUnreadMemoryNotices(characterId, conversationId),
  isVoiceActive: () => voiceActive.value,
});
conversations = conversationsRef;
messages = messagesRef;
activeConversationId = activeConversationIdRef;
openConversation = openConversationImpl;
deleteConversationById = deleteConversationByIdImpl;
refreshConversations = refreshConversationsImpl;
startPrivate = startPrivateImpl;

const {
  voiceActive,
  voiceBusy,
  voiceCancelHint,
  onVoicePointerDown,
  onVoicePointerMove,
  onVoicePointerUp,
  onVoicePointerCancel,
  isVoiceBubble,
} = useVoiceInput({
  sending,
  activeConversationId,
  activeConversation,
  messages,
  mentionId,
  chatBody,
  privatePeer,
  scheduleMemoryWhisper,
  refreshConversations: () => refreshConversations(),
  setStatus,
});


const { totalUnread, markReadOnOpen: markReadOnOpenImpl, hasUnread, badgeText } = useUnread(conversations);
markReadOnOpen = markReadOnOpenImpl;

const { REACTION_QUICK, toggleReaction } = useMessageReactions(
  messages,
  activeConversationId,
  (msg) => {
    status.value = msg;
  },
);


const {
  proactiveEnabled,
  proactiveBusy,
  proactiveSentToday,
  proactiveDailyCap,
  proactiveInQuiet,
  proactiveQuietStart,
  proactiveQuietEnd,
  loadProactiveSettings: loadProactiveSettingsImpl,
  toggleProactiveEnabled,
} = useProactiveSettings({ setStatus });
loadProactiveSettings = loadProactiveSettingsImpl;

const {
  moments,
  profileMoments,
  applyProfileMoments: applyProfileMomentsImpl,
  momentsFilterId,
  commentDrafts,
  momentMenuId,
  pendingDeleteMoment,
  momentComposerOpen,
  momentDraft,
  momentImageFile,
  momentImagePreview,
  momentPostBusy,
  momentImageInput,
  expandedLikeMomentId,
  momentsToday,
  momentsTodayAuthors,
  spaceCharacterStats,
  filteredMoments,
  setMomentsFilter,
  clearMomentsFilter,
  refreshMoments: refreshMomentsImpl,
  toggleLikeList,
  openMomentComposer,
  closeMomentComposer,
  clearMomentImage,
  onMomentImagePick,
  submitMyMoment,
  openMomentAuthor,
  letThemPost,
  toggleMomentMenu,
  askDeleteMoment,
  cancelDeleteMoment,
  confirmDeleteMoment,
  toggleLike,
  submitComment,
} = useMoments({
  setStatus,
  characters,
  profileView,
  tab,
  openMyProfile: () => openMyProfile(),
  openCharacterProfile: (id: string) => openCharacterProfile(id),
});
applyProfileMoments = applyProfileMomentsImpl;
refreshMoments = refreshMomentsImpl;

const {
  personaEditorOpen,
  personaEditorBusy,
  personaEditorId,
  personaDraft,
  openPersonaEditor,
  closePersonaEditor,
  savePersonaEditor,
} = usePersonaEditor({
  setStatus,
  clearContactMenu: () => {
    contactMenuId.value = null;
  },
  refreshCharacters: () => refreshCharacters(),
  reloadCharacterProfileIfOpen: async (id: string) => {
    if (profileView.value?.kind === 'character' && profileView.value.id === id) {
      await openCharacterProfile(id);
    }
  },
});

function avatarText(name?: string) {
  return (name || '?').slice(0, 1);
}

type CollageMember = { id: string; name: string; avatar_path?: string | null };

function collageMembers(c: Conversation | null | undefined): CollageMember[] {
  if (!c || c.type !== 'group') return [];
  const me: CollageMember = {
    id: 'me',
    name: meProfile.value?.name || '旅人',
    avatar_path: meProfile.value?.avatar_path || null,
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

function isContinued(i: number) {
  if (i <= 0) return false;
  const prev = messages.value[i - 1];
  const cur = messages.value[i];
  if (!prev || !cur) return false;
  if (speakerKey(prev) !== speakerKey(cur)) return false;
  return dayKey(prev.created_at) === dayKey(cur.created_at);
}

function dayKey(iso?: string) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
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
  const prev = messages.value[i - 1];
  const cur = messages.value[i];
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

function speakerName(m: ChatMessage) {
  if (m.role === 'user') return '我';
  return m.character_name || activeConversation.value?.title || '角色';
}

/** Same avatar source as contacts / timeline: uploaded path, else letter circle. */
function messageAvatarUrl(m: ChatMessage): string | null {
  if (m.role === 'user') return meProfile.value?.avatar_path || null;
  if (m.character_id) {
    const fromList = characters.value.find((c) => c.id === m.character_id);
    if (fromList?.avatar_path) return fromList.avatar_path;
    const fromMembers = activeConversation.value?.members?.find((mem) => mem.id === m.character_id);
    if (fromMembers?.avatar_path) return fromMembers.avatar_path;
  }
  const peer = privatePeer(activeConversation.value);
  if (peer?.avatar_path && activeConversation.value?.type === 'private') return peer.avatar_path;
  return null;
}

function messageAvatarLetter(m: ChatMessage) {
  if (m.role === 'user') return avatarText(meProfile.value?.name || '我');
  return avatarText(m.character_name || activeConversation.value?.title || '?');
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
    '<span class="wx-mention">$&</span>'
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
  const peer = privatePeer(c);
  if (peer?.avatar_path) return peer.avatar_path;
  return null;
}


watch(tab, (t) => {
  if (t !== 'contacts') {
    onLeaveContactsTab();
  }
  if (t !== 'moments') {
    clearMomentsFilter();
  }
  if (t === 'moments') void refreshMoments();
  if (t === 'contacts') void refreshCharacters();
  if (t === 'chat') void refreshConversations();
});


onMounted(async () => {
  document.addEventListener('pointerdown', onEmojiDocPointerDown);
  document.addEventListener('keydown', onEmojiKeydown);
  await refreshMeProfile();
  try {
    const h = await api.health();
    status.value = h.ok ? '' : '后端异常';
  } catch {
    status.value = '无法连接后端（请先启动 apps/server）';
  }
  await Promise.all([refreshCharacters(), refreshConversations(), refreshMoments()]);
  await loadProactiveSettings();
});

onUnmounted(() => {
  stopConversationsPoll();
  document.removeEventListener('pointerdown', onEmojiDocPointerDown);
  document.removeEventListener('keydown', onEmojiKeydown);
  disposeMemoryUi();
});
</script>

<template>
  <div class="wx-shell" @click="menuOpen = false; msgMenuId = null; listCtxId = null; momentMenuId = null; contactMenuId = null">
    <aside class="wx-nav">
      <div class="wx-nav-avatar" title="我的主页" role="button" @click.stop="openMyProfile">
        <img v-if="meProfile?.avatar_path" :src="meProfile.avatar_path" alt="" />
        <template v-else>{{ avatarText(meProfile?.name || '旅人') }}</template>
      </div>
      <button class="wx-nav-btn" :class="{ active: tab === 'chat' }" title="消息" aria-label="消息" @click="switchTab('chat')">
        <svg class="wx-nav-icon" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
      
        <Transition name="wx-motion-badge">
        <span v-if="totalUnread > 0" class="wx-nav-dot" aria-hidden="true"></span>
      </Transition>
      </button>
      <button class="wx-nav-btn" :class="{ active: tab === 'contacts' }" title="通讯录" aria-label="通讯录" @click="switchTab('contacts')">
        <svg class="wx-nav-icon" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
      </button>
      <button class="wx-nav-btn" :class="{ active: tab === 'moments' }" title="空间" aria-label="空间" @click="switchTab('moments')">
        <svg class="wx-nav-icon" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
      </button>
    </aside>

    <section class="wx-mid">
      <div class="wx-mid-header">
        <span>{{ midTitle }}</span>
        <div class="actions">
          <template v-if="tab === 'contacts' && !creatingGroup">
            <button class="wx-mini-btn primary" @click="fileInput?.click()">导入角色</button>
            <button class="wx-mini-btn" @click="openGroupCreator">创建群聊</button>
          </template>
          <template v-else-if="tab === 'contacts' && creatingGroup">
            <button class="wx-mini-btn" @click="cancelGroupCreator">取消</button>
            <button
              class="wx-mini-btn primary"
              :disabled="selectedForGroup.length < 2"
              @click="createGroup"
            >
              确认创建
            </button>
          </template>
          <template v-else-if="tab === 'moments'">
            <span class="wx-hint">动态</span>
          </template>
        </div>
      </div>
      <input
        ref="fileInput"
        type="file"
        accept=".json,.png,application/json,image/png"
        style="display: none"
        @change="onImport"
      />
      <input
        ref="avatarFileInput"
        type="file"
        accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"
        style="display: none"
        @change="onAvatarFileChange"
      />
      <input
        ref="bgFileInput"
        type="file"
        accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"
        style="display: none"
        @change="onBgFileChange"
      />
      <input
        ref="spaceBgFileInput"
        type="file"
        accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"
        style="display: none"
        @change="onSpaceBgFileChange"
      />
      <input
        ref="chatImageInput"
        type="file"
        accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"
        style="display: none"
        @change="onChatImageChange"
      />

      <div v-if="tab === 'chat'" class="wx-list">
        <div v-for="c in conversations" :key="c.id" class="wx-swipe-row">
          <button class="wx-swipe-delete" @click.stop="deleteFromList(c)">删除</button>
          <div
            class="wx-list-item wx-swipe-front"
            :class="{ active: c.id === activeConversationId }"
            :style="swipeStyle(c.id)"
            @click="onListItemClick(c)"
            @contextmenu="onListContextMenu($event, c)"
            @pointerdown="onSwipeStart($event, c.id)"
            @pointermove="onSwipeMove"
            @pointerup="onSwipeEnd"
            @pointercancel="onSwipeEnd"
          >
            <div v-if="collageMembers(c).length" class="wx-avatar collage" :data-n="collageMembers(c).length">
              <span v-for="mem in collageMembers(c)" :key="mem.id">
                <img v-if="mem.avatar_path" :src="mem.avatar_path" alt="" />
                <template v-else>{{ avatarText(mem.name) }}</template>
              </span>
            </div>
            <div v-else class="wx-avatar">
              <img v-if="privatePeer(c)?.avatar_path" :src="privatePeer(c)!.avatar_path!" alt="" />
              <template v-else>{{ avatarText(c.title) }}</template>
            </div>
            <div class="wx-list-meta">
              <div class="wx-list-top">
                <div class="wx-list-title">{{ c.title }}</div>
                <div class="wx-list-time">{{ formatTime(c.updated_at) }}</div>
              </div>
              <div class="wx-list-sub">{{ c.last_message || (c.type === 'group' ? '群聊' : '私聊') }}</div>
            </div>
            <Transition name="wx-motion-badge">
            <span v-if="hasUnread(c.unread_count)" class="wx-unread-badge">{{ badgeText(c.unread_count) }}</span>
          </Transition>
          </div>
        </div>
        <div
          v-if="listCtxId"
          class="wx-menu list-ctx"
          :style="{ left: listCtxPos.x + 'px', top: listCtxPos.y + 'px' }"
          @click.stop
        >
          <button
            class="danger"
            @click="onListCtxDelete"
          >
            删除会话
          </button>
        </div>
        <div v-if="!conversations.length" class="wx-empty" style="padding: 40px 16px">
          暂无会话<br />去通讯录导入角色并开聊
        </div>
      </div>

      <div v-else-if="tab === 'contacts' && creatingGroup" class="wx-group-create">
        <div class="wx-group-create-fields">
          <input
            v-model="groupTitleDraft"
            class="wx-search"
            placeholder="群名称（可选）"
          />
          <input
            v-model="groupSearch"
            class="wx-search"
            placeholder="搜索角色"
          />
          <div class="wx-hint">已选 {{ selectedForGroup.length }} 人（至少 2 人）</div>
        </div>
        <div class="wx-list wx-group-pick-list">
          <label
            v-for="ch in groupPickableCharacters"
            :key="ch.id"
            class="wx-list-item wx-group-pick-item"
          >
            <input
              type="checkbox"
              :checked="selectedForGroup.includes(ch.id)"
              @change="toggleGroupPick(ch.id)"
            />
            <div class="wx-avatar">
              <img v-if="ch.avatar_path" :src="ch.avatar_path" alt="" />
              <template v-else>{{ avatarText(ch.name) }}</template>
            </div>
            <div class="wx-list-meta">
              <div class="wx-list-title">{{ ch.name }}</div>
              <div class="wx-list-sub">{{ ch.description || '角色' }}</div>
            </div>
          </label>
          <div v-if="!groupPickableCharacters.length" class="wx-empty" style="padding: 40px 16px">
            没有匹配的角色
          </div>
        </div>
      </div>

      <div v-else-if="tab === 'contacts'" class="wx-list">
        <div v-for="ch in characters" :key="ch.id" class="wx-list-item wx-contact-row">
          <div class="wx-avatar" role="button" title="查看主页" @click.stop="openCharacterProfile(ch.id)">
            <img v-if="ch.avatar_path" :src="ch.avatar_path" alt="" />
            <template v-else>{{ avatarText(ch.name) }}</template>
          </div>
          <div class="wx-list-meta" @click.stop="openCharacterProfile(ch.id)">
            <div class="wx-list-title">{{ ch.name }}</div>
            <div class="wx-list-sub">{{ ch.description || '查看主页' }}</div>
          </div>
          <button class="wx-mini-btn primary" @click.stop="startPrivate(ch.id)">发消息</button>
          <div class="wx-contact-more" @click.stop>
            <button class="wx-contact-more-btn" title="更多" @click="toggleContactMenu(ch.id)">⋯</button>
            <div v-if="contactMenuId === ch.id" class="wx-menu contact">
              <button @click="contactMenuId = null; openCharacterProfile(ch.id)">查看主页</button>
              <button @click="contactMenuId = null; openPersonaEditor(ch.id)">编辑人设</button>
              <button @click="contactMenuId = null; letThemPost(ch.id)">让 TA 发动态</button>
              <button class="danger" @click="askDeleteCharacter(ch.id, ch.name)">删除角色</button>
            </div>
          </div>
        </div>
        <div v-if="!characters.length" class="wx-empty" style="padding: 40px 16px">
          还没有角色<br />点击「导入角色」选择 samples/characters/*.json
        </div>
      </div>
      <div v-else class="wx-space-mid">
        <div class="wx-space-overview">
          <div class="wx-space-overview-title">今日概览</div>
          <div class="wx-space-overview-stat">
            <span class="n">{{ momentsToday.length }}</span>
            <span class="l">条动态</span>
          </div>
          <div v-if="momentsTodayAuthors.length" class="wx-space-overview-who">
            <span class="l">今天发过：</span>
            <button
              v-for="a in momentsTodayAuthors"
              :key="a.id"
              type="button"
              class="wx-space-chip"
              @click="setMomentsFilter(a.id)"
            >
              <span class="wx-avatar xs">
                <img v-if="a.avatar_path" :src="a.avatar_path" alt="" />
                <template v-else>{{ avatarText(a.name) }}</template>
              </span>
              {{ a.name }}
            </button>
          </div>
          <div v-else class="wx-hint">今天还没有新动态</div>
          <button type="button" class="wx-mini-btn" style="margin-top:10px" @click="switchTab('contacts')">
            去通讯录发动态
          </button>
        </div>
        <div class="wx-space-filter-head">
          <span>按角色看</span>
          <button
            type="button"
            class="wx-space-all"
            :class="{ active: !momentsFilterId }"
            @click="setMomentsFilter(null)"
          >全部</button>
        </div>
        <div class="wx-list wx-space-filter-list">
          <button
            v-for="ch in spaceCharacterStats"
            :key="ch.id"
            type="button"
            class="wx-list-item wx-space-filter-item"
            :class="{ active: momentsFilterId === ch.id }"
            @click="setMomentsFilter(ch.id)"
          >
            <div class="wx-avatar">
              <img v-if="ch.avatar_path" :src="ch.avatar_path" alt="" />
              <template v-else>{{ avatarText(ch.name) }}</template>
            </div>
            <div class="wx-list-meta">
              <div class="wx-list-title">{{ ch.name }}</div>
              <div class="wx-list-sub">{{ ch.count ? ch.count + ' 条动态' : '暂无动态' }}</div>
            </div>
          </button>
          <div v-if="!spaceCharacterStats.length" class="wx-empty" style="padding: 24px 16px">
            还没有角色
          </div>
        </div>
      </div>
    </section>

    <main class="wx-main">
      <template v-if="profileView">
        <div class="wx-profile">
          <div class="wx-profile-bar">
            <button class="wx-mini-btn" @click="closeProfile">← 返回</button>
            <span class="wx-hint">{{ profileLoading ? '加载中…' : (profileView.kind === 'user' ? '我的主页' : '角色主页') }}</span>
            <span class="wx-hint" style="margin-left:auto">{{ status }}</span>
          </div>
          <div class="wx-profile-card">
            <div class="wx-profile-cover">
              <div
                v-if="profile?.bg_path"
                class="wx-cover-photo"
                :style="{ backgroundImage: 'url(' + profile.bg_path + ')', opacity: uiBgOpacity }"
              ></div>
              <div class="wx-cover-actions">
                <button type="button" class="wx-mini-btn" :disabled="mediaBusy" @click.stop="bgFileInput?.click()">更换背景</button>
                <button
                  v-if="profile?.bg_path"
                  type="button"
                  class="wx-mini-btn"
                  :disabled="mediaBusy"
                  @click.stop="clearBg"
                >恢复默认</button>
              </div>
            </div>
            <div class="wx-profile-hero">
              <div class="wx-avatar lg" role="button" title="更换头像" @click="avatarFileInput?.click()">
                <img v-if="profile?.avatar_path" :src="profile.avatar_path" alt="" />
                <template v-else>{{ avatarText(profile?.name || (profileView.kind === 'user' ? '旅人' : '?')) }}</template>
              </div>
              <div class="wx-profile-id">
                <div class="wx-profile-name">{{ profile?.name || '…' }}</div>
                <div class="wx-profile-mood">
                  <template v-if="profileView.kind === 'user' && profileEditing">
                    <input v-model="editMood" class="wx-search" maxlength="80" placeholder="说说（可空）" />
                  </template>
                  <template v-else>
                    <span class="wx-profile-mood-text">{{ profile?.mood ? '「' + profile.mood + '」' : '「说说」' }}</span>
                  </template>
                </div>
              </div>
              <div class="wx-profile-actions">
                <template v-if="profileView.kind === 'user'">
                  <button v-if="!profileEditing" class="wx-mini-btn primary" @click="profileEditing = true">编辑</button>
                  <template v-else>
                    <button class="wx-mini-btn primary" @click="saveMyProfile">保存</button>
                    <button class="wx-mini-btn" @click="profileEditing = false; editMood = profile?.mood || ''; editBio = profile?.bio || ''">取消</button>
                  </template>
                </template>
                <template v-else>
                  <button class="wx-mini-btn primary" @click="messageFromProfile">发消息</button>
                  <button
                    class="wx-mini-btn"
                    :disabled="personaEditorBusy"
                    @click="openPersonaEditor(profileView.id)"
                  >
                    编辑人设
                  </button>
                  <button
                    class="wx-mini-btn danger"
                    @click="askDeleteCharacter(profileView.id, profile?.name || '角色')"
                  >
                    删除角色
                  </button>
                </template>
              </div>
            </div>
            <div class="wx-profile-media">
              <button type="button" class="wx-mini-btn" :disabled="mediaBusy" @click="avatarFileInput?.click()">更换头像</button>
              <button
                v-if="profile?.avatar_path"
                type="button"
                class="wx-mini-btn"
                :disabled="mediaBusy"
                @click="clearAvatar"
              >恢复默认头像</button>
            </div>

            <div v-if="profileView.kind === 'user'" class="wx-appearance">
              <div class="wx-appearance-title">外观</div>
              <div class="wx-theme-grid">
                <button
                  v-for="t in THEME_PRESETS"
                  :key="t.id"
                  type="button"
                  class="wx-theme-chip"
                  :class="{ active: uiTheme === t.id }"
                  :disabled="appearanceBusy"
                  :title="t.hint"
                  @click="selectTheme(t.id)"
                >
                  <div class="wx-theme-swatch" :class="t.id"></div>
                  <div class="wx-theme-chip-label">{{ t.label }}</div>
                  <div class="wx-theme-chip-hint">{{ t.id }}</div>
                </button>
              </div>
              <div class="wx-opacity-row" :class="{ 'is-disabled': !profile?.bg_path }">
                <label>
                  <span>主页背景透明度</span>
                  <span>{{ Math.round(uiBgOpacity * 100) }}%</span>
                </label>
                <input
                  type="range"
                  min="0.2"
                  max="1"
                  step="0.05"
                  :value="uiBgOpacity"
                  :disabled="!profile?.bg_path || appearanceBusy"
                  @input="onBgOpacityInput"
                  @change="onBgOpacityCommit"
                />
              </div>
              <div class="wx-opacity-row" :class="{ 'is-disabled': !meProfile?.space_bg_path }">
                <label>
                  <span>空间背景透明度</span>
                  <span>{{ Math.round(uiSpaceBgOpacity * 100) }}%</span>
                </label>
                <input
                  type="range"
                  min="0.2"
                  max="1"
                  step="0.05"
                  :value="uiSpaceBgOpacity"
                  :disabled="!meProfile?.space_bg_path || appearanceBusy"
                  @input="onSpaceBgOpacityInput"
                  @change="onSpaceBgOpacityCommit"
                />
              </div>
            

              <div class="wx-proactive-row">
                <label class="wx-proactive-label">
                  <input
                    type="checkbox"
                    :checked="proactiveEnabled"
                    :disabled="proactiveBusy"
                    @change="toggleProactiveEnabled(($event.target as HTMLInputElement).checked)"
                  />
                  <span>允许角色主动找你</span>
                </label>
                <p class="wx-proactive-cap">
                  今日主动 {{ proactiveSentToday }} / {{ proactiveDailyCap }}
                  <span v-if="proactiveInQuiet" class="wx-proactive-quiet"> · 静默中（{{ proactiveQuietStart }}–{{ proactiveQuietEnd }}）</span>
                </p>
                <p class="wx-proactive-hint">满后只停私聊先开口，不挡空间赞评。关闭开关则两者都停。</p>
              </div>
            </div>

            <div class="wx-profile-bio">
              <div class="wx-profile-label">简介</div>
              <template v-if="profileView.kind === 'user' && profileEditing">
                <textarea v-model="editBio" class="wx-profile-bio-input" rows="3" maxlength="500" placeholder="写一点关于自己…" />
              </template>
              <template v-else>
                <p>{{ profile?.bio || '暂无简介' }}</p>
              </template>
            </div>
          </div>
          <div v-if="profileView?.kind === 'character' && profileMemories.length" class="wx-profile-memories">
            <div class="wx-profile-label">记得的事</div>
            <ul class="wx-memory-list">
              <li
                v-for="m in profileMemories"
                :key="m.id"
                :class="{ 'wx-memory-new': memoryHighlightIds.includes(m.id) }"
              >{{ m.content }}</li>
            </ul>
          </div>
          <div class="wx-profile-moments">
            <div class="wx-profile-label-row">
              <div class="wx-profile-label">动态</div>
              <button
                v-if="profileView.kind === 'user'"
                type="button"
                class="wx-mini-btn primary"
                @click="openMomentComposer"
              >发动态</button>
            </div>
            <div v-for="m in profileMoments" :key="m.id" class="wx-moment-card">
              <div class="wx-moment-head">
                <div class="wx-avatar">
                  <img v-if="m.avatar_path" :src="m.avatar_path" alt="" />
                  <template v-else>{{ avatarText(m.character_name || profile?.name) }}</template>
                </div>
                <div class="wx-moment-who">
                  <span class="pn">{{ m.character_name || profile?.name }}</span>
                  <span class="wx-moment-time">{{ formatTime(m.created_at) }}</span>
                </div>
                <div v-if="profileView.kind === 'user'" class="wx-moment-more" @click.stop>
                  <button class="wx-moment-more-btn" title="更多" @click="toggleMomentMenu(m.id)">⋯</button>
                  <div v-if="momentMenuId === m.id" class="wx-menu moment">
                    <button class="danger" @click="askDeleteMoment(m)">删除</button>
                  </div>
                </div>
              </div>
              <div class="wx-moment-content">{{ m.content }}</div>
              <button
                v-if="m.image_path"
                type="button"
                class="wx-moment-image"
                @click="openLightbox(m.image_path)"
              >
                <img :src="m.image_path" alt="动态配图" />
              </button>
            </div>
            <div v-if="!profileMoments.length" class="wx-empty">
              {{ profileView.kind === 'user' ? '你还没有动态，点上方「发动态」写一条吧' : '还没有动态' }}
            </div>
          </div>
        </div>
      </template>

      <template v-else-if="tab === 'moments'">
        <div class="wx-moments">
          <div class="wx-moments-hero">
            <div class="wx-moments-cover">
              <div
                v-if="meProfile?.space_bg_path"
                class="wx-cover-photo"
                :style="{ backgroundImage: 'url(' + meProfile.space_bg_path + ')', opacity: uiSpaceBgOpacity }"
              ></div>
              <div class="wx-cover-actions">
                <button type="button" class="wx-mini-btn" :disabled="mediaBusy" @click.stop="spaceBgFileInput?.click()">更换封面</button>
                <button
                  v-if="meProfile?.space_bg_path"
                  type="button"
                  class="wx-mini-btn"
                  :disabled="mediaBusy"
                  @click.stop="clearSpaceBg"
                >恢复默认</button>
              </div>
            </div>
            <div class="wx-moments-profile">
              <div class="wx-avatar" role="button" title="我的主页" @click.stop="openMyProfile">
                <img v-if="meProfile?.avatar_path" :src="meProfile.avatar_path" alt="" />
                <template v-else>{{ avatarText(meProfile?.name || '旅人') }}</template>
              </div>
              <div>
                <div class="nm" role="button" @click.stop="openMyProfile">{{ meProfile?.name || '旅人' }}</div>
                <div class="sg">记录与角色的日常</div>
              </div>
              <span class="wx-hint" style="margin-left:auto;margin-bottom:8px">{{ status }}</span>
            </div>
          </div>
          <div class="wx-moments-feed">
            <div v-for="m in filteredMoments" :key="m.id" class="wx-moment-card">
              <div class="wx-moment-head">
                <div class="wx-avatar" role="button" title="查看主页" @click.stop="openMomentAuthor(m)">
                  <img v-if="m.avatar_path" :src="m.avatar_path" alt="" />
                  <template v-else>{{ avatarText(m.character_name) }}</template>
                </div>
                <div class="wx-moment-who">
                  <span class="pn">{{ m.character_name }}</span>
                  <span class="wx-moment-time">{{ formatTime(m.created_at) }}</span>
                </div>
                <div class="wx-moment-more" @click.stop>
                  <button class="wx-moment-more-btn" title="更多" @click="toggleMomentMenu(m.id)">⋯</button>
                  <div v-if="momentMenuId === m.id" class="wx-menu moment">
                    <button class="danger" @click="askDeleteMoment(m)">删除</button>
                  </div>
                </div>
              </div>
              <div class="wx-moment-content">{{ m.content }}</div>
              <button
                v-if="m.image_path"
                type="button"
                class="wx-moment-image"
                @click="openLightbox(m.image_path)"
              >
                <img :src="m.image_path" alt="动态配图" />
              </button>
              <div class="wx-moment-actions">
                <button class="wx-mini-btn" :class="{ liked: m.liked }" @click="toggleLike(m)">
                  {{ m.liked ? '♥ 已赞' : '♡ 点赞' }}{{ m.like_count ? ` · ${m.like_count}` : '' }}
                </button>
              </div>
              <button
                v-if="m.likers?.length"
                type="button"
                class="wx-moment-likers"
                @click="toggleLikeList(m.id)"
              >
                <span
                  v-for="lk in m.likers.slice(0, 5)"
                  :key="lk.user_key"
                  class="wx-moment-liker-ava"
                  :title="lk.name"
                >
                  <img v-if="lk.avatar_path" :src="lk.avatar_path" alt="" />
                  <template v-else>{{ avatarText(lk.name) }}</template>
                </span>
                <span v-if="m.likers.length > 5" class="wx-moment-liker-more">+{{ m.likers.length - 5 }}</span>
              </button>
              <div v-if="expandedLikeMomentId === m.id && m.likers?.length" class="wx-moment-liker-names">
                {{ m.likers.map((lk) => lk.name).join('、') }}
              </div>
              <div v-if="m.comments?.length" class="wx-moment-comments">
                <div v-for="c in m.comments" :key="c.id" class="wx-moment-comment">
                  <b>{{ c.author }}：</b>{{ c.content }}
                </div>
              </div>
              <div class="wx-moment-comment-box">
                <input
                  v-model="commentDrafts[m.id]"
                  class="wx-search"
                  placeholder="写评论…"
                  @keydown.enter.prevent="submitComment(m)"
                />
                <button class="wx-mini-btn primary" @click="submitComment(m)">评论</button>
              </div>
            </div>
            <div v-if="!filteredMoments.length" class="wx-empty">
              {{ momentsFilterId ? '该角色还没有动态' : '还没有动态' }}。<br />
              可以点上方「发动态」，或去通讯录「⋯ → 让 TA 发动态」。
              <div v-if="momentsFilterId" style="margin-top:12px">
                <button type="button" class="wx-mini-btn" @click="setMomentsFilter(null)">查看全部</button>
              </div>
            </div>
          </div>
        </div>
      </template>

      <template v-else>
        <div class="wx-main-header">
          <div class="wx-header-left">
            <div
              v-if="collageMembers(activeConversation).length"
              class="wx-header-ava collage"
              :class="{ 'is-alive': activeConversation?.type === 'group' && sending }"
              :data-n="collageMembers(activeConversation).length"
            >
              <span v-for="mem in collageMembers(activeConversation)" :key="mem.id">
                <img v-if="mem.avatar_path" :src="mem.avatar_path" alt="" />
                <template v-else>{{ avatarText(mem.name) }}</template>
              </span>
            </div>
            <div v-else class="wx-header-ava">
              <img v-if="headerAvatar(activeConversation)" :src="headerAvatar(activeConversation)!" alt="" />
              <template v-else>{{ avatarText(activeConversation?.title) }}</template>
            </div>
            <div class="wx-header-meta">
              <div class="cname-row">
                <div class="cname">{{ activeConversation?.title || '未选择会话' }}</div>
              </div>
              <div class="cstatus">{{ headerStatus(activeConversation) }}</div>
            </div>
            <div v-if="activeConversation" class="wx-menu-wrap" @click.stop>
              <button class="wx-icon-more" title="会话设置" @click="menuOpen = !menuOpen">⋯</button>
              <div v-if="menuOpen" class="wx-menu">
                <button v-if="activeConversation.type === 'group'" @click="renameGroup">修改群名称</button>
                <button @click="clearChat">清空聊天记录</button>
                <button class="danger" @click="dissolveGroup">
                  {{ activeConversation.type === 'group' ? '解散群聊' : '删除会话' }}
                </button>
              </div>
            </div>
          </div>
          <span class="wx-hint">{{ status }}</span>
        </div>

        <div class="wx-main-row">
          <div class="wx-chat-pane">
            <div
              v-if="memoryWhisperVisible"
              class="wx-memory-toast"
              :class="{ show: memoryWhisperOpaque }"
            >
              <div class="wx-memory-toast-label">记下了</div>
              <div class="wx-memory-toast-body">{{ memoryWhisperText }}</div>
            </div>
            <div ref="chatBody" class="wx-chat-body">
              <template v-if="activeConversation">
                <TransitionGroup
                  :key="activeConversationId || undefined"
                  name="wx-motion-msg"
                  tag="div"
                  class="wx-msg-stream"
                >
                  <div
                    v-for="(m, i) in messages"
                    :key="m.id"
                    class="wx-msg-block"
                  >
                  <div v-if="showDayDivider(i)" class="wx-day-div">{{ dayLabel(m.created_at) }}</div>
                  <div
                    class="wx-msg"
                    :class="{ me: m.role === 'user', continued: isContinued(i) }"
                  >
                    <div
                      class="wx-avatar sm"
                      role="button"
                      title="查看主页"
                      @click.stop="onMsgAvatarClick(m)"
                    >
                      <img v-if="messageAvatarUrl(m)" :src="messageAvatarUrl(m)!" alt="" />
                      <template v-else>{{ messageAvatarLetter(m) }}</template>
                    </div>
                    <div class="wx-msg-col">
                      <div v-if="!isContinued(i)" class="wx-msg-head">
                        <span class="wx-msg-name">{{ speakerName(m) }}</span>
                        <span class="wx-msg-time">{{ formatTime(m.created_at) }}</span>
                      </div>
                      <div class="wx-bubble-row">
                        <button
                          v-if="m.image_path"
                          type="button"
                          class="wx-image-bubble"
                          title="查看大图"
                          @click="openLightbox(m.image_path)"
                        >
                          <img :src="m.image_path" alt="图片" />
                        </button>
                        <button
                          v-else-if="isVoiceBubble(m)"
                          type="button"
                          class="wx-voice-bubble"
                          :class="{ playing: ttsPlayingId === m.id, loading: ttsLoadingId === m.id }"
                          :style="ttsPlayingId === m.id ? { '--tts-progress': `${Math.round(ttsProgressRatio * 1000) / 10}%` } : undefined"
                          :aria-label="ttsLoadingId === m.id ? '语音加载中' : ttsPlayingId === m.id ? '暂停语音' : '播放语音'"
                          @click="playTts(m.id)"
                        >
                          <span class="wx-voice-play" aria-hidden="true"></span>
                          <span class="wx-voice-main" aria-hidden="true">
                            <span class="wx-voice-wave">
                              <i></i><i></i><i></i><i></i><i></i>
                            </span>
                            <span class="wx-voice-progress"><span class="wx-voice-progress-bar"></span></span>
                          </span>
                          <span class="wx-voice-label">语音</span>
                          <span class="wx-voice-transcript">{{ m.content }}</span>
                        </button>
                        <div v-else class="wx-bubble" v-html="mentionHtml(m.content)"></div>
                        <div class="wx-msg-actions" @click.stop>
                          <button
                            v-if="!isVoiceBubble(m) && !m.image_path"
                            class="wx-msg-tts"
                            type="button"
                            title="朗读"
                            :disabled="ttsLoadingId === m.id"
                            @click="playTts(m.id)"
                          >
                            {{ ttsLoadingId === m.id ? '…' : ttsPlayingId === m.id ? '■' : '♪' }}
                          </button>
                          <button class="wx-msg-more" title="消息操作" @click="toggleMsgMenu(m.id)">⋯</button>
                          <div v-if="msgMenuId === m.id" class="wx-menu msg">
                            <div class="wx-react-quick" role="group" aria-label="表情反应">
                              <button
                                v-for="em in REACTION_QUICK"
                                :key="em"
                                type="button"
                                class="wx-react-quick-btn"
                                :title="em"
                                @click="toggleReaction(m.id, em); msgMenuId = null"
                              >{{ em }}</button>
                            </div>
                            <button class="danger" @click="deleteOneMessage(m)">删除</button>
                          </div>
                        </div>
                      </div>
                      <TransitionGroup
                        v-if="m.reactions && m.reactions.length"
                        name="wx-motion-react"
                        tag="div"
                        class="wx-react-row"
                      >
                        <button
                          v-for="r in m.reactions"
                          :key="r.emoji"
                          type="button"
                          class="wx-react-chip"
                          :class="{ mine: r.me }"
                          :title="r.emoji"
                          @click.stop="toggleReaction(m.id, r.emoji)"
                        >
                          <span class="wx-react-emoji">{{ r.emoji }}</span>
                          <span v-if="r.count > 1" class="wx-react-count">{{ r.count }}</span>
                        </button>
                      </TransitionGroup>
                    </div>
                  </div>
                  </div>
                </TransitionGroup>
                <Transition name="wx-motion-fade">
                  <div
                    v-if="sending"
                    key="typing"
                    class="wx-typing"
                    :class="{ 'is-group': activeConversation?.type === 'group' }"
                    aria-live="polite"
                    aria-label="正在输入"
                  >
                    <div
                      v-if="activeConversation?.type === 'group'"
                      class="wx-typing-avatars"
                      aria-hidden="true"
                    >
                      <span
                        v-for="(mem, idx) in (activeConversation.members || []).slice(0, 3)"
                        :key="mem.id"
                        class="wx-typing-ava"
                        :style="{ animationDelay: idx * 0.18 + 's' }"
                      >
                        <img v-if="mem.avatar_path" :src="mem.avatar_path" alt="" />
                        <template v-else>{{ avatarText(mem.name) }}</template>
                      </span>
                    </div>
                    <span class="wx-typing-dots" aria-hidden="true"><i></i><i></i><i></i></span>
                    <span class="wx-typing-label">正在输入</span>
                  </div>
                </Transition>
              </template>
              <div v-else class="wx-empty">
                选择会话开始聊天<br />
                从左侧「通讯录」导入角色并开始私聊
              </div>
            </div>

            <div v-if="activeConversation" class="wx-composer">
              <div v-if="activeConversation.type === 'group'" class="wx-mention-picker">
                <span class="wx-hint">@ 指定回复</span>
                <select v-model="mentionId">
                  <option value="">（未选则轮询下一位）</option>
                  <option v-for="mem in activeConversation.members || []" :key="mem.id" :value="mem.id">
                    @{{ mem.name }}
                  </option>
                </select>
              </div>
              <div
                class="wx-input-bar"
                :class="{ 'is-recording': voiceActive, 'is-cancel': voiceCancelHint }"
              >
                <button
                  type="button"
                  class="wx-composer-btn wx-plus-btn"
                  title="发送图片"
                  aria-label="发送图片"
                  :disabled="sending || imageBusy || voiceActive || !activeConversation"
                  @click="openChatImagePicker"
                >
                  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="M5 12h14"/></svg>
                </button>
                <template v-if="!voiceActive">
                  <textarea
                    ref="draftInput"
                    v-model="draft"
                    rows="1"
                    placeholder="发消息…"
                    @keydown="onKeydown"
                  />
                </template>
                <div v-else class="wx-record-strip" aria-live="polite">
                  <span class="wx-record-pulse" aria-hidden="true"></span>
                  <span class="wx-record-text">{{ voiceCancelHint ? '松开取消' : '松开发送 · 上滑取消' }}</span>
                </div>
                                <button
                  v-if="!voiceActive"
                  type="button"
                  class="wx-composer-btn wx-emoji-btn"
                  :class="{ active: emojiOpen }"
                  title="表情"
                  aria-label="表情"
                  :aria-expanded="emojiOpen"
                  @click.stop="toggleEmojiPicker"
                >
                  <span class="wx-emoji-btn-face" aria-hidden="true">😀</span>
                </button>
                <button
                  type="button"
                  class="wx-composer-btn wx-mic-icon"
                  :class="{ active: voiceActive, busy: voiceBusy }"
                  :disabled="sending || voiceBusy"
                  title="按住说话"
                  aria-label="按住说话"
                  @pointerdown="onVoicePointerDown"
                  @pointermove="onVoicePointerMove"
                  @pointerup="onVoicePointerUp"
                  @pointercancel="onVoicePointerCancel"
                  @contextmenu.prevent
                >
                  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
                </button>
                <button
                  v-if="!voiceActive"
                  type="button"
                  class="wx-send"
                  :disabled="sending || !draft.trim()"
                  title="发送"
                  aria-label="发送"
                  @click="send"
                >
                  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></svg>
                </button>
              </div>

              <div
                v-if="emojiOpen"
                ref="emojiPopover"
                class="wx-emoji-popover"
                role="dialog"
                aria-label="表情选择"
              >
                <div class="wx-emoji-grid">
                  <button
                    v-for="em in EMOJI_WHITELIST"
                    :key="em"
                    type="button"
                    class="wx-emoji-cell"
                    :title="em"
                    @click="insertEmoji(em)"
                  >{{ em }}</button>
                </div>
              </div>

            </div>
          </div>
          <aside
            v-if="activeConversation?.type === 'group'"
            class="wx-members"
            :class="{ 'is-alive': sending }"
          >
            <div class="wx-members-title">群成员</div>
            <div
              v-for="(mem, mIdx) in activeConversation.members || []"
              :key="mem.id"
              class="wx-list-item"
              role="button"
              title="查看主页"
              @click.stop="openCharacterProfile(mem.id)"
            >
              <div
                class="wx-avatar sm wx-avatar-float"
                :style="{ animationDelay: (mIdx % 5) * 0.35 + 's' }"
              >
                <img v-if="mem.avatar_path" :src="mem.avatar_path" alt="" />
                <template v-else>{{ avatarText(mem.name) }}</template>
              </div>
              <div class="wx-list-title">{{ mem.name }}</div>
            </div>
          </aside>
        </div>
      </template>
    </main>
    <div
      v-if="pendingDeleteMoment"
      class="wx-confirm-mask"
      @click.self="cancelDeleteMoment"
    >
      <div class="wx-confirm-card" @click.stop>
        <div class="wx-confirm-title">删除动态</div>
        <div class="wx-confirm-body">
          确定删除「{{ pendingDeleteMoment.character_name || (pendingDeleteMoment.author_kind === 'user' ? '我' : '角色') }}」的这条动态？点赞与评论也会一起删除。
        </div>
        <div class="wx-confirm-actions">
          <button class="wx-mini-btn" @click="cancelDeleteMoment">取消</button>
          <button class="wx-confirm-ok" @click="confirmDeleteMoment">确定删除</button>
        </div>
      </div>
    </div>

    <div
      v-if="pendingDeleteMessage"
      class="wx-confirm-mask"
      @click.self="cancelDeleteMessage"
    >
      <div class="wx-confirm-card" @click.stop>
        <div class="wx-confirm-title">删除消息</div>
        <div class="wx-confirm-body">确定删除这条消息？删除后不可恢复。</div>
        <div class="wx-confirm-actions">
          <button class="wx-mini-btn" @click="cancelDeleteMessage">取消</button>
          <button class="wx-confirm-ok" @click="confirmDeleteMessage">确定删除</button>
        </div>
      </div>
    </div>

    <div
      v-if="pendingOverwriteImport"
      class="wx-confirm-mask"
      @click.self="cancelOverwriteImport"
    >
      <div class="wx-confirm-card" @click.stop>
        <div class="wx-confirm-title">覆盖人设</div>
        <div class="wx-confirm-body">
          将覆盖「{{ pendingOverwriteImport.name }}」的人设，聊天记录保留。
        </div>
        <div class="wx-confirm-actions">
          <button class="wx-mini-btn" @click="cancelOverwriteImport">取消</button>
          <button class="wx-confirm-ok" @click="confirmOverwriteImport">确认覆盖</button>
        </div>
      </div>
    </div>

    <div
      v-if="pendingDeleteCharacter"
      class="wx-confirm-mask"
      @click.self="cancelDeleteCharacter"
    >
      <div class="wx-confirm-card" @click.stop>
        <div class="wx-confirm-title">删除角色</div>
        <div class="wx-confirm-body">
          确定删除「{{ pendingDeleteCharacter.name }}」？其私聊、动态和群成员关系也会一并删除，此操作不可恢复。
        </div>
        <div class="wx-confirm-actions">
          <button class="wx-mini-btn" @click="cancelDeleteCharacter">取消</button>
          <button class="wx-confirm-ok" @click="confirmDeleteCharacter">确定删除</button>
        </div>
      </div>
    </div>


  
    
    <Transition name="wx-motion-fade">
    <div
      v-if="momentComposerOpen"
      class="wx-confirm-mask"
      @click.self="closeMomentComposer"
    >
      <div class="wx-confirm-card wx-moment-composer" @click.stop>
        <div class="wx-confirm-title">发动态</div>
        <textarea
          v-model="momentDraft"
          class="wx-moment-composer-input"
          rows="4"
          maxlength="500"
          placeholder="写点什么…"
        ></textarea>
        <div v-if="momentImagePreview" class="wx-moment-composer-preview">
          <img :src="momentImagePreview" alt="预览" />
          <button type="button" class="wx-mini-btn" @click="clearMomentImage">去掉图片</button>
        </div>
        <div class="wx-confirm-actions" style="justify-content:space-between;width:100%">
          <button type="button" class="wx-mini-btn" :disabled="momentPostBusy" @click="momentImageInput?.click()">配图</button>
          <div style="display:flex;gap:8px">
            <button class="wx-mini-btn" :disabled="momentPostBusy" @click="closeMomentComposer">取消</button>
            <button
              class="wx-confirm-ok"
              :disabled="momentPostBusy || !momentDraft.trim()"
              @click="submitMyMoment"
            >发布</button>
          </div>
        </div>
      </div>
    </div>
    </Transition>
    <input
      ref="momentImageInput"
      type="file"
      accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"
      style="display: none"
      @change="onMomentImagePick"
    />


    <Transition name="wx-motion-fade">
    <div
      v-if="personaEditorOpen"
      class="wx-confirm-mask"
      @click.self="closePersonaEditor"
    >
      <div class="wx-confirm-card wx-persona-editor" @click.stop>
        <div class="wx-confirm-title">编辑人设</div>
        <p class="wx-hint" style="margin:0 0 10px">改完保存即可，聊天记录会保留；不必重新导入角色卡。</p>
        <div class="wx-persona-fields" :class="{ busy: personaEditorBusy }">
          <label class="wx-persona-field">
            <span>名称</span>
            <input v-model="personaDraft.name" class="wx-search" maxlength="80" :disabled="personaEditorBusy" />
          </label>
          <label class="wx-persona-field">
            <span>简介</span>
            <textarea v-model="personaDraft.description" rows="2" :disabled="personaEditorBusy"></textarea>
          </label>
          <label class="wx-persona-field">
            <span>性格</span>
            <textarea v-model="personaDraft.personality" rows="2" :disabled="personaEditorBusy"></textarea>
          </label>
          <label class="wx-persona-field">
            <span>场景</span>
            <textarea v-model="personaDraft.scenario" rows="2" :disabled="personaEditorBusy"></textarea>
          </label>
          <label class="wx-persona-field">
            <span>开场白</span>
            <textarea v-model="personaDraft.first_mes" rows="2" :disabled="personaEditorBusy"></textarea>
          </label>
          <label class="wx-persona-field">
            <span>对话示例</span>
            <textarea v-model="personaDraft.mes_example" rows="3" :disabled="personaEditorBusy"></textarea>
          </label>
          <label class="wx-persona-field">
            <span>系统提示</span>
            <textarea v-model="personaDraft.system_prompt" rows="3" :disabled="personaEditorBusy"></textarea>
          </label>
          <label class="wx-persona-field">
            <span>额外指示</span>
            <textarea v-model="personaDraft.post_history_instructions" rows="2" :disabled="personaEditorBusy"></textarea>
          </label>
        </div>
        <div class="wx-confirm-actions">
          <button class="wx-mini-btn" :disabled="personaEditorBusy" @click="closePersonaEditor">取消</button>
          <button class="wx-confirm-ok" :disabled="personaEditorBusy || !personaDraft.name.trim()" @click="savePersonaEditor">保存</button>
        </div>
      </div>
    </div>
    </Transition>

<div
      v-if="lightboxUrl"
      class="wx-lightbox"
      role="dialog"
      aria-label="查看图片"
      @click.self="closeLightbox"
    >
      <button type="button" class="wx-lightbox-close" title="关闭" @click="closeLightbox">×</button>
      <img :src="lightboxUrl" alt="大图" @click.stop />
    </div>

  </div>
</template>
