/**
 * Proactive messaging settings (enable toggle + quiet/cap snapshot).
 * Extracted from App.vue for ARCH-3 (D-02); no product logic change.
 */
import { ref } from 'vue';
import { api } from '../api/client';

export type ProactiveSettingsSnapshot = {
  enabled: boolean;
  quiet_start?: string;
  quiet_end?: string;
  daily_cap?: number;
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

  function applyProactiveSettings(settings: ProactiveSettingsSnapshot) {
    proactiveEnabled.value = !!settings.enabled;
    proactiveSentToday.value = Number(settings.sent_today ?? 0);
    proactiveDailyCap.value = Number(settings.daily_cap ?? 3);
    proactiveQuietStart.value = settings.quiet_start || '23:00';
    proactiveQuietEnd.value = settings.quiet_end || '08:00';
    proactiveInQuiet.value = !!settings.in_quiet;
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

  return {
    proactiveEnabled,
    proactiveBusy,
    proactiveSentToday,
    proactiveDailyCap,
    proactiveInQuiet,
    proactiveQuietStart,
    proactiveQuietEnd,
    applyProactiveSettings,
    loadProactiveSettings,
    toggleProactiveEnabled,
  };
}
