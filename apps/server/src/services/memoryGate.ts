/**
 * R-04x memory write-gate spike.
 * MEMORY_GATE_BACKEND=off|laya|heuristic (default off).
 * Laya path shells to scripts/laya_memory_gate.py when Python+laya are available;
 * on failure, returns null so the caller keeps existing extract heuristics.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type MemoryGateKind = 'address' | 'drink' | 'other';

export type MemoryGateDecision = {
  should_write: boolean;
  is_conflict: boolean;
  kind: MemoryGateKind;
  backend: 'laya' | 'heuristic';
  confidence?: number;
};

export type MemoryGateInput = {
  text: string;
  activeMemory?: string | null;
  proposedContent?: string | null;
};

function envBackend(): 'off' | 'laya' | 'heuristic' {
  const v = (process.env.MEMORY_GATE_BACKEND || 'off').trim().toLowerCase();
  if (v === 'laya' || v === 'heuristic') return v;
  return 'off';
}

export function memoryGateBackend(): 'off' | 'laya' | 'heuristic' {
  return envBackend();
}

function inferKind(text: string): MemoryGateKind {
  if (/叫我|称呼|喊我|别叫/.test(text)) return 'address';
  if (/喝|温水|茶|咖啡|美式|红茶/.test(text)) return 'drink';
  return 'other';
}

/** Lightweight baseline used for fixtures / fallback demos — not Laya. */
export function heuristicMemoryGate(input: MemoryGateInput): MemoryGateDecision {
  const text = String(input.text || '').trim();
  const kind = inferKind(text);
  let claim =
    /以后|请叫我|喊我|我只喝|改喝|记住|过敏|我住|别叫我|不要叫/.test(text) &&
    !/^（角色）/.test(text) &&
    !/用户说过|用户希望/.test(text);
  if (/好啊那就|那就温水/.test(text)) claim = false;
  const chitchat =
    !claim &&
    (/哈哈|好累|走走|吃什么|口渴|表情|记得昨天|^[0-9一二三四五六七八九十]+$/.test(text) ||
      text.length <= 2);
  const active = String(input.activeMemory || '');
  let is_conflict = false;
  if (claim && active) {
    if (kind === 'address' && /叫|称呼/.test(active)) {
      is_conflict = true;
    } else if (kind === 'drink' && /喝|温水|茶|咖啡/.test(active) && /喝|改喝/.test(text)) {
      is_conflict = true;
    } else if (kind === 'other' && /之前说错|其实可以|改成/.test(text)) {
      is_conflict = true;
    }
  }
  return {
    should_write: Boolean(claim && !chitchat),
    is_conflict,
    kind,
    backend: 'heuristic',
    confidence: claim ? 0.7 : 0.6,
  };
}

function resolveLayaScript(): string {
  const fromEnv = process.env.LAYA_GATE_SCRIPT;
  if (fromEnv) return fromEnv;
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '../../../../scripts/laya_memory_gate.py');
}

function runLayaPython(input: MemoryGateInput): MemoryGateDecision | null {
  const script = resolveLayaScript();
  const payload = JSON.stringify({
    text: input.text,
    active_memory: input.activeMemory || '',
    proposed_content: input.proposedContent || '',
  });
  const py = process.env.LAYA_PYTHON || process.env.PYTHON || 'python';
  const r = spawnSync(py, [script], {
    input: payload,
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, USE_TF: '0' },
  });
  if (r.status !== 0) {
    console.log('[memory-gate] laya fail', (r.stderr || r.stdout || '').slice(0, 300));
    return null;
  }
  try {
    const out = JSON.parse(String(r.stdout || '').trim());
    if (out.backend === 'heuristic-fallback') {
      return {
        should_write: !!out.should_write,
        is_conflict: !!out.is_conflict,
        kind: (out.kind as MemoryGateKind) || inferKind(input.text),
        backend: 'heuristic',
        confidence: typeof out.confidence === 'number' ? out.confidence : undefined,
      };
    }
    return {
      should_write: !!out.should_write,
      is_conflict: !!out.is_conflict,
      kind: (out.kind as MemoryGateKind) || inferKind(input.text),
      backend: 'laya',
      confidence: typeof out.confidence === 'number' ? out.confidence : undefined,
    };
  } catch (e) {
    console.log('[memory-gate] laya parse fail', e);
    return null;
  }
}

/** Returns null when backend is off or Laya unavailable (caller keeps existing heuristics). */
export function decideMemoryGate(input: MemoryGateInput): MemoryGateDecision | null {
  const backend = envBackend();
  if (backend === 'off') return null;
  if (backend === 'heuristic') return heuristicMemoryGate(input);
  const laya = runLayaPython(input);
  if (laya) return laya;
  console.log('[memory-gate] laya unavailable, falling back to existing extract heuristics');
  return null;
}

export type ExtractOpLike = {
  op: string;
  content?: string;
  fact_id?: string;
  reason?: string;
};

/**
 * Drop ops the gate says should not write. Conflicts stay for existing pending path.
 * Returns original ops when backend is off / gate returns null.
 */
export function gateExtractOps(
  ops: ExtractOpLike[],
  ctx: { recentUserText?: string; activeMemorySummary?: string },
): ExtractOpLike[] {
  if (envBackend() === 'off') return ops;
  const kept: ExtractOpLike[] = [];
  for (const op of ops) {
    if (op.op !== 'add' && op.op !== 'update' && op.op !== 'upsert') {
      kept.push(op);
      continue;
    }
    const text = String(op.content || ctx.recentUserText || '').trim();
    const decision = decideMemoryGate({
      text,
      activeMemory: ctx.activeMemorySummary || '',
      proposedContent: op.content || text,
    });
    if (!decision) {
      kept.push(op);
      continue;
    }
    if (!decision.should_write) {
      console.log('[memory-gate] drop op', decision.backend, text.slice(0, 40));
      continue;
    }
    kept.push(op);
  }
  return kept;
}
