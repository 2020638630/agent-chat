/**
 * Moments / space feed state: list, filter, composer (with image), like/comment/delete.
 * Extracted from App.vue for ARCH-3 (D-02); no product logic change.
 */
import { computed, reactive, ref, type Ref } from 'vue';
import { api, type Character, type Moment } from '../api/client';

export type ProfileView = null | { kind: 'user' } | { kind: 'character'; id: string };

function isSameLocalDay(iso: string, now = new Date()) {
  const d = new Date(iso);
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

export function useMoments(opts: {
  setStatus: (msg: string) => void;
  characters: Ref<Character[]>;
  profileView: Ref<ProfileView>;
  profileMoments: Ref<Moment[]>;
  tab: Ref<string>;
  openMyProfile: () => void | Promise<void>;
  openCharacterProfile: (id: string) => void | Promise<void>;
}) {
  const moments = ref<Moment[]>([]);
  const momentsFilterId = ref<string | null>(null);
  const commentDrafts = reactive<Record<string, string>>({});
  const momentMenuId = ref<string | null>(null);
  const pendingDeleteMoment = ref<Moment | null>(null);
  const momentComposerOpen = ref(false);
  const momentDraft = ref('');
  const momentImageFile = ref<File | null>(null);
  const momentImagePreview = ref<string | null>(null);
  const momentPostBusy = ref(false);
  const momentImageInput = ref<HTMLInputElement | null>(null);
  const expandedLikeMomentId = ref<string | null>(null);

  const momentsToday = computed(() => moments.value.filter((m) => isSameLocalDay(m.created_at)));

  const momentsTodayAuthors = computed(() => {
    const seen = new Set<string>();
    const list: Array<{ id: string; name: string; avatar_path?: string | null }> = [];
    for (const m of momentsToday.value) {
      if (!m.character_id || seen.has(m.character_id)) continue;
      seen.add(m.character_id);
      list.push({
        id: m.character_id,
        name: m.character_name || '\u89d2\u8272',
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
    return opts.characters.value
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

  function clearMomentsFilter() {
    momentsFilterId.value = null;
  }

  async function refreshMoments() {
    const res = await api.listMoments();
    moments.value = res.moments;
  }

  function toggleLikeList(momentId: string) {
    expandedLikeMomentId.value = expandedLikeMomentId.value === momentId ? null : momentId;
  }

  function clearMomentImage() {
    if (momentImagePreview.value) {
      URL.revokeObjectURL(momentImagePreview.value);
    }
    momentImagePreview.value = null;
    momentImageFile.value = null;
    if (momentImageInput.value) momentImageInput.value.value = '';
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

  function onMomentImagePick(ev: Event) {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0] || null;
    if (!file) return;
    const okType =
      /image\/(jpeg|jpg|png|webp)/i.test(file.type) || /\.(jpe?g|png|webp)$/i.test(file.name);
    if (!okType) {
      opts.setStatus('\u4ec5\u652f\u6301 jpg / png / webp');
      input.value = '';
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      opts.setStatus('\u56fe\u7247\u4e0d\u80fd\u8d85\u8fc7 5MB');
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
      if (opts.profileView.value?.kind === 'user') {
        opts.profileMoments.value = [
          res.moment,
          ...opts.profileMoments.value.filter((m) => m.id !== res.moment.id),
        ];
      }
      closeMomentComposer();
      opts.setStatus('\u52a8\u6001\u5df2\u53d1\u5e03');
    } catch (err) {
      opts.setStatus(err instanceof Error ? err.message : String(err));
    } finally {
      momentPostBusy.value = false;
    }
  }

  function openMomentAuthor(m: Moment) {
    if (m.author_kind === 'user' || !m.character_id) {
      void opts.openMyProfile();
      return;
    }
    void opts.openCharacterProfile(m.character_id);
  }

  async function letThemPost(characterId: string) {
    opts.setStatus('\u751f\u6210\u52a8\u6001\u2026');
    try {
      await api.generateMoment(characterId);
      opts.tab.value = 'moments';
      await refreshMoments();
      opts.setStatus('');
    } catch (err) {
      opts.setStatus(err instanceof Error ? err.message : String(err));
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
      opts.profileMoments.value = opts.profileMoments.value.filter((x) => x.id !== m.id);
      delete commentDrafts[m.id];
      opts.setStatus('\u52a8\u6001\u5df2\u5220\u9664');
      pendingDeleteMoment.value = null;
    } catch (err) {
      opts.setStatus(err instanceof Error ? err.message : String(err));
    }
  }

  async function toggleLike(m: Moment) {
    try {
      const res = await api.likeMoment(m.id);
      const idx = moments.value.findIndex((x) => x.id === m.id);
      if (idx >= 0) moments.value[idx] = res.moment;
    } catch (err) {
      opts.setStatus(err instanceof Error ? err.message : String(err));
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
      opts.setStatus(err instanceof Error ? err.message : String(err));
    }
  }

  return {
    moments,
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
    refreshMoments,
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
  };
}
