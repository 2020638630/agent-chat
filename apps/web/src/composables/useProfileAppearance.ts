/**
 * Profile overlay + appearance (theme / opacity / avatar / cover).
 * D-02 P1 extract from App.vue — behavior unchanged.
 * D-02 P2: profileMemories owned by useMemoryUi (passed in).
 */
import { ref, type Ref } from 'vue';
import { api, type MemoryNote, type Moment, type Profile } from '../api/client';
import {
  THEME_PRESETS,
  DEFAULT_THEME,
  DEFAULT_BG_OPACITY,
  DEFAULT_SPACE_BG_OPACITY,
  normalizeThemeId,
  clampBgOpacity,
  type ThemeId,
} from '../constants/themes';
import type { ProfileView } from './useMoments';

export type { ProfileView };
export { THEME_PRESETS };

export function useProfileAppearance(opts: {
  setStatus: (msg: string) => void;
  applyProfileMoments: (list: Moment[]) => void;
  loadProactiveSettings: () => Promise<void>;
  refreshCharacters: () => Promise<void>;
  refreshConversations: () => Promise<void>;
  startPrivate: (characterId: string) => Promise<void>;
  profileMemories: Ref<MemoryNote[]>;
  loadProfileMemories: (characterId: string) => Promise<void>;
  clearProfileMemories: () => void;
}) {
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
  const refFileInput = ref<HTMLInputElement | null>(null);
  const profileLoading = ref(false);
  const profileEditing = ref(false);
  const editMood = ref('');
  const editBio = ref('');

  async function closeProfile() {
    profileView.value = null;
    profile.value = null;
    opts.clearProfileMemories();
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
      opts.setStatus(err instanceof Error ? err.message : String(err));
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
      await opts.refreshCharacters();
      await opts.refreshConversations();
    }
  }

  async function onAvatarFileChange(ev: Event) {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file || !profileView.value) return;
    mediaBusy.value = true;
    opts.setStatus('上传头像…');
    try {
      const res =
        profileView.value.kind === 'user'
          ? await api.uploadMyAvatar(file)
          : await api.uploadCharacterAvatar(profileView.value.id, file);
      await applyProfileMedia(res.profile);
      opts.setStatus('头像已更新');
    } catch (err) {
      opts.setStatus(err instanceof Error ? err.message : String(err));
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
    opts.setStatus('上传背景…');
    try {
      const res =
        profileView.value.kind === 'user'
          ? await api.uploadMyBg(file)
          : await api.uploadCharacterBg(profileView.value.id, file);
      await applyProfileMedia(res.profile);
      opts.setStatus('背景已更新');
    } catch (err) {
      opts.setStatus(err instanceof Error ? err.message : String(err));
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
    opts.setStatus('上传空间封面…');
    try {
      const res = await api.uploadSpaceBg(file);
      meProfile.value = res.profile;
      if (profileView.value?.kind === 'user' && profile.value) {
        profile.value = { ...profile.value, space_bg_path: res.profile.space_bg_path };
      }
      opts.setStatus('空间封面已更新');
    } catch (err) {
      opts.setStatus(err instanceof Error ? err.message : String(err));
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
      opts.setStatus('已恢复默认头像');
    } catch (err) {
      opts.setStatus(err instanceof Error ? err.message : String(err));
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
      opts.setStatus('已恢复默认背景');
    } catch (err) {
      opts.setStatus(err instanceof Error ? err.message : String(err));
    } finally {
      mediaBusy.value = false;
    }
  }


  async function onRefFileChange(ev: Event) {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file || profileView.value?.kind !== 'character') return;
    mediaBusy.value = true;
    try {
      const res = await api.uploadCharacterRef(profileView.value.id, file);
      await applyProfileMedia(res.profile);
      opts.setStatus('已上传人设参考图');
    } catch (e) {
      opts.setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      mediaBusy.value = false;
    }
  }

  async function removeRefImage(refId: string) {
    if (profileView.value?.kind !== 'character') return;
    mediaBusy.value = true;
    try {
      const res = await api.deleteCharacterRef(profileView.value.id, refId);
      await applyProfileMedia(res.profile);
      opts.setStatus('已删除参考图');
    } catch (e) {
      opts.setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      mediaBusy.value = false;
    }
  }

  async function clearSpaceBg() {
    mediaBusy.value = true;
    try {
      const res = await api.clearSpaceBg();
      meProfile.value = res.profile;
      opts.setStatus('已恢复默认空间封面');
    } catch (err) {
      opts.setStatus(err instanceof Error ? err.message : String(err));
    } finally {
      mediaBusy.value = false;
    }
  }

  async function openMyProfile() {
    profileLoading.value = true;
    profileView.value = { kind: 'user' };
    profileEditing.value = false;
    try {
      const res = await api.getMyProfile();
      profile.value = res.profile;
      meProfile.value = res.profile;
      opts.applyProfileMoments(res.moments || []);
      editMood.value = res.profile.mood || '';
      editBio.value = res.profile.bio || '';
      syncAppearanceFromProfile(res.profile);
      opts.setStatus('');
      await opts.loadProactiveSettings();
    } catch (err) {
      opts.setStatus(err instanceof Error ? err.message : String(err));
    } finally {
      profileLoading.value = false;
    }
  }

  async function openCharacterProfile(id: string) {
    if (!id) return;
    profileLoading.value = true;
    profileView.value = { kind: 'character', id };
    opts.clearProfileMemories();
    await opts.loadProfileMemories(id);
    profileEditing.value = false;
    try {
      const res = await api.getCharacterProfile(id);
      profile.value = res.profile;
      opts.applyProfileMoments(res.moments || []);
      opts.setStatus('');
    } catch (err) {
      opts.setStatus(err instanceof Error ? err.message : String(err));
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
      opts.setStatus('已保存');
    } catch (err) {
      opts.setStatus(err instanceof Error ? err.message : String(err));
    }
  }

  async function messageFromProfile() {
    if (profileView.value?.kind !== 'character') return;
    const id = profileView.value.id;
    await closeProfile();
    await opts.startPrivate(id);
  }

  function onMsgAvatarClick(m: { role: string; character_id?: string | null }) {
    if (m.role === 'user') {
      void openMyProfile();
      return;
    }
    if (m.character_id) void openCharacterProfile(m.character_id);
  }

  return {
    profileView,
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
    refFileInput,
    profileMemories: opts.profileMemories,
    profileLoading,
    profileEditing,
    editMood,
    editBio,
    THEME_PRESETS,
    closeProfile,
    applyAppearanceToDom,
    syncAppearanceFromProfile,
    selectTheme,
    onBgOpacityInput,
    onBgOpacityCommit,
    onSpaceBgOpacityInput,
    onSpaceBgOpacityCommit,
    refreshMeProfile,
    onAvatarFileChange,
    onBgFileChange,
    onSpaceBgFileChange,
    onRefFileChange,
    removeRefImage,
    clearAvatar,
    clearBg,
    clearSpaceBg,
    openMyProfile,
    openCharacterProfile,
    saveMyProfile,
    messageFromProfile,
    onMsgAvatarClick,
  };
}
