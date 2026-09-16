<script setup lang="ts">
/**
 * Agent-chat web shell (Vue 3 + Vite).
 *
 * Layout: left nav → mid list (chat / contacts / space tools) → main pane
 * (profile | moments feed | conversation). Talks to apps/server via ./api/client.
 * Voice hold-to-talk lives in ./composables/useHoldToTalk; styles in ./styles/wechat.css.
 */

import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { api, type Character, type ChatMessage, type Conversation, type Moment, type Profile } from './api/client';
import { useHoldToTalk } from './composables/useHoldToTalk';
import { EMOJI_WHITELIST } from './constants/emojiWhitelist';
import {
  THEME_PRESETS,
  DEFAULT_THEME,
  DEFAULT_BG_OPACITY,
  DEFAULT_SPACE_BG_OPACITY,
  normalizeThemeId,
  clampBgOpacity,
  type ThemeId,
} from './constants/themes';

type Tab = 'chat' | 'contacts' | 'moments';

const tab = ref<Tab>('chat');
const characters = ref<Character[]>([]);
const conversations = ref<Conversation[]>([]);
const messages = ref<ChatMessage[]>([]);
const moments = ref<Moment[]>([]);
const momentsFilterId = ref<string | null>(null);
const activeConversationId = ref<string | null>(null);
const draft = ref('');
const draftInput = ref<HTMLTextAreaElement | null>(null);
const emojiOpen = ref(false);
const emojiPopover = ref<HTMLElement | null>(null);
const sending = ref(false);
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
const ttsPlayingId = ref<string | null>(null);
const ttsLoadingId = ref<string | null>(null);
let ttsAudio: HTMLAudioElement | null = null;
const status = ref('');
const selectedForGroup = ref<string[]>([]);
const creatingGroup = ref(false);
const groupTitleDraft = ref('');
const groupSearch = ref('');
const contactMenuId = ref<string | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);
const chatBody = ref<HTMLElement | null>(null);
const mentionId = ref<string>('');
const commentDrafts = reactive<Record<string, string>>({});
const menuOpen = ref(false);
const msgMenuId = ref<string | null>(null);
const momentMenuId = ref<string | null>(null);
const pendingDeleteMoment = ref<Moment | null>(null);
const momentComposerOpen = ref(false);
const momentDraft = ref('');
const momentImageFile = ref<File | null>(null);
const momentImagePreview = ref<string | null>(null);
const momentPostBusy = ref(false);
const momentImageInput = ref<HTMLInputElement | null>(null);
const pendingDeleteMessage = ref<ChatMessage | null>(null);
const pendingOverwriteImport = ref<{ file: File; name: string } | null>(null);
const pendingDeleteCharacter = ref<{ id: string; name: string } | null>(null);
const listCtxId = ref<string | null>(null);
const listCtxPos = ref({ x: 0, y: 0 });
const swipeId = ref<string | null>(null);
const swipeX = ref(0);
let swipeStartX = 0;
let swipeActiveId: string | null = null;
let swipeMoved = false;

type ProfileView = null | { kind: 'user' } | { kind: 'character'; id: string };
const profileView = ref<ProfileView>(null);
const profile = ref<Profile | null>(null);
const meProfile = ref<Profile | null>(null);
const mediaBusy = ref(false);
const uiTheme = ref<ThemeId>(DEFAULT_THEME);
const uiBgOpacity = ref(DEFAULT_BG_OPACITY);
const uiSpaceBgOpacity = ref(DEFAULT_SPACE_BG_OPACITY);
const appearanceBusy = ref(false);
const avatarFileInput = ref<HTMLInputElement | null>(null);
const bgFileInput = ref<HTMLInputElement | null>(null);
const spaceBgFileInput = ref<HTMLInputElement | null>(null);
const chatImageInput = ref<HTMLInputElement | null>(null);
const imageBusy = ref(false);
const lightboxUrl = ref<string | null>(null);
const profileMoments = ref<Moment[]>([]);
const profileLoading = ref(false);
const profileEditing = ref(false);
const editMood = ref('');
const editBio = ref('');

const activeConversation = computed(() =>
  conversations.value.find((c) => c.id === activeConversationId.value) ?? null
);

const midTitle = computed(() => {
  if (tab.value === 'chat') return '消息';
  if (tab.value === 'contacts') return creatingGroup.value ? '创建群聊' : '通讯录';
  return '空间';
});

function isSameLocalDay(iso: string, now = new Date()) {
  const d = new Date(iso);
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

const momentsToday = computed(() => moments.value.filter((m) => isSameLocalDay(m.created_at)));

const momentsTodayAuthors = computed(() => {
  const seen = new Set<string>();
  const list: Array<{ id: string; name: string; avatar_path?: string | null }> = [];
  for (const m of momentsToday.value) {
    if (!m.character_id || seen.has(m.character_id)) continue;
    seen.add(m.character_id);
    list.push({
      id: m.character_id,
      name: m.character_name || '角色',
      avatar_path: m.avatar_path,
    });
  }
  return list;
});

const spaceCharacterStats = computed(() => {
  const countBy = new Map<string, number>();
  for (const m of moments.value) {
    if (!m.character_id) continue;
    countBy.set(m.character_id, (countBy.get(m.character_id) || 0) + 1);
  }
  return characters.value
    .map((ch) => ({
      id: ch.id,
      name: ch.name,
      avatar_path: ch.avatar_path,
      count: countBy.get(ch.id) || 0,
    }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh'));
});

const filteredMoments = computed(() => {
  const id = momentsFilterId.value;
  if (!id) return moments.value;
  return moments.value.filter((m) => m.character_id === id);
});

function setMomentsFilter(id: string | null) {
  momentsFilterId.value = id;
}


const groupPickableCharacters = computed(() => {
  const q = groupSearch.value.trim().toLowerCase();
  if (!q) return characters.value;
  return characters.value.filter((ch) => {
    const name = (ch.name || '').toLowerCase();
    const desc = (ch.description || '').toLowerCase();
    return name.includes(q) || desc.includes(q);
  });
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


async function closeProfile() {
  profileView.value = null;
  profile.value = null;
  profileMoments.value = [];
  profileEditing.value = false;
}



function applyAppearanceToDom() {
  document.documentElement.setAttribute('data-theme', uiTheme.value);
  document.documentElement.style.setProperty('--user-bg-opacity', String(uiBgOpacity.value));
  document.documentElement.style.setProperty('--user-space-bg-opacity', String(uiSpaceBgOpacity.value));
}

function syncAppearanceFromProfile(p: Profile | null | undefined) {
  if (!p || p.kind !== 'user') return;
  uiTheme.value = normalizeThemeId(p.theme);
  uiBgOpacity.value = clampBgOpacity(p.bg_opacity, DEFAULT_BG_OPACITY);
  uiSpaceBgOpacity.value = clampBgOpacity(p.space_bg_opacity, DEFAULT_SPACE_BG_OPACITY);
  applyAppearanceToDom();
}

async function persistAppearance(partial: {
  theme?: ThemeId;
  bg_opacity?: number;
  space_bg_opacity?: number;
}) {
  appearanceBusy.value = true;
  try {
    const res = await api.updateMyProfile(partial);
    meProfile.value = res.profile;
    if (profileView.value?.kind === 'user') profile.value = res.profile;
    syncAppearanceFromProfile(res.profile);
  } catch (err) {
    status.value = err instanceof Error ? err.message : String(err);
  } finally {
    appearanceBusy.value = false;
  }
}

async function selectTheme(id: ThemeId) {
  uiTheme.value = id;
  applyAppearanceToDom();
  await persistAppearance({ theme: id });
}

async function onBgOpacityInput(ev: Event) {
  const v = clampBgOpacity((ev.target as HTMLInputElement).valueAsNumber, DEFAULT_BG_OPACITY);
  uiBgOpacity.value = v;
  applyAppearanceToDom();
}

async function onBgOpacityCommit() {
  await persistAppearance({ bg_opacity: uiBgOpacity.value });
}

async function onSpaceBgOpacityInput(ev: Event) {
  const v = clampBgOpacity((ev.target as HTMLInputElement).valueAsNumber, DEFAULT_SPACE_BG_OPACITY);
  uiSpaceBgOpacity.value = v;
  applyAppearanceToDom();
}

async function onSpaceBgOpacityCommit() {
  await persistAppearance({ space_bg_opacity: uiSpaceBgOpacity.value });
}

async function refreshMeProfile() {
  try {
    const res = await api.getMyProfile();
    meProfile.value = res.profile;
    syncAppearanceFromProfile(res.profile);
  } catch {
    /* keep previous */
  }
}

async function applyProfileMedia(next: Profile) {
  profile.value = next;
  if (next.kind === 'user') {
    meProfile.value = next;
    syncAppearanceFromProfile(next);
  } else {
    await refreshCharacters();
    await refreshConversations();
  }
}

async function onAvatarFileChange(ev: Event) {
  const input = ev.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file || !profileView.value) return;
  mediaBusy.value = true;
  status.value = '上传头像…';
  try {
    const res =
      profileView.value.kind === 'user'
        ? await api.uploadMyAvatar(file)
        : await api.uploadCharacterAvatar(profileView.value.id, file);
    await applyProfileMedia(res.profile);
    status.value = '头像已更新';
  } catch (err) {
    status.value = err instanceof Error ? err.message : String(err);
  } finally {
    mediaBusy.value = false;
  }
}

async function onBgFileChange(ev: Event) {
  const input = ev.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file || !profileView.value) return;
  mediaBusy.value = true;
  status.value = '上传背景…';
  try {
    const res =
      profileView.value.kind === 'user'
        ? await api.uploadMyBg(file)
        : await api.uploadCharacterBg(profileView.value.id, file);
    await applyProfileMedia(res.profile);
    status.value = '背景已更新';
  } catch (err) {
    status.value = err instanceof Error ? err.message : String(err);
  } finally {
    mediaBusy.value = false;
  }
}

async function onSpaceBgFileChange(ev: Event) {
  const input = ev.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  mediaBusy.value = true;
  status.value = '上传空间封面…';
  try {
    const res = await api.uploadSpaceBg(file);
    meProfile.value = res.profile;
    if (profileView.value?.kind === 'user' && profile.value) {
      profile.value = { ...profile.value, space_bg_path: res.profile.space_bg_path };
    }
    status.value = '空间封面已更新';
  } catch (err) {
    status.value = err instanceof Error ? err.message : String(err);
  } finally {
    mediaBusy.value = false;
  }
}

async function clearAvatar() {
  if (!profileView.value) return;
  mediaBusy.value = true;
  try {
    const res =
      profileView.value.kind === 'user'
        ? await api.clearMyAvatar()
        : await api.clearCharacterAvatar(profileView.value.id);
    await applyProfileMedia(res.profile);
    status.value = '已恢复默认头像';
  } catch (err) {
    status.value = err instanceof Error ? err.message : String(err);
  } finally {
    mediaBusy.value = false;
  }
}

async function clearBg() {
  if (!profileView.value) return;
  mediaBusy.value = true;
  try {
    const res =
      profileView.value.kind === 'user'
        ? await api.clearMyBg()
        : await api.clearCharacterBg(profileView.value.id);
    await applyProfileMedia(res.profile);
    status.value = '已恢复默认背景';
  } catch (err) {
    status.value = err instanceof Error ? err.message : String(err);
  } finally {
    mediaBusy.value = false;
  }
}

async function clearSpaceBg() {
  mediaBusy.value = true;
  try {
    const res = await api.clearSpaceBg();
    meProfile.value = res.profile;
    status.value = '已恢复默认空间封面';
  } catch (err) {
    status.value = err instanceof Error ? err.message : String(err);
  } finally {
    mediaBusy.value = false;
  }
}

function privatePeer(c: Conversation | null | undefined) {
  if (!c || c.type !== 'private') return null;
  return (c.members && c.members[0]) || null;
}

function headerAvatar(c: Conversation | null | undefined) {
  const peer = privatePeer(c);
  if (peer?.avatar_path) return peer.avatar_path;
  return null;
}

async function openMyProfile() {
  profileLoading.value = true;
  profileView.value = { kind: 'user' };
  profileEditing.value = false;
  try {
    const res = await api.getMyProfile();
    profile.value = res.profile;
    meProfile.value = res.profile;
    profileMoments.value = res.moments || [];
    editMood.value = res.profile.mood || '';
    editBio.value = res.profile.bio || '';
    syncAppearanceFromProfile(res.profile);
    status.value = '';
  } catch (err) {
    status.value = err instanceof Error ? err.message : String(err);
  } finally {
    profileLoading.value = false;
  }
}

async function openCharacterProfile(id: string) {
  if (!id) return;
  profileLoading.value = true;
  profileView.value = { kind: 'character', id };
  profileEditing.value = false;
  try {
    const res = await api.getCharacterProfile(id);
    profile.value = res.profile;
    profileMoments.value = res.moments || [];
    status.value = '';
  } catch (err) {
    status.value = err instanceof Error ? err.message : String(err);
  } finally {
    profileLoading.value = false;
  }
}

async function saveMyProfile() {
  try {
    const res = await api.updateMyProfile({
      mood: editMood.value,
      bio: editBio.value,
    });
    profile.value = res.profile;
    meProfile.value = res.profile;
    profileEditing.value = false;
    status.value = '已保存';
  } catch (err) {
    status.value = err instanceof Error ? err.message : String(err);
  }
}

async function messageFromProfile() {
  if (profileView.value?.kind !== 'character') return;
  const id = profileView.value.id;
  await closeProfile();
  await startPrivate(id);
}

function onMsgAvatarClick(m: ChatMessage) {
  if (m.role === 'user') {
    void openMyProfile();
    return;
  }
  if (m.character_id) void openCharacterProfile(m.character_id);
}

async function refreshCharacters() {
  const res = await api.listCharacters();
  characters.value = res.characters;
}

async function refreshConversations() {
  const res = await api.listConversations();
  conversations.value = res.conversations;
}

async function refreshMoments() {
  const res = await api.listMoments();
  moments.value = res.moments;
}

async function openConversation(id: string) {
  await closeProfile();
  activeConversationId.value = id;
  tab.value = 'chat';
  mentionId.value = '';
  menuOpen.value = false;
  msgMenuId.value = null;
  const res = await api.listMessages(id);
  messages.value = res.messages;
  await nextTick();
  if (chatBody.value) chatBody.value.scrollTop = chatBody.value.scrollHeight;
}

async function startPrivate(characterId: string) {
  await refreshConversations();
  const existing = conversations.value.find(
    (c) => c.type === 'private' && c.members?.length === 1 && c.members[0].id === characterId
  );
  if (existing) {
    await openConversation(existing.id);
    return;
  }
  const { conversation } = await api.createConversation([characterId], undefined, 'private');
  await refreshConversations();
  await openConversation(conversation.id);
}

function openGroupCreator() {
  creatingGroup.value = true;
  selectedForGroup.value = [];
  groupTitleDraft.value = '';
  groupSearch.value = '';
  contactMenuId.value = null;
  status.value = '';
}

function cancelGroupCreator() {
  creatingGroup.value = false;
  selectedForGroup.value = [];
  groupTitleDraft.value = '';
  groupSearch.value = '';
  status.value = '';
}

function toggleGroupPick(id: string) {
  const list = selectedForGroup.value;
  const i = list.indexOf(id);
  if (i >= 0) list.splice(i, 1);
  else list.push(id);
}

function toggleContactMenu(id: string) {
  contactMenuId.value = contactMenuId.value === id ? null : id;
}

async function createGroup() {
  if (selectedForGroup.value.length < 2) {
    status.value = '请至少选择 2 名角色';
    return;
  }
  const title = groupTitleDraft.value.trim() || undefined;
  try {
    const { conversation } = await api.createConversation(selectedForGroup.value, title, 'group');
    creatingGroup.value = false;
    selectedForGroup.value = [];
    groupTitleDraft.value = '';
    groupSearch.value = '';
    await refreshConversations();
    await openConversation(conversation.id);
    status.value = '';
  } catch (err) {
    status.value = err instanceof Error ? err.message : String(err);
  }
}

async function runCharacterImport(file: File, overwrite = false) {
  status.value = overwrite ? '正在覆盖人设…' : '正在导入…';
  const res = await api.importCharacter(file, { overwrite });
  if ('conflict' in res && res.conflict) {
    pendingOverwriteImport.value = {
      file,
      name: res.existing?.name || '该角色',
    };
    status.value = '';
    return;
  }
  pendingOverwriteImport.value = null;
  await refreshCharacters();
  status.value = res.overwritten
    ? `已覆盖「${res.character.name}」的人设（聊天记录保留）`
    : `已导入：${res.character.name}`;
}

async function onImport(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  try {
    await runCharacterImport(file, false);
  } catch (err) {
    status.value = err instanceof Error ? err.message : String(err);
  } finally {
    input.value = '';
  }
}

function askDeleteCharacter(id: string, name: string) {
  contactMenuId.value = null;
  pendingDeleteCharacter.value = { id, name };
}

function cancelDeleteCharacter() {
  pendingDeleteCharacter.value = null;
}

async function confirmDeleteCharacter() {
  const pending = pendingDeleteCharacter.value;
  if (!pending) return;
  try {
    await api.deleteCharacter(pending.id);
    pendingDeleteCharacter.value = null;
    if (profileView.value?.kind === 'character' && profileView.value.id === pending.id) {
      await closeProfile();
    }
    // clear open private chat with this character
    const open = conversations.value.find((c) => c.id === activeConversationId.value);
    if (
      open &&
      open.type === 'private' &&
      open.members?.length === 1 &&
      open.members[0].id === pending.id
    ) {
      activeConversationId.value = null;
      messages.value = [];
    }
    await Promise.all([refreshCharacters(), refreshConversations(), refreshMoments()]);
    status.value = `已删除角色「${pending.name}」`;
  } catch (err) {
    status.value = err instanceof Error ? err.message : String(err);
  }
}

function cancelOverwriteImport() {
  pendingOverwriteImport.value = null;
  status.value = '已取消覆盖导入';
}

async function confirmOverwriteImport() {
  const pending = pendingOverwriteImport.value;
  if (!pending) return;
  try {
    await runCharacterImport(pending.file, true);
  } catch (err) {
    status.value = err instanceof Error ? err.message : String(err);
    pendingOverwriteImport.value = null;
  }
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

async function send() {
  closeEmojiPicker();

  const text = draft.value.trim();
  if (!text || !activeConversationId.value || sending.value) return;
  sending.value = true;
  status.value = '发送中…';
  try {
    const mention = mentionId.value || undefined;
    const res = await api.sendMessage(activeConversationId.value, text, mention);
    draft.value = '';
    messages.value.push(res.userMessage, ...res.assistantMessages);
    await refreshConversations();
    await nextTick();
    if (chatBody.value) chatBody.value.scrollTop = chatBody.value.scrollHeight;
    status.value = '';
  } catch (err) {
    status.value = err instanceof Error ? err.message : String(err);
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
  status.value = '发送图片…';
  try {
    const res = await api.sendChatImage(activeConversationId.value, file);
    messages.value.push(res.userMessage);
    await refreshConversations();
    await nextTick();
    if (chatBody.value) chatBody.value.scrollTop = chatBody.value.scrollHeight;
    status.value = '';
  } catch (err) {
    status.value = err instanceof Error ? err.message : String(err);
  } finally {
    imageBusy.value = false;
    sending.value = false;
  }
}

function openChatImagePicker() {
  if (sending.value || imageBusy.value || voiceActive.value || !activeConversationId.value) {
    status.value = !activeConversationId.value ? '请先打开会话' : '请稍候…';
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

async function onVoicePointerDown(e: PointerEvent) {
  e.preventDefault();
  if (sending.value || voiceBusy.value || !activeConversationId.value) return;
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
    status.value = '已取消发送';
    return;
  }
  const blob = await voiceStop();
  if (voiceError.value) {
    status.value = voiceError.value;
    return;
  }
  if (!blob || !activeConversationId.value) {
    status.value = blob ? '' : '说话时间太短，请按住再说';
    return;
  }
  voiceBusy.value = true;
  sending.value = true;
  status.value = '识别中…';
  try {
    const mention = mentionId.value || undefined;
    const res = await api.sendVoiceMessage(activeConversationId.value, blob, mention);
    messages.value.push(res.userMessage, ...res.assistantMessages);
    await refreshConversations();
    await nextTick();
    if (chatBody.value) chatBody.value.scrollTop = chatBody.value.scrollHeight;
    status.value = '';
  } catch (err) {
    status.value = err instanceof Error ? err.message : String(err);
  } finally {
    voiceBusy.value = false;
    sending.value = false;
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

async function playTts(m: ChatMessage) {
  if (ttsPlayingId.value === m.id && ttsAudio) {
    ttsAudio.pause();
    ttsAudio = null;
    ttsPlayingId.value = null;
    ttsLoadingId.value = null;
    return;
  }
  if (ttsAudio) {
    ttsAudio.pause();
    ttsAudio = null;
  }
  ttsLoadingId.value = m.id;
  ttsPlayingId.value = null;
  try {
    const url = api.messageTtsUrl(m.id) + '?t=' + Date.now();
    const audio = new Audio(url);
    ttsAudio = audio;
    audio.onended = () => {
      if (ttsPlayingId.value === m.id) ttsPlayingId.value = null;
      ttsAudio = null;
    };
    audio.onerror = () => {
      status.value = '朗读失败，请检查 TTS 配置';
      ttsPlayingId.value = null;
      ttsLoadingId.value = null;
      ttsAudio = null;
    };
    await audio.play();
    ttsLoadingId.value = null;
    ttsPlayingId.value = m.id;
  } catch (err) {
    ttsLoadingId.value = null;
    status.value = err instanceof Error ? err.message : '朗读失败';
  }
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    void send();
  }
}

async function renameGroup() {
  menuOpen.value = false;
  const conv = activeConversation.value;
  if (!conv || conv.type !== 'group') return;
  const next = window.prompt('修改群名称', conv.title);
  if (next == null) return;
  const title = next.trim();
  if (!title) {
    status.value = '群名称不能为空';
    return;
  }
  try {
    await api.renameConversation(conv.id, title);
    await refreshConversations();
    status.value = '';
  } catch (err) {
    status.value = err instanceof Error ? err.message : String(err);
  }
}

async function deleteConversationById(id: string, title: string) {
  const ok = window.confirm(`确定删除会话「${title}」？\n会话与其中消息将删除，角色与朋友圈不受影响。`);
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
    status.value = '会话已删除';
    return true;
  } catch (err) {
    status.value = err instanceof Error ? err.message : String(err);
    return false;
  }
}

async function dissolveGroup() {
  menuOpen.value = false;
  const conv = activeConversation.value;
  if (!conv) return;
  const label = conv.type === 'group' ? '解散并删除群' : '删除会话';
  const ok = window.confirm(
    conv.type === 'group'
      ? `确定${label}「${conv.title}」？\n群消息与成员关系将删除，角色与其它会话不受影响。`
      : `确定删除会话「${conv.title}」？\n会话与其中消息将删除，角色与朋友圈不受影响。`
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
    status.value = conv.type === 'group' ? '群已解散' : '会话已删除';
  } catch (err) {
    status.value = err instanceof Error ? err.message : String(err);
  }
}

function onListContextMenu(e: MouseEvent, c: Conversation) {
  e.preventDefault();
  listCtxId.value = c.id;
  listCtxPos.value = { x: e.clientX, y: e.clientY };
  swipeId.value = null;
  swipeX.value = 0;
}

async function onListCtxDelete() {
  const c = conversations.value.find((x) => x.id === listCtxId.value);
  if (!c) { listCtxId.value = null; return; }
  await deleteFromList(c);
}

async function deleteFromList(c: Conversation) {
  listCtxId.value = null;
  swipeId.value = null;
  swipeX.value = 0;
  await deleteConversationById(c.id, c.title);
}

function onSwipeStart(e: PointerEvent, id: string) {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  swipeActiveId = id;
  swipeStartX = e.clientX;
  swipeMoved = false;
  (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
}

function onSwipeMove(e: PointerEvent) {
  if (!swipeActiveId) return;
  const dx = e.clientX - swipeStartX;
  if (Math.abs(dx) > 6) swipeMoved = true;
  if (dx < 0) {
    swipeId.value = swipeActiveId;
    swipeX.value = Math.max(dx, -72);
  } else if (swipeId.value === swipeActiveId) {
    swipeX.value = Math.min(0, dx);
  }
}

function onSwipeEnd() {
  if (!swipeActiveId) return;
  if (swipeId.value === swipeActiveId && swipeX.value < -36) {
    swipeX.value = -72;
  } else {
    swipeId.value = null;
    swipeX.value = 0;
  }
  swipeActiveId = null;
}

function swipeStyle(id: string) {
  if (swipeId.value !== id) return undefined;
  return { transform: `translateX(${swipeX.value}px)` };
}

function onListItemClick(c: Conversation) {
  if (swipeMoved) {
    swipeMoved = false;
    return;
  }
  if (swipeId.value && swipeId.value !== c.id) {
    swipeId.value = null;
    swipeX.value = 0;
  }
  listCtxId.value = null;
  void openConversation(c.id);
}

async function clearChat() {
  menuOpen.value = false;
  const conv = activeConversation.value;
  if (!conv) return;
  const ok = window.confirm('清空当前会话的全部聊天记录？此操作不可恢复。');
  if (!ok) return;
  try {
    await api.clearMessages(conv.id);
    messages.value = [];
    await refreshConversations();
    status.value = '已清空聊天记录';
  } catch (err) {
    status.value = err instanceof Error ? err.message : String(err);
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
    status.value = err instanceof Error ? err.message : String(err);
  }
}

function toggleMsgMenu(id: string) {
  msgMenuId.value = msgMenuId.value === id ? null : id;
}


function openMomentComposer() {
  momentComposerOpen.value = true;
  momentDraft.value = '';
  clearMomentImage();
}

function closeMomentComposer() {
  momentComposerOpen.value = false;
  momentDraft.value = '';
  clearMomentImage();
}

function clearMomentImage() {
  if (momentImagePreview.value) {
    URL.revokeObjectURL(momentImagePreview.value);
  }
  momentImagePreview.value = null;
  momentImageFile.value = null;
  if (momentImageInput.value) momentImageInput.value.value = '';
}

function onMomentImagePick(ev: Event) {
  const input = ev.target as HTMLInputElement;
  const file = input.files?.[0] || null;
  if (!file) return;
  const okType = /image\/(jpeg|jpg|png|webp)/i.test(file.type) || /\.(jpe?g|png|webp)$/i.test(file.name);
  if (!okType) {
    status.value = '仅支持 jpg / png / webp';
    input.value = '';
    return;
  }
  if (file.size > 5 * 1024 * 1024) {
    status.value = '图片不能超过 5MB';
    input.value = '';
    return;
  }
  clearMomentImage();
  momentImageFile.value = file;
  momentImagePreview.value = URL.createObjectURL(file);
}

async function submitMyMoment() {
  const text = momentDraft.value.trim();
  if (!text || momentPostBusy.value) return;
  momentPostBusy.value = true;
  try {
    const res = await api.createMyMoment(text, momentImageFile.value);
    moments.value = [res.moment, ...moments.value.filter((m) => m.id !== res.moment.id)];
    if (profileView.value?.kind === 'user') {
      profileMoments.value = [res.moment, ...profileMoments.value.filter((m) => m.id !== res.moment.id)];
    }
    closeMomentComposer();
    status.value = '动态已发布';
  } catch (err) {
    status.value = err instanceof Error ? err.message : String(err);
  } finally {
    momentPostBusy.value = false;
  }
}

function openMomentAuthor(m: Moment) {
  if (m.author_kind === 'user' || !m.character_id) {
    openMyProfile();
    return;
  }
  openCharacterProfile(m.character_id);
}

async function letThemPost(characterId: string) {
  status.value = '生成动态…';
  try {
    await api.generateMoment(characterId);
    tab.value = 'moments';
    await refreshMoments();
    status.value = '';
  } catch (err) {
    status.value = err instanceof Error ? err.message : String(err);
  }
}

function toggleMomentMenu(id: string) {
  momentMenuId.value = momentMenuId.value === id ? null : id;
}

function askDeleteMoment(m: Moment) {
  momentMenuId.value = null;
  pendingDeleteMoment.value = m;
}

function cancelDeleteMoment() {
  pendingDeleteMoment.value = null;
}

async function confirmDeleteMoment() {
  const m = pendingDeleteMoment.value;
  if (!m) return;
  try {
    await api.deleteMoment(m.id);
    moments.value = moments.value.filter((x) => x.id !== m.id);
    profileMoments.value = profileMoments.value.filter((x) => x.id !== m.id);
    delete commentDrafts[m.id];
    status.value = '动态已删除';
    pendingDeleteMoment.value = null;
  } catch (err) {
    status.value = err instanceof Error ? err.message : String(err);
  }
}
async function toggleLike(m: Moment) {
  try {
    const res = await api.likeMoment(m.id);
    const idx = moments.value.findIndex((x) => x.id === m.id);
    if (idx >= 0) moments.value[idx] = res.moment;
  } catch (err) {
    status.value = err instanceof Error ? err.message : String(err);
  }
}

async function submitComment(m: Moment) {
  const text = (commentDrafts[m.id] || '').trim();
  if (!text) return;
  try {
    const res = await api.commentMoment(m.id, text);
    commentDrafts[m.id] = '';
    const idx = moments.value.findIndex((x) => x.id === m.id);
    if (idx >= 0) moments.value[idx] = res.moment;
  } catch (err) {
    status.value = err instanceof Error ? err.message : String(err);
  }
}

watch(tab, (t) => {
  if (t !== 'contacts') {
    creatingGroup.value = false;
    contactMenuId.value = null;
  }
  if (t !== 'moments') {
    momentsFilterId.value = null;
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
});

onUnmounted(() => {
  document.removeEventListener('pointerdown', onEmojiDocPointerDown);
  document.removeEventListener('keydown', onEmojiKeydown);
});
</script>

<template>
  <div class="wx-shell" @click="menuOpen = false; msgMenuId = null; listCtxId = null; momentMenuId = null; contactMenuId = null">
    <aside class="wx-nav">
      <div class="wx-nav-avatar" title="我的主页" role="button" @click.stop="openMyProfile">
        <img v-if="meProfile?.avatar_path" :src="meProfile.avatar_path" alt="" />
        <template v-else>{{ avatarText(meProfile?.name || '旅人') }}</template>
      </div>
      <button class="wx-nav-btn" :class="{ active: tab === 'chat' }" title="消息" aria-label="消息" @click="tab = 'chat'">
        <svg class="wx-nav-icon" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
      </button>
      <button class="wx-nav-btn" :class="{ active: tab === 'contacts' }" title="通讯录" aria-label="通讯录" @click="tab = 'contacts'">
        <svg class="wx-nav-icon" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
      </button>
      <button class="wx-nav-btn" :class="{ active: tab === 'moments' }" title="空间" aria-label="空间" @click="tab = 'moments'">
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
            <span v-if="(c.unread_count || 0) > 0" class="wx-unread-badge">{{ c.unread_count > 99 ? '99+' : c.unread_count }}</span>
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
          <button type="button" class="wx-mini-btn" style="margin-top:10px" @click="tab = 'contacts'">
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
              <div class="cname">{{ activeConversation?.title || '未选择会话' }}</div>
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
            <div ref="chatBody" class="wx-chat-body">
              <template v-if="activeConversation">
                <template v-for="(m, i) in messages" :key="m.id">
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
                          @click="playTts(m)"
                        >
                          <span class="wx-voice-play">{{ ttsLoadingId === m.id ? '…' : ttsPlayingId === m.id ? '■' : '▶' }}</span>
                          <span class="wx-voice-wave" aria-hidden="true">
                            <i></i><i></i><i></i><i></i><i></i>
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
                            @click="playTts(m)"
                          >
                            {{ ttsLoadingId === m.id ? '…' : ttsPlayingId === m.id ? '■' : '♪' }}
                          </button>
                          <button class="wx-msg-more" title="消息操作" @click="toggleMsgMenu(m.id)">⋯</button>
                          <div v-if="msgMenuId === m.id" class="wx-menu msg">
                            <button class="danger" @click="deleteOneMessage(m)">删除</button>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </template>
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

          <aside v-if="activeConversation?.type === 'group'" class="wx-members">
            <div class="wx-members-title">群成员</div>
            <div
              v-for="mem in activeConversation.members || []"
              :key="mem.id"
              class="wx-list-item"
              role="button"
              title="查看主页"
              @click.stop="openCharacterProfile(mem.id)"
            >
              <div class="wx-avatar sm">
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
    <input
      ref="momentImageInput"
      type="file"
      accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"
      style="display: none"
      @change="onMomentImagePick"
    />

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
