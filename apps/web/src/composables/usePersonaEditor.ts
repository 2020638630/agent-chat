/**
 * Character persona editor (GET fill + PATCH save).
 * Extracted from App.vue for ARCH-3 (D-02 / X-01 surface); no product logic change.
 */
import { reactive, ref } from 'vue';
import { api, type CharacterPersonaPatch } from '../api/client';

export function usePersonaEditor(opts: {
  setStatus: (msg: string) => void;
  clearContactMenu: () => void;
  refreshCharacters: () => Promise<void>;
  /** Re-open character profile after save when that profile is visible. */
  reloadCharacterProfileIfOpen: (id: string) => Promise<void>;
}) {
  const personaEditorOpen = ref(false);
  const personaEditorBusy = ref(false);
  const personaEditorId = ref<string | null>(null);
  const personaDraft = reactive({
    name: '',
    description: '',
    personality: '',
    scenario: '',
    first_mes: '',
    mes_example: '',
    system_prompt: '',
    post_history_instructions: '',
  });

  async function openPersonaEditor(id: string) {
    opts.clearContactMenu();
    personaEditorBusy.value = true;
    personaEditorOpen.value = true;
    personaEditorId.value = id;
    try {
      const res = await api.getCharacter(id);
      const c = res.character;
      personaDraft.name = c.name || '';
      personaDraft.description = c.description || '';
      personaDraft.personality = c.personality || '';
      personaDraft.scenario = c.scenario || '';
      personaDraft.first_mes = c.first_mes || '';
      personaDraft.mes_example = c.mes_example || '';
      personaDraft.system_prompt = c.system_prompt || '';
      personaDraft.post_history_instructions = c.post_history_instructions || '';
    } catch (e: any) {
      personaEditorOpen.value = false;
      personaEditorId.value = null;
      opts.setStatus(e?.message || '\u52a0\u8f7d\u4eba\u8bbe\u5931\u8d25');
    } finally {
      personaEditorBusy.value = false;
    }
  }

  function closePersonaEditor() {
    if (personaEditorBusy.value) return;
    personaEditorOpen.value = false;
    personaEditorId.value = null;
  }

  async function savePersonaEditor() {
    const id = personaEditorId.value;
    if (!id || personaEditorBusy.value) return;
    const name = personaDraft.name.trim();
    if (!name) {
      opts.setStatus('\u89d2\u8272\u540d\u79f0\u4e0d\u80fd\u4e3a\u7a7a');
      return;
    }
    personaEditorBusy.value = true;
    try {
      const body: CharacterPersonaPatch = {
        name,
        description: personaDraft.description,
        personality: personaDraft.personality,
        scenario: personaDraft.scenario,
        first_mes: personaDraft.first_mes,
        mes_example: personaDraft.mes_example,
        system_prompt: personaDraft.system_prompt,
        post_history_instructions: personaDraft.post_history_instructions,
      };
      const res = await api.updateCharacter(id, body);
      await opts.refreshCharacters();
      await opts.reloadCharacterProfileIfOpen(id);
      opts.setStatus(`\u5df2\u4fdd\u5b58\u300c${res.character.name}\u300d\u7684\u4eba\u8bbe`);
      personaEditorOpen.value = false;
      personaEditorId.value = null;
    } catch (e: any) {
      opts.setStatus(e?.message || '\u4fdd\u5b58\u4eba\u8bbe\u5931\u8d25');
    } finally {
      personaEditorBusy.value = false;
    }
  }

  return {
    personaEditorOpen,
    personaEditorBusy,
    personaEditorId,
    personaDraft,
    openPersonaEditor,
    closePersonaEditor,
    savePersonaEditor,
  };
}
