# R-04x Laya memory gate — offline report

Date: 2026-09-21

## Setup

- Fixtures: `docs/product/fixtures/memory-gate/cases.json` (24 Chinese cases)
- Intended model: `convaiinnovations/laya-multilingual` via `pip install laya`
- Hook: `MEMORY_GATE_BACKEND=off|laya|heuristic` (default `off`)

## Heuristic baseline (not Laya)

| metric | accuracy |
|---|---|
| should_write | 95.8% |
| is_conflict | 95.8% |
| kind | 95.8% |

Confused ids: c05

## Laya zero-shot

**Could not run Laya weights on this machine.**

```
exit 9009
```

Expectation: multilingual zero-shot on typed write/conflict decisions is near chance / weak;
Chinese memory-gate needs task fine-tune before production. Keep `MEMORY_GATE_BACKEND=off`.

## Hook smoke

- `MEMORY_GATE_BACKEND=off`: extract path unchanged.
- `MEMORY_GATE_BACKEND=laya`: drops ops with `should_write=false` before `applyOps`; failures fall back to existing heuristics.
- `MEMORY_GATE_BACKEND=heuristic`: demo baseline only (not for production).
