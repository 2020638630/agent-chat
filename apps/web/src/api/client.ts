/**
 * Thin fetch wrapper for apps/server REST APIs. Prefer this over ad-hoc fetch in App.vue.
 */
export type Character = {
  id: string;
  name: string;
  description?: string;
  personality?: string;
  avatar_path?: string | null;
  first_mes?: string;
};

export type Conversation = {
  id: string;
  title: string;
  type: 'private' | 'group';
  last_message?: string | null;
  members?: Array<{ id: string; name: string; avatar_path?: string | null }>;
  updated_at?: string;
  last_read_at?: string | null;
  unread_count?: number;
};

export type ChatMessage = {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant' | 'system';
  character_id?: string | null;
  character_name?: string | null;
  content: string;
  created_at: string;
  source?: 'text' | 'voice' | 'image';
  image_path?: string | null;
};

export type MomentComment = {
  id: string;
  author: string;
  content: string;
  created_at: string;
};

export type ThemeId = 'mist' | 'paper' | 'lake' | 'dusk';

export type ProactiveSettings = {
  enabled: boolean;
  quiet_start: string;
  quiet_end: string;
  daily_cap: number;
  sent_today: number;
};

export type MemoryNote = {
  id: string;
  character_id: string;
  type: string;
  content: string;
  confidence: number;
  status: string;
  supersedes?: string | null;
  created_at: string;
  updated_at: string;
};

export type Profile = {
  id: string;
  kind: 'user' | 'character';
  name: string;
  mood: string;
  bio: string;
  avatar_path?: string | null;
  bg_path?: string | null;
  space_bg_path?: string | null;
  theme?: ThemeId;
  bg_opacity?: number;
  space_bg_opacity?: number;
};

export type ProfileResponse = {
  profile: Profile;
  moments: Moment[];
};

export type Moment = {
  id: string;
  character_id?: string | null;
  author_kind?: 'user' | 'character';
  character_name?: string;
  avatar_path?: string | null;
  content: string;
  image_path?: string | null;
  created_at: string;
  liked?: boolean;
  like_count?: number;
  comments?: MomentComment[];
};

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as any).error || res.statusText);
  }
  return res.json() as Promise<T>;
}

export const api = {
  health: () => fetch('/api/health').then((r) => json<{ ok: boolean }>(r)),

  listCharacters: () =>
    fetch('/api/characters').then((r) => json<{ characters: Character[] }>(r)),

  deleteCharacter: (id: string) =>
    fetch(`/api/characters/${id}`, { method: 'DELETE' }).then((r) =>
      json<{ ok: boolean; deletedId: string; name: string }>(r)
    ),

  importCharacter: async (file: File, opts?: { overwrite?: boolean }) => {
    const fd = new FormData();
    fd.append('file', file);
    const qs = opts?.overwrite ? '?overwrite=1' : '';
    const res = await fetch('/api/characters/import' + qs, { method: 'POST', body: fd });
    if (res.status === 409) {
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        code?: string;
        existing?: { id: string; name: string };
      };
      return {
        conflict: true as const,
        error: body.error || '角色已存在',
        existing: body.existing,
      };
    }
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error((err as any).error || res.statusText);
    }
    return res.json() as Promise<{ character: Character; overwritten?: boolean; conflict?: false }>;
  },

  listConversations: () =>
    fetch('/api/conversations').then((r) => json<{ conversations: Conversation[] }>(r)),

  createConversation: (characterIds: string[], title?: string, type?: 'private' | 'group') =>
    fetch('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ characterIds, title, type }),
    }).then((r) => json<{ conversation: Conversation }>(r)),

  renameConversation: (id: string, title: string) =>
    fetch(`/api/conversations/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    }).then((r) => json<{ conversation: Conversation }>(r)),

  dissolveConversation: (id: string) =>
    fetch(`/api/conversations/${id}`, { method: 'DELETE' }).then((r) =>
      json<{ ok: boolean }>(r)
    ),

  deleteConversation: (id: string) =>
    fetch(`/api/conversations/${id}`, { method: 'DELETE' }).then((r) =>
      json<{ ok: boolean }>(r)
    ),

  listMessages: (id: string) =>
    fetch(`/api/conversations/${id}/messages`).then((r) => json<{ messages: ChatMessage[] }>(r)),

  sendMessage: (id: string, content: string, mentionCharacterId?: string) =>
    fetch(`/api/conversations/${id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, mentionCharacterId }),
    }).then((r) =>
      json<{ userMessage: ChatMessage; assistantMessages: ChatMessage[] }>(r)
    ),

  sendChatImage: async (id: string, file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch(`/api/conversations/${id}/messages/image`, {
      method: 'POST',
      body: fd,
    });
    return json<{ userMessage: ChatMessage; assistantMessages: ChatMessage[] }>(res);
  },

  sendVoiceMessage: async (id: string, blob: Blob, mentionCharacterId?: string) => {
    const fd = new FormData();
    const ext = blob.type.includes('wav') ? 'wav' : blob.type.includes('webm') ? 'webm' : 'wav';
    fd.append('file', blob, `voice.${ext}`);
    if (mentionCharacterId) fd.append('mentionCharacterId', mentionCharacterId);
    const res = await fetch(`/api/conversations/${id}/messages/voice`, {
      method: 'POST',
      body: fd,
    });
    return json<{
      userMessage: ChatMessage;
      assistantMessages: ChatMessage[];
      transcript?: string;
    }>(res);
  },

  messageTtsUrl: (messageId: string) => `/api/messages/${messageId}/tts`,

  deleteMessage: (conversationId: string, messageId: string) =>
    fetch(`/api/conversations/${conversationId}/messages/${messageId}`, {
      method: 'DELETE',
    }).then((r) => json<{ ok: boolean }>(r)),

  clearMessages: (conversationId: string) =>
    fetch(`/api/conversations/${conversationId}/messages`, { method: 'DELETE' }).then((r) =>
      json<{ ok: boolean }>(r)
    ),

  listMoments: () => fetch('/api/moments').then((r) => json<{ moments: Moment[] }>(r)),

  getMyProfile: () => fetch('/api/profiles/me').then((r) => json<ProfileResponse>(r)),

  updateMyProfile: (body: { name?: string; mood?: string; bio?: string; theme?: ThemeId; bg_opacity?: number; space_bg_opacity?: number }) =>
    fetch('/api/profiles/me', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => json<{ profile: Profile }>(r)),

  getCharacterProfile: (id: string) =>
    fetch(`/api/profiles/characters/${id}`).then((r) => json<ProfileResponse>(r)),

  uploadMyAvatar: async (file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return fetch('/api/profiles/me/avatar', { method: 'POST', body: fd }).then((r) =>
      json<{ profile: Profile }>(r)
    );
  },
  clearMyAvatar: () =>
    fetch('/api/profiles/me/avatar', { method: 'DELETE' }).then((r) =>
      json<{ profile: Profile }>(r)
    ),
  uploadMyBg: async (file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return fetch('/api/profiles/me/bg', { method: 'POST', body: fd }).then((r) =>
      json<{ profile: Profile }>(r)
    );
  },
  clearMyBg: () =>
    fetch('/api/profiles/me/bg', { method: 'DELETE' }).then((r) =>
      json<{ profile: Profile }>(r)
    ),
  uploadSpaceBg: async (file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return fetch('/api/space/bg', { method: 'POST', body: fd }).then((r) =>
      json<{ profile: Profile }>(r)
    );
  },
  clearSpaceBg: () =>
    fetch('/api/space/bg', { method: 'DELETE' }).then((r) =>
      json<{ profile: Profile }>(r)
    ),
  uploadCharacterAvatar: async (id: string, file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return fetch(`/api/profiles/characters/${id}/avatar`, { method: 'POST', body: fd }).then((r) =>
      json<{ profile: Profile }>(r)
    );
  },
  clearCharacterAvatar: (id: string) =>
    fetch(`/api/profiles/characters/${id}/avatar`, { method: 'DELETE' }).then((r) =>
      json<{ profile: Profile }>(r)
    ),
  uploadCharacterBg: async (id: string, file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return fetch(`/api/profiles/characters/${id}/bg`, { method: 'POST', body: fd }).then((r) =>
      json<{ profile: Profile }>(r)
    );
  },
  clearCharacterBg: (id: string) =>
    fetch(`/api/profiles/characters/${id}/bg`, { method: 'DELETE' }).then((r) =>
      json<{ profile: Profile }>(r)
    ),

  createMyMoment: async (content: string, file?: File | null) => {
    const fd = new FormData();
    fd.append('content', content);
    if (file) fd.append('file', file);
    return fetch('/api/moments', { method: 'POST', body: fd }).then((r) =>
      json<{ moment: Moment }>(r)
    );
  },

  generateMoment: (characterId: string) =>
    fetch('/api/moments/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ characterId }),
    }).then((r) => json<{ moment: Moment }>(r)),

  deleteMoment: (id: string) =>
    fetch(`/api/moments/${id}`, { method: 'DELETE' }).then((r) =>
      json<{ ok: boolean }>(r)
    ),

  likeMoment: (id: string) =>
    fetch(`/api/moments/${id}/like`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    }).then((r) => json<{ moment: Moment }>(r)),

  commentMoment: (id: string, content: string) =>
    fetch(`/api/moments/${id}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    }).then((r) => json<{ moment: Moment }>(r)),

  getProactiveSettings: () =>
    fetch("/api/proactive").then((r) => json<{ settings: ProactiveSettings }>(r)),

  updateProactiveSettings: (body: {
    enabled?: boolean;
    quiet_start?: string;
    quiet_end?: string;
    daily_cap?: number;
  }) =>
    fetch("/api/proactive", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => json<{ settings: ProactiveSettings }>(r)),

  tickProactive: () =>
    fetch("/api/proactive/tick", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    }).then((r) =>
      json<{
        ran: boolean;
        sent: boolean;
        reason?: string;
        character_id?: string;
        conversation_id?: string;
        message_id?: string;
        content?: string;
      }>(r)
    ),

  listCharacterMemories: (id: string, status?: string) =>
    fetch(`/api/characters/${id}/memories${status ? `?status=${encodeURIComponent(status)}` : ''}`).then((r) =>
      json<{ memories: MemoryNote[] }>(r)
    ),
};
