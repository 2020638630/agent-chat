/**
 * Proactive messaging settings (enable + X-03 daily_cap/quiet + X-07 space intensity).
 * Extracted from App.vue for ARCH-3 (D-02).
 */
import { ref } from 'vue';
import { api } from '../api/client';

export type ProactiveSettingsSnapshot = {
  enabled: boolean;
  quiet_start?: string;
  quiet_end?: string;
  daily_cap?: number;
  space_like_max?: number;
  space_comment_max?: number;
  moment_image_enabled?: boolean;
  moment_image_daily_cap?: number;
  moment_image_sent_today?: number;
  sent_today?: number;
  in_quiet?: boolean;
};

export function useProactiveSettings(opts: { setStatus: (msg: string) => void }) {
  const proactiveEnabled = ref(false);
  const proactiveBusy = ref(false);
  const proactiveSentToday = ref(0);
  const proactiveDailyCap = ref(3);
  const proactiveInQuiet = ref(false);
  const proactiveQuietStart = ref('23:00');
  const proactiveQuietEnd = ref('08:00');
  const proactiveSpaceLikeMax = ref(2);
  const proactiveSpaceCommentMax = ref(1);
  const proactiveMomentImageEnabled = ref(false);
  const proactiveMomentImageDailyCap = ref(1);
  const proactiveMomentImageSentToday = ref(0);

  function applyProactiveSettings(settings: ProactiveSettingsSnapshot) {
    proactiveEnabled.value = !!settings.enabled;
    proactiveSentToday.value = Number(settings.sent_today ?? 0);
    proactiveDailyCap.value = Number(settings.daily_cap ?? 3);
    proactiveQuietStart.value = settings.quiet_start || '23:00';
    proactiveQuietEnd.value = settings.quiet_end || '08:00';
    proactiveInQuiet.value = !!settings.in_quiet;
    proactiveSpaceLikeMax.value = Number(settings.space_like_max ?? 2);
    proactiveSpaceCommentMax.value = Number(settings.space_comment_max ?? 1);
    proactiveMomentImageEnabled.value = !!settings.moment_image_enabled;
    proactiveMomentImageDailyCap.value = Number(settings.moment_image_daily_cap ?? 1);
    proactiveMomentImageSentToday.value = Number(settings.moment_image_sent_today ?? 0);
  }

  async function loadProactiveSettings() {
    try {
      const res = await api.getProactiveSettings();
      applyProactiveSettings(res.settings);
    } catch {
      /* ignore */
    }
  }

  async function toggleProactiveEnabled(next: boolean) {
    proactiveBusy.value = true;
    try {
      const res = await api.updateProactiveSettings({ enabled: next });
      applyProactiveSettings(res.settings);
    } catch (err) {
      opts.setStatus(err instanceof Error ? err.message : String(err));
    } finally {
      proactiveBusy.value = false;
    }
  }

  /** X-03 / X-07: persist limits; server clamps. */
  async function updateProactiveLimits(patch: {
    daily_cap?: number;
    quiet_start?: string;
    quiet_end?: string;
    space_like_max?: number;
    space_comment_max?: number;
    moment_image_enabled?: boolean;
    moment_image_daily_cap?: number;
  }) {
    proactiveBusy.value = true;
    try {
      const body: {
        daily_cap?: number;
        quiet_start?: string;
        quiet_end?: string;
        space_like_max?: number;
        space_comment_max?: number;
        moment_image_enabled?: boolean;
        moment_image_daily_cap?: number;
      } = {};
      if (patch.daily_cap !== undefined) {
        const n = Math.round(Number(patch.daily_cap));
        body.daily_cap = Number.isFinite(n) ? n : proactiveDailyCap.value;
      }
      if (patch.quiet_start !== undefined) body.quiet_start = String(patch.quiet_start);
      if (patch.quiet_end !== undefined) body.quiet_end = String(patch.quiet_end);
      if (patch.space_like_max !== undefined) {
        const n = Math.round(Number(patch.space_like_max));
        body.space_like_max = Number.isFinite(n) ? n : proactiveSpaceLikeMax.value;
      }
      if (patch.space_comment_max !== undefined) {
        const n = Math.round(Number(patch.space_comment_max));
        body.space_comment_max = Number.isFinite(n) ? n : proactiveSpaceCommentMax.value;
      }
      if (patch.moment_image_enabled !== undefined) {
        body.moment_image_enabled = !!patch.moment_image_enabled;
      }
      if (patch.moment_image_daily_cap !== undefined) {
        const n = Math.round(Number(patch.moment_image_daily_cap));
        body.moment_image_daily_cap = Number.isFinite(n)
          ? n
          : proactiveMomentImageDailyCap.value;
      }
      const res = await api.updateProactiveSettings(body);
      applyProactiveSettings(res.settings);
      opts.setStatus('主动设置已保存');
      setTimeout(() => opts.setStatus(''), 1400);
    } catch (err) {
      opts.setStatus(err instanceof Error ? err.message : String(err));
      await loadProactiveSettings();
    } finally {
      proactiveBusy.value = false;
    }
  }

  function onDailyCapChange(ev: Event) {
    const el = ev.target as HTMLInputElement;
    const n = Math.round(Number(el.value));
    void updateProactiveLimits({ daily_cap: n });
  }

  function onQuietStartChange(ev: Event) {
    const el = ev.target as HTMLInputElement;
    void updateProactiveLimits({ quiet_start: el.value });
  }

  function onQuietEndChange(ev: Event) {
    const el = ev.target as HTMLInputElement;
    void updateProactiveLimits({ quiet_end: el.value });
  }

  function onSpaceLikeMaxChange(ev: Event) {
    const el = ev.target as HTMLInputElement;
    const n = Math.round(Number(el.value));
    void updateProactiveLimits({ space_like_max: n });
  }

  function onSpaceCommentMaxChange(ev: Event) {
    const el = ev.target as HTMLInputElement;
    const n = Math.round(Number(el.value));
    void updateProactiveLimits({ space_comment_max: n });
  }

  function toggleMomentImageEnabled(next: boolean) {
    void updateProactiveLimits({ moment_image_enabled: next });
  }

  function onMomentImageDailyCapChange(ev: Event) {
    const el = ev.target as HTMLInputElement;
    const n = Math.round(Number(el.value));
    void updateProactiveLimits({ moment_image_daily_cap: n });
  }

  return {
    proactiveEnabled,
    proactiveBusy,
    proactiveSentToday,
    proactiveDailyCap,
    proactiveInQuiet,
    proactiveQuietStart,
    proactiveQuietEnd,
    proactiveSpaceLikeMax,
    proactiveSpaceCommentMax,
    proactiveMomentImageEnabled,
    proactiveMomentImageDailyCap,
    proactiveMomentImageSentToday,
    applyProactiveSettings,
    loadProactiveSettings,
    toggleProactiveEnabled,
    updateProactiveLimits,
    onDailyCapChange,
    onQuietStartChange,
    onQuietEndChange,
    onSpaceLikeMaxChange,
    onSpaceCommentMaxChange,
    toggleMomentImageEnabled,
    onMomentImageDailyCapChange,
  };
}
