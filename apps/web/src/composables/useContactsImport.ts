/**
 * Contacts: character list, group create, import / overwrite, delete character.
 * D-02 P1 extract from App.vue — behavior unchanged.
 */
import { computed, ref, type Ref } from 'vue';
import { api, type Character } from '../api/client';
import type { ProfileView } from './useMoments';

export function useContactsImport(opts: {
  setStatus: (msg: string) => void;
  profileView: Ref<ProfileView>;
  closeProfile: () => void | Promise<void>;
  refreshConversations: () => Promise<void>;
  openConversation: (id: string) => Promise<void>;
  refreshMoments: () => Promise<void>;
  /** Clear open private chat when its peer character is deleted. */
  clearOpenPrivateChatIfPeer: (characterId: string) => void;
}) {
  const characters = ref<Character[]>([]);
  const selectedForGroup = ref<string[]>([]);
  const creatingGroup = ref(false);
  const groupTitleDraft = ref('');
  const groupSearch = ref('');
  const contactMenuId = ref<string | null>(null);
  const fileInput = ref<HTMLInputElement | null>(null);
  const pendingOverwriteImport = ref<{ file: File; name: string } | null>(null);
  const pendingDeleteCharacter = ref<{ id: string; name: string } | null>(null);

  const groupPickableCharacters = computed(() => {
    const q = groupSearch.value.trim().toLowerCase();
    if (!q) return characters.value;
    return characters.value.filter((ch) => {
      const name = (ch.name || '').toLowerCase();
      const desc = (ch.description || '').toLowerCase();
      return name.includes(q) || desc.includes(q);
    });
  });

  async function refreshCharacters() {
    const res = await api.listCharacters();
    characters.value = res.characters;
  }

  function openGroupCreator() {
    creatingGroup.value = true;
    selectedForGroup.value = [];
    groupTitleDraft.value = '';
    groupSearch.value = '';
    contactMenuId.value = null;
    opts.setStatus('');
  }

  function cancelGroupCreator() {
    creatingGroup.value = false;
    selectedForGroup.value = [];
    groupTitleDraft.value = '';
    groupSearch.value = '';
    opts.setStatus('');
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
      opts.setStatus('请至少选择 2 名角色');
      return;
    }
    const title = groupTitleDraft.value.trim() || undefined;
    try {
      const { conversation } = await api.createConversation(selectedForGroup.value, title, 'group');
      creatingGroup.value = false;
      selectedForGroup.value = [];
      groupTitleDraft.value = '';
      groupSearch.value = '';
      await opts.refreshConversations();
      await opts.openConversation(conversation.id);
      opts.setStatus('');
    } catch (err) {
      opts.setStatus(err instanceof Error ? err.message : String(err));
    }
  }

  async function runCharacterImport(file: File, overwrite = false) {
    opts.setStatus(overwrite ? '正在覆盖人设…' : '正在导入…');
    const res = await api.importCharacter(file, { overwrite });
    if ('conflict' in res && res.conflict) {
      pendingOverwriteImport.value = {
        file,
        name: res.existing?.name || '该角色',
      };
      opts.setStatus('');
      return;
    }
    pendingOverwriteImport.value = null;
    await refreshCharacters();
    opts.setStatus(
      res.overwritten
        ? `已覆盖「${res.character.name}」的人设（聊天记录保留）`
        : `已导入：${res.character.name}`,
    );
  }

  async function onImport(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    try {
      await runCharacterImport(file, false);
    } catch (err) {
      opts.setStatus(err instanceof Error ? err.message : String(err));
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
      if (opts.profileView.value?.kind === 'character' && opts.profileView.value.id === pending.id) {
        await opts.closeProfile();
      }
      opts.clearOpenPrivateChatIfPeer(pending.id);
      await Promise.all([refreshCharacters(), opts.refreshConversations(), opts.refreshMoments()]);
      opts.setStatus(`已删除角色「${pending.name}」`);
    } catch (err) {
      opts.setStatus(err instanceof Error ? err.message : String(err));
    }
  }

  function cancelOverwriteImport() {
    pendingOverwriteImport.value = null;
    opts.setStatus('已取消覆盖导入');
  }

  async function confirmOverwriteImport() {
    const pending = pendingOverwriteImport.value;
    if (!pending) return;
    try {
      await runCharacterImport(pending.file, true);
    } catch (err) {
      opts.setStatus(err instanceof Error ? err.message : String(err));
      pendingOverwriteImport.value = null;
    }
  }

  function onLeaveContactsTab() {
    creatingGroup.value = false;
    contactMenuId.value = null;
  }

  return {
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
    refreshCharacters,
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
  };
}