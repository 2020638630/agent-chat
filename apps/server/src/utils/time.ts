/**
 * Single UTC timestamp helpers (D-26).
 * All DB `created_at` / `*_at` writes go through `nowIso()` → `…T…Z` with millis.
 */

/** Current UTC instant as ISO-8601 with millis + Z (matches `Date.toISOString()`). */
export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Normalize a stored timestamp to UTC ISO (`YYYY-MM-DDTHH:mm:ss.sssZ`).
 * SQLite `datetime('now')` space-format (`YYYY-MM-DD HH:MM:SS`) is treated as UTC.
 */
export function toUtcIso(value: string | null | undefined): string {
  if (value == null || value === '') return nowIso();
  const s = String(value).trim();

  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/i.test(s)) {
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }

  // sqlite datetime('now'): YYYY-MM-DD HH:MM:SS (UTC, no zone marker)
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(s)) {
    const d = new Date(s.replace(' ', 'T') + 'Z');
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }

  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(s)) {
    const withZ = /Z$/i.test(s) ? s : `${s}Z`;
    const d = new Date(withZ);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }

  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d.toISOString();
  return nowIso();
}

/** True when value is already a UTC ISO string with Z (nullable empty counts as ok). */
export function isUtcIsoZ(value: string | null | undefined): boolean {
  if (value == null || value === '') return true;
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/i.test(String(value).trim());
}
