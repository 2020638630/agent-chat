export type ThemeId = 'mist' | 'paper' | 'lake' | 'dusk';

export type ThemePreset = {
  id: ThemeId;
  label: string;
  hint: string;
};

/** U-05 light glass family — CSS vars applied via data-theme on <html>. */
export const THEME_PRESETS: ThemePreset[] = [
  { id: 'mist', label: '雾面', hint: '浅紫雾面（默认）' },
  { id: 'paper', label: '暖纸', hint: '暖米纸感' },
  { id: 'lake', label: '湖青', hint: '冷青清水' },
  { id: 'dusk', label: '暮色', hint: '浅灰紫暮光' },
];

export const DEFAULT_THEME: ThemeId = 'mist';
export const DEFAULT_BG_OPACITY = 0.5;
export const DEFAULT_SPACE_BG_OPACITY = 0.5;

export function normalizeThemeId(v: unknown): ThemeId {
  const s = String(v ?? 'mist').trim().toLowerCase();
  return (THEME_PRESETS.some((t) => t.id === s) ? s : 'mist') as ThemeId;
}

export function clampBgOpacity(v: unknown, fallback = DEFAULT_BG_OPACITY): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0.2, Math.round(n * 100) / 100));
}
