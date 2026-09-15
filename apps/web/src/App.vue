<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue';
import { api, type Character, type ChatMessage, type Conversation, type Moment, type Profile } from './api/client';

type Tab = 'chat' | 'contacts' | 'moments';

const tab = ref<Tab>('chat');
const characters = ref<Character[]>([]);
const conversations = ref<Conversation[]>([]);
const messages = ref<ChatMessage[]>([]);
const moments = ref<Moment[]>([]);
const activeConversationId = ref<string | null>(null);
const draft = ref('');
const sending = ref(false);
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

function collageMembers(c: Conversation) {
  const mems = c.members || [];
  if (c.type === 'group' && mems.length) return mems.slice(0, 4);
  return [];
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

async function openMyProfile() {
  profileLoading.value = true;
  profileView.value = { kind: 'user' };
  profileEditing.value = false;
  try {
    const res = await api.getMyProfile();
    profile.value = res.profile;
    profileMoments.value = res.moments || [];
    editMood.value = res.profile.mood || '';
    editBio.value = res.profile.bio || '';
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

async function onImport(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  try {
    status.value = '正在导入…';
    await api.importCharacter(file);
    await refreshCharacters();
    status.value = `已导入：${file.name}`;
  } catch (err) {
    status.value = err instanceof Error ? err.message : String(err);
  } finally {
    input.value = '';
  }
}

async function send() {
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

async function deleteOneMessage(m: ChatMessage) {
  msgMenuId.value = null;
  if (!activeConversationId.value) return;
  const ok = window.confirm('删除这条消息？');
  if (!ok) return;
  try {
    await api.deleteMessage(activeConversationId.value, m.id);
    messages.value = messages.value.filter((x) => x.id !== m.id);
    await refreshConversations();
  } catch (err) {
    status.value = err instanceof Error ? err.message : String(err);
  }
}

function toggleMsgMenu(id: string) {
  msgMenuId.value = msgMenuId.value === id ? null : id;
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
  if (t === 'moments') void refreshMoments();
  if (t === 'contacts') void refreshCharacters();
  if (t === 'chat') void refreshConversations();
});

onMounted(async () => {
  try {
    const h = await api.health();
    status.value = h.ok ? '' : '后端异常';
  } catch {
    status.value = '无法连接后端（请先启动 apps/server）';
  }
  await Promise.all([refreshCharacters(), refreshConversations(), refreshMoments()]);
});
</script>

<template>
  <div class="wx-shell" @click="menuOpen = false; msgMenuId = null; listCtxId = null; momentMenuId = null; contactMenuId = null">
    <aside class="wx-nav">
      <div class="wx-nav-avatar" title="我的主页" role="button" @click.stop="openMyProfile">馆</div>
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
        v-if="!(tab === 'contacts' && creatingGroup)"
        class="wx-search"
        placeholder="搜索"
      />
      <input
        ref="fileInput"
        type="file"
        accept=".json,.png,application/json,image/png"
        style="display: none"
        @change="onImport"
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
            <div v-if="collageMembers(c).length" class="wx-avatar collage" :data-n="Math.min(collageMembers(c).length, 4)">
              <span v-for="mem in collageMembers(c)" :key="mem.id">{{ avatarText(mem.name) }}</span>
            </div>
            <div v-else class="wx-avatar">{{ avatarText(c.title) }}</div>
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
            </div>
          </div>
        </div>
        <div v-if="!characters.length" class="wx-empty" style="padding: 40px 16px">
          还没有角色<br />点击「导入角色」选择 samples/characters/*.json
        </div>
      </div>
      <div v-else class="wx-list">
        <div v-for="ch in characters" :key="ch.id" class="wx-list-item" @click="letThemPost(ch.id)">
          <div class="wx-avatar">{{ avatarText(ch.name) }}</div>
          <div class="wx-list-meta">
            <div class="wx-list-title">让 {{ ch.name }} 发一条</div>
            <div class="wx-list-sub">点击生成空间动态</div>
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
            <div class="wx-profile-hero">
              <div class="wx-avatar lg">
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
                <button v-else class="wx-mini-btn primary" @click="messageFromProfile">发消息</button>
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
            <div class="wx-profile-label">动态</div>
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
              </div>
              <div class="wx-moment-content">{{ m.content }}</div>
            </div>
            <div v-if="!profileMoments.length" class="wx-empty">
              {{ profileView.kind === 'user' ? '你还没有动态（动态目前由角色发布）' : '还没有动态' }}
            </div>
          </div>
        </div>
      </template>

      <template v-else-if="tab === 'moments'">
        <div class="wx-moments">
          <div class="wx-moments-cover"></div>
          <div class="wx-moments-profile">
            <div class="wx-avatar" role="button" title="我的主页" @click.stop="openMyProfile">我</div>
            <div>
              <div class="nm" role="button" @click.stop="openMyProfile">旅人</div>
              <div class="sg">记录与角色的日常</div>
            </div>
            <span class="wx-hint" style="margin-left:auto;margin-bottom:8px">{{ status }}</span>
          </div>
          <div class="wx-moments-feed">
            <div v-for="m in moments" :key="m.id" class="wx-moment-card">
              <div class="wx-moment-head">
                <div class="wx-avatar" role="button" title="查看主页" @click.stop="openCharacterProfile(m.character_id)">
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
            <div v-if="!moments.length" class="wx-empty">
              还没有动态。<br />左侧点角色，或通讯录「⋯ → 让 TA 发动态」。
            </div>
          </div>
        </div>
      </template>

      <template v-else>
        <div class="wx-main-header">
          <div class="wx-header-left">
            <div class="wx-header-ava">{{ avatarText(activeConversation?.title) }}</div>
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
                      {{ m.role === 'user' ? '我' : avatarText(m.character_name || activeConversation.title) }}
                    </div>
                    <div class="wx-msg-col">
                      <div v-if="!isContinued(i)" class="wx-msg-head">
                        <span class="wx-msg-name">{{ speakerName(m) }}</span>
                        <span class="wx-msg-time">{{ formatTime(m.created_at) }}</span>
                      </div>
                      <div class="wx-bubble-row">
                        <div class="wx-bubble" v-html="mentionHtml(m.content)"></div>
                        <div class="wx-msg-actions" @click.stop>
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
              <div class="wx-input-bar">
                <textarea
                  v-model="draft"
                  placeholder="发消息…"
                  @keydown="onKeydown"
                />
                <button class="wx-send" :disabled="sending || !draft.trim()" @click="send">发送</button>
              </div>
            </div>
          </div>

          <aside v-if="activeConversation?.type === 'group'" class="wx-members">
            <div class="wx-members-title">群成员</div>
            <div v-for="mem in activeConversation.members || []" :key="mem.id" class="wx-list-item">
              <div class="wx-avatar sm">{{ avatarText(mem.name) }}</div>
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
          确定删除「{{ pendingDeleteMoment.character_name || '角色' }}」的这条动态？点赞与评论也会一起删除。
        </div>
        <div class="wx-confirm-actions">
          <button class="wx-mini-btn" @click="cancelDeleteMoment">取消</button>
          <button class="wx-confirm-ok" @click="confirmDeleteMoment">确定删除</button>
        </div>
      </div>
    </div>


  </div>
</template>
