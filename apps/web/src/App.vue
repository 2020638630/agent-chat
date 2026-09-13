<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
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

const activeConversation = computed(() =>
  conversations.value.find((c) => c.id === activeConversationId.value) ?? null
);

const midTitle = computed(() => {
  if (tab.value === 'chat') return '微信';
  if (tab.value === 'contacts') return '通讯录';
  return '朋友圈';
});

function avatarText(name?: string) {
  return (name || '?').slice(0, 1);
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
  const res = await api.listMessages(id);
  messages.value = res.messages;
  await nextTick();
  if (chatBody.value) chatBody.value.scrollTop = chatBody.value.scrollHeight;
}

async function startPrivate(characterId: string) {
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

async function letThemPost(characterId: string) {
  status.value = '生成朋友圈…';
  try {
    await api.generateMoment(characterId);
    await refreshMoments();
    status.value = '';
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
  <div class="wx-shell">
    <!-- 最左导航 -->
    <aside class="wx-nav">
      <div class="wx-nav-avatar">我</div>
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

    <!-- 中栏 -->
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
        <div
          v-for="c in conversations"
          :key="c.id"
          class="wx-list-item"
          :class="{ active: c.id === activeConversationId }"
          @click="openConversation(c.id)"
        >
          <div class="wx-avatar">{{ avatarText(c.title) }}</div>
          <div class="wx-list-meta">
            <div class="wx-list-title">{{ c.title }}</div>
            <div class="wx-list-sub">{{ c.last_message || (c.type === 'group' ? '群聊' : '私聊') }}</div>
          </div>
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

    <!-- 右侧主区 -->
    <main class="wx-main">
      <template v-if="tab === 'moments'">
        <div class="wx-main-header">朋友圈</div>
        <div class="wx-chat-body" style="background: #f5f5f5">
          <div v-for="m in moments" :key="m.id" class="wx-moment-card">
            <div class="wx-moment-head">
              <div class="wx-avatar" style="width: 36px; height: 36px">{{ avatarText(m.character_name) }}</div>
              <span>{{ m.character_name }}</span>
              <span class="wx-moment-time">{{ m.created_at }}</span>
            </div>
            <div>{{ m.content }}</div>
          </div>
          <div v-if="!moments.length" class="wx-empty">还没有动态。左侧点「让 TA 发一条」。</div>
        </div>
      </template>

      <template v-else>
        <div class="wx-main-header">
          <span>{{ activeConversation?.title || '未选择会话' }}</span>
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
                  <div class="wx-avatar">
                    {{ m.role === 'user' ? '我' : avatarText(m.character_name || activeConversation.title) }}
                  </div>
                  <div class="wx-msg-col">
                    <div v-if="m.role !== 'user' && activeConversation.type === 'group'" class="wx-msg-name">
                      {{ m.character_name || '角色' }}
                    </div>
                    <div class="wx-bubble">{{ m.content }}</div>
                  </div>
                </div>
              </template>
              <div v-else class="wx-empty">
                微信风格多角色聊天<br />
                从左侧「通讯录」导入角色并开始私聊
              </div>
            </div>

            <div v-if="activeConversation" class="wx-composer">
              <div v-if="activeConversation.type === 'group'" class="wx-composer-bar" style="justify-content: flex-start">
                <span class="wx-hint">@指定回复：</span>
                <select v-model="mentionId" style="padding: 4px 8px">
                  <option value="">（默认首位）</option>
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
              <div class="wx-avatar" style="width: 32px; height: 32px">{{ avatarText(mem.name) }}</div>
              <div class="wx-list-title">{{ mem.name }}</div>
            </div>
          </aside>
        </div>
      </template>
    </main>
  </div>
</template>
