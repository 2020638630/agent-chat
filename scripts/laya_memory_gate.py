#!/usr/bin/env python3
"""R-04x: Laya memory write-gate. Reads one JSON object from stdin, prints JSON decision.
Requires: pip install laya (and torch). Prefer convaiinnovations/laya-multilingual for Chinese.
"""
from __future__ import annotations

import json
import os
import sys


def heuristic(payload: dict) -> dict:
    text = (payload.get("text") or "").strip()
    active = (payload.get("active_memory") or "").strip()
    kind = "other"
    if any(k in text for k in ("叫我", "称呼", "喊我", "别叫")):
        kind = "address"
    elif any(k in text for k in ("喝", "温水", "茶", "咖啡", "美式")):
        kind = "drink"
    claim = any(
        k in text
        for k in ("以后", "请叫我", "喊我", "我只喝", "改喝", "记住", "过敏", "我住", "别叫我", "不要叫")
    ) and not text.startswith("（角色）")
    # Agreeing with character drink suggestion is not a durable claim
    if "好啊那就" in text or "那就温水" in text:
        claim = False
    chitchat = (not claim) and (
        any(k in text for k in ("哈哈", "好累", "走走", "吃什么", "口渴", "表情", "记得昨天"))
        or len(text) <= 2
    )
    is_conflict = False
    if claim and active:
        if kind == "address" and ("叫" in active or "称呼" in active):
            is_conflict = True
        elif kind == "drink" and any(k in active for k in ("喝", "温水", "茶", "咖啡")):
            is_conflict = True
        elif kind == "other" and any(k in text for k in ("之前说错", "其实可以")):
            is_conflict = True
        elif kind == "address" and "少爷" in text and "少爷" in active:
            is_conflict = True
    return {
        "should_write": bool(claim and not chitchat),
        "is_conflict": bool(is_conflict),
        "kind": kind,
        "confidence": 0.55,
        "backend": "heuristic-fallback",
    }


def run_laya(payload: dict) -> dict:
    import laya  # type: ignore

    model_id = os.environ.get("LAYA_MODEL", "convaiinnovations/laya-multilingual")
    agent = laya.load(model_id)
    text = payload.get("text") or ""
    active = payload.get("active_memory") or ""
    proposed = payload.get("proposed_content") or text
    state = {
        "utterance": text,
        "active_memory": active,
        "proposed_fact": proposed,
    }
    questions = {
        "should_write": {
            "type": "noul",
            "instructions": (
                "Should we store a durable user memory fact from this chat turn? "
                "True only if the user clearly claims a lasting preference/name/habit; "
                "false for chitchat or merely agreeing with the character's suggestion."
            ),
        },
        "is_conflict": {
            "type": "noul",
            "instructions": (
                "Does the new claim conflict with active_memory (e.g. different name or drink)?"
            ),
        },
        "kind": {
            "type": "choice",
            "instructions": "Which memory kind is this?",
            "criteria": {
                "address": "how to call the user",
                "drink": "drink preference",
                "other": "other lasting fact",
            },
        },
    }
    result = agent.predict(state, questions)
    answers = result.get("answers") if isinstance(result, dict) else None
    if answers is None:
        answers = result if isinstance(result, dict) else {}
    sw = answers.get("should_write") or {}
    ic = answers.get("is_conflict") or {}
    kd = answers.get("kind") or {}
    should = sw.get("noul") if isinstance(sw, dict) else bool(sw)
    conflict = ic.get("noul") if isinstance(ic, dict) else bool(ic)
    kind = kd.get("choice") if isinstance(kd, dict) else "other"
    conf = None
    if isinstance(sw, dict):
        conf = sw.get("confidence") or sw.get("probability")
    return {
        "should_write": bool(should),
        "is_conflict": bool(conflict),
        "kind": kind if kind in ("address", "drink", "other") else "other",
        "confidence": conf,
        "backend": "laya",
        "model": model_id,
    }


def main() -> None:
    raw = sys.stdin.read()
    payload = json.loads(raw or "{}")
    try:
        out = run_laya(payload)
    except Exception as e:
        out = heuristic(payload)
        out["error"] = str(e)[:240]
    sys.stdout.write(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()
