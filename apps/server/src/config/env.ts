/**
 * Single env reader for the server. Prefer this over local `function env` copies.
 * Never log secret values.
 */
export function env(name: string, fallback = ''): string {
  return process.env[name]?.trim() || fallback;
}

export function requireEnv(name: string): string {
  const v = env(name);
  if (!v) throw new Error(`未配置 ${name}，请在本机 .env 中填写（勿提交密钥）`);
  return v;
}

export function envInt(name: string, fallback: number): number {
  const raw = env(name);
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}
