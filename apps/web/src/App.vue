<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue';
import { api, type Character, type ChatMessage, type Conversation, type Moment } from './api/client';

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
const fileInput = ref<HTMLInputElement | null>(null);
const chatBody = ref<HTMLElement | null>(null);
const mentionId = ref<string>('');
const commentDrafts = reactive<Record<string, string>>({});
const menuOpen = ref(false);
const msgMenuId = ref<string | null>(null);
const listCtxId = ref<string | null>(null);
const listCtxPos = ref({ x: 0, y: 0 });
const swipeId = ref<string | null>(null);
const swipeX = ref(0);
let swipeStartX = 0;
let swipeActiveId: string | null = null;
let swipeMoved = false;

const activeConversation = computed(() =>
  conversations.value.find((c) => c.id === activeConversationId.value) ?? null
);

const midTitle = computed(() => {
  if (tab.value === 'chat') return '酒馆';
  if (tab.value === 'contacts') return '通讯录';
  return '朋友圈';
});

function avatarText(name?: string) {
  return (name || '?').slice(0, 1);
}

function collageMembers(c: Conversation) {
  const mems = c.members || [];
  if (c.type === 'group' && mems.length) return mems.slice(0, 4);
  return [];
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

async function createGroup() {
  if (selectedForGroup.value.length < 2) {
    status.value = '建群请至少勾选 2 个角色';
    return;
  }
  const { conversation } = await api.createConversation(selectedForGroup.value, undefined, 'group');
  selectedForGroup.value = [];
  await refreshConversations();
  await openConversation(conversation.id);
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
  status.value = '生成朋友圈…';
  try {
    await api.generateMoment(characterId);
    tab.value = 'moments';
    await refreshMoments();
    status.value = '';
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
  <div class="wx-shell" @click="menuOpen = false; msgMenuId = null; listCtxId = null">
    <aside class="wx-nav">
      <div class="wx-nav-avatar" title="Agent Chat">馆</div>
      <button class="wx-nav-btn" :class="{ active: tab === 'chat' }" @click="tab = 'chat'">
        <span class="icon">💬</span>
        <span>聊天</span>
      </button>
      <button class="wx-nav-btn" :class="{ active: tab === 'contacts' }" @click="tab = 'contacts'">
        <span class="icon">👤</span>
        <span>通讯录</span>
      </button>
      <button class="wx-nav-btn" :class="{ active: tab === 'moments' }" @click="tab = 'moments'">
        <span class="icon">🟢</span>
        <span>朋友圈</span>
      </button>
    </aside>

    <section class="wx-mid">
      <div class="wx-mid-header">
        <span>{{ midTitle }}</span>
        <div class="actions">
          <template v-if="tab === 'contacts'">
            <button class="wx-mini-btn primary" @click="fileInput?.click()">导入角色</button>
            <button class="wx-mini-btn" @click="createGroup">建群</button>
          </template>
          <template v-else-if="tab === 'moments'">
            <span class="wx-hint">时间线</span>
          </template>
        </div>
      </div>
      <input class="wx-search" placeholder="搜索" />
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
              <div class="wx-list-title">{{ c.title }}</div>
              <div class="wx-list-sub">{{ c.last_message || (c.type === 'group' ? '群聊' : '私聊') }}</div>
            </div>
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

      <div v-else-if="tab === 'contacts'" class="wx-list">
        <div v-for="ch in characters" :key="ch.id" class="wx-list-item">
          <label class="wx-check" @click.stop>
            <input v-model="selectedForGroup" type="checkbox" :value="ch.id" />
          </label>
          <div class="wx-avatar">
            <img v-if="ch.avatar_path" :src="ch.avatar_path" alt="" />
            <template v-else>{{ avatarText(ch.name) }}</template>
          </div>
          <div class="wx-list-meta" @click="startPrivate(ch.id)">
            <div class="wx-list-title">{{ ch.name }}</div>
            <div class="wx-list-sub">{{ ch.description || '点击开始私聊' }}</div>
          </div>
          <button class="wx-mini-btn" @click.stop="letThemPost(ch.id)">让 TA 发一条</button>
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
            <div class="wx-list-sub">点击生成朋友圈</div>
          </div>
        </div>
      </div>
    </section>

    <main class="wx-main">
      <template v-if="tab === 'moments'">
        <div class="wx-main-header">
          <span>朋友圈</span>
          <span class="wx-hint">{{ status }}</span>
        </div>
        <div class="wx-chat-body wx-moments-body">
          <div v-for="m in moments" :key="m.id" class="wx-moment-card">
            <div class="wx-moment-head">
              <div class="wx-avatar" style="width: 36px; height: 36px">{{ avatarText(m.character_name) }}</div>
              <span>{{ m.character_name }}</span>
              <span class="wx-moment-time">{{ m.created_at }}</span>
            </div>
            <div class="wx-moment-content">{{ m.content }}</div>
            <div class="wx-moment-actions">
              <button class="wx-mini-btn" :class="{ liked: m.liked }" @click="toggleLike(m)">
                {{ m.liked ? '取消赞' : '点赞' }}{{ m.like_count ? ` · ${m.like_count}` : '' }}
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
                style="margin: 0; flex: 1"
                placeholder="写评论…"
                @keydown.enter.prevent="submitComment(m)"
              />
              <button class="wx-mini-btn primary" @click="submitComment(m)">评论</button>
            </div>
          </div>
          <div v-if="!moments.length" class="wx-empty">
            还没有动态。<br />左侧「朋友圈」点角色，或通讯录点「让 TA 发一条」。
          </div>
        </div>
      </template>

      <template v-else>
        <div class="wx-main-header">
          <div class="wx-header-left">
            <span>{{ activeConversation?.title || '未选择会话' }}</span>
            <div v-if="activeConversation" class="wx-menu-wrap" @click.stop>
              <button class="wx-icon-more" title="会话设置" @click="menuOpen = !menuOpen">…</button>
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
          <div style="flex: 1; display: flex; flex-direction: column; min-width: 0">
            <div ref="chatBody" class="wx-chat-body">
              <template v-if="activeConversation">
                <div
                  v-for="m in messages"
                  :key="m.id"
                  class="wx-msg"
                  :class="m.role === 'user' ? 'me' : 'other'"
                >
                  <div class="wx-avatar sm">
                    {{ m.role === 'user' ? '我' : avatarText(m.character_name || activeConversation.title) }}
                  </div>
                  <div class="wx-msg-col">
                    <div v-if="m.role !== 'user' && activeConversation.type === 'group'" class="wx-msg-name">
                      {{ m.character_name || '角色' }}
                    </div>
                    <div class="wx-bubble-row">
                      <div class="wx-bubble">{{ m.content }}</div>
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
              <div v-else class="wx-empty">
                酒馆 · 多角色聊天<br />
                从左侧「通讯录」导入角色并开始私聊
              </div>
            </div>

            <div v-if="activeConversation" class="wx-composer">
              <div v-if="activeConversation.type === 'group'" class="wx-composer-bar" style="justify-content: flex-start">
                <span class="wx-hint">@指定回复：</span>
                <select v-model="mentionId" style="padding: 4px 8px">
                  <option value="">（未选则轮询下一位）</option>
                  <option v-for="mem in activeConversation.members || []" :key="mem.id" :value="mem.id">
                    @{{ mem.name }}
                  </option>
                </select>
              </div>
              <textarea
                v-model="draft"
                placeholder="输入消息，Enter 发送，Shift+Enter 换行"
                @keydown="onKeydown"
              />
              <div class="wx-composer-bar">
                <span class="wx-hint">主色 #07C160 · 自己气泡 #95EC69</span>
                <button class="wx-send" :disabled="sending || !draft.trim()" @click="send">发送</button>
              </div>
            </div>
          </div>

          <aside v-if="activeConversation?.type === 'group'" class="wx-members">
            <div style="font-weight: 600; margin-bottom: 10px">群成员</div>
            <div v-for="mem in activeConversation.members || []" :key="mem.id" class="wx-list-item" style="padding: 8px 0; border: none">
              <div class="wx-avatar sm">{{ avatarText(mem.name) }}</div>
              <div class="wx-list-title">{{ mem.name }}</div>
            </div>
          </aside>
        </div>
      </template>
    </main>
  </div>
</template>
