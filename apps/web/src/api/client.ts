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
};

export type ChatMessage = {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant' | 'system';
  character_id?: string | null;
  character_name?: string | null;
  content: string;
  created_at: string;
};

export type MomentComment = {
  id: string;
  author: string;
  content: string;
  created_at: string;
};

export type Moment = {
  id: string;
  character_id: string;
  character_name?: string;
  avatar_path?: string | null;
  content: string;
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

  importCharacter: async (file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return fetch('/api/characters/import', { method: 'POST', body: fd }).then((r) =>
      json<{ character: Character }>(r)
    );
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

  deleteMessage: (conversationId: string, messageId: string) =>
    fetch(`/api/conversations/${conversationId}/messages/${messageId}`, {
      method: 'DELETE',
    }).then((r) => json<{ ok: boolean }>(r)),

  clearMessages: (conversationId: string) =>
    fetch(`/api/conversations/${conversationId}/messages`, { method: 'DELETE' }).then((r) =>
      json<{ ok: boolean }>(r)
    ),

  listMoments: () => fetch('/api/moments').then((r) => json<{ moments: Moment[] }>(r)),

  generateMoment: (characterId: string) =>
    fetch('/api/moments/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ characterId }),
    }).then((r) => json<{ moment: Moment }>(r)),

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
};
