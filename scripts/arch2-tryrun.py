"""
ARCH-2 try-run (acceptance, not a separate knife).
Proves provider pipe can hit: DeepSeek text / cloud VLM / Gemini TTS.
Never prints API keys. Reads .env + process env.
"""
from __future__ import annotations

import base64
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "scripts" / "_tryrun_out"
OUT_DIR.mkdir(parents=True, exist_ok=True)


def load_dotenv(path: Path) -> dict[str, str]:
    env: dict[str, str] = {}
    if not path.exists():
        return env
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        s = line.strip()
        if not s or s.startswith("#") or "=" not in s:
            continue
        k, v = s.split("=", 1)
        env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def secret(name: str, file_env: dict[str, str]) -> str:
    return (os.environ.get(name) or file_env.get(name) or "").strip()


def http_json(url: str, *, method: str = "GET", headers: dict | None = None, body: dict | None = None, timeout: int = 120):
    data = None
    hdrs = dict(headers or {})
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        hdrs.setdefault("Content-Type", "application/json")
    req = urllib.request.Request(url, data=data, headers=hdrs, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            ctype = resp.headers.get("Content-Type", "")
            if "application/json" in ctype or raw[:1] in (b"{", b"["):
                return resp.status, json.loads(raw.decode("utf-8", "replace")), raw
            return resp.status, None, raw
    except urllib.error.HTTPError as e:
        err = e.read().decode("utf-8", "replace")[:400]
        raise RuntimeError(f"HTTP {e.code}: {err}") from e


def run_deepseek(file_env: dict[str, str]) -> dict:
    key = secret("DEEPSEEK_API_KEY", file_env) or secret("LLM_API_KEY", file_env)
    # Prefer official DeepSeek if dedicated key present
    ds_key = secret("DEEPSEEK_API_KEY", file_env)
    if ds_key:
        base = "https://api.deepseek.com"
        model = "deepseek-flash"
        key = ds_key
        source = "official+DEEPSEEK_API_KEY"
    else:
        # fallback: SiliconFlow hosted DeepSeek
        key = secret("STT_API_KEY", file_env) or secret("LLM_API_KEY", file_env)
        base = (file_env.get("STT_BASE_URL") or "https://api.siliconflow.cn/v1").rstrip("/")
        if base.endswith("/v1"):
            pass
        else:
            base = base + "/v1" if not base.endswith("/v1") else base
        # normalize: siliconflow base already has /v1
        model = "deepseek-ai/DeepSeek-V4-Flash"
        source = "siliconflow+STT_API_KEY"
    if not key:
        return {"ok": False, "reason": "缺 DEEPSEEK_API_KEY（或可回落的硅基 Key）", "need_keys": ["DEEPSEEK_API_KEY"]}

    # OpenAI-compatible chat
    chat_base = base if base.endswith("/v1") or "deepseek.com" in base else base
    # deepseek.com uses https://api.deepseek.com/chat/completions (also accepts /v1)
    url = "https://api.deepseek.com/chat/completions" if "deepseek.com" in base else f"{base}/chat/completions"
    t0 = time.time()
    status, data, _ = http_json(
        url,
        method="POST",
        headers={"Authorization": f"Bearer {key}"},
        body={
            "model": model,
            "messages": [
                {"role": "system", "content": "用一句话中文回答。"},
                {"role": "user", "content": "ARCH-2试跑：1+1等于几？只答数字。"},
            ],
            "temperature": 0.2,
            "max_tokens": 64,
            "stream": False,
        },
        timeout=90,
    )
    content = ((data or {}).get("choices") or [{}])[0].get("message", {}).get("content", "")
    content = (content or "").strip()
    ms = int((time.time() - t0) * 1000)
    ok = status == 200 and bool(content)
    return {
        "ok": ok,
        "source": source,
        "model": model,
        "ms": ms,
        "reply_preview": content[:80],
        "reason": "通" if ok else f"空回复或非200 status={status}",
    }


def run_vlm(file_env: dict[str, str]) -> dict:
    """Cloud VLM via SiliconFlow Qwen3-VL (proves vision pipe beyond local 7b)."""
    key = secret("STT_API_KEY", file_env) or secret("LLM_API_KEY", file_env)
    if not key:
        return {"ok": False, "reason": "缺硅基/云 Key（STT_API_KEY 或 LLM_API_KEY）", "need_keys": ["STT_API_KEY", "LLM_API_KEY"]}

    base = (file_env.get("STT_BASE_URL") or "https://api.siliconflow.cn/v1").rstrip("/")
    model = "Qwen/Qwen3-VL-8B-Instruct"
    img_path = ROOT / "picture" / "raw" / "creature" / "butterfly-on-flower-bf232d12.jpg"
    if not img_path.exists():
        # fallback tiny upload
        cand = list((ROOT / "uploads").glob("*.png")) + list((ROOT / "uploads").glob("*.jpg"))
        if not cand:
            return {"ok": False, "reason": "无测试图片"}
        img_path = cand[0]
    raw = img_path.read_bytes()
    # keep payload modest
    if len(raw) > 400_000:
        # pick smaller butterfly
        img_path = ROOT / "picture" / "raw" / "creature" / "butterfly-on-flower-bf232d12.jpg"
        raw = img_path.read_bytes()
    b64 = base64.b64encode(raw).decode("ascii")
    mime = "image/jpeg" if img_path.suffix.lower() in {".jpg", ".jpeg"} else "image/png"
    data_url = f"data:{mime};base64,{b64}"

    t0 = time.time()
    status, data, _ = http_json(
        f"{base}/chat/completions",
        method="POST",
        headers={"Authorization": f"Bearer {key}"},
        body={
            "model": model,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "用中文一句话描述图中主要物体，不要废话。"},
                        {"type": "image_url", "image_url": {"url": data_url}},
                    ],
                }
            ],
            "temperature": 0.2,
            "max_tokens": 128,
            "stream": False,
        },
        timeout=180,
    )
    content = ((data or {}).get("choices") or [{}])[0].get("message", {}).get("content", "")
    content = (content or "").strip()
    ms = int((time.time() - t0) * 1000)
    ok = status == 200 and bool(content)
    return {
        "ok": ok,
        "source": "siliconflow+Qwen3-VL-8B",
        "model": model,
        "image": str(img_path.relative_to(ROOT)),
        "ms": ms,
        "reply_preview": content[:120],
        "reason": "通（云 VLM；非本地假多模态）" if ok else f"失败 status={status}",
        "note": "产品备胎称「官方 VLM」；本机无 OpenAI/厂商官网 VLM Key，用硅基托管 Qwen3-VL 验证读图管道。",
    }


def run_gemini_tts(file_env: dict[str, str]) -> dict:
    key = secret("GEMINI_API_KEY", file_env) or secret("GOOGLE_API_KEY", file_env) or secret("GOOGLE_GENAI_API_KEY", file_env)
    if not key:
        return {
            "ok": False,
            "reason": "未配置 GEMINI_API_KEY（或 GOOGLE_API_KEY）",
            "need_keys": ["GEMINI_API_KEY"],
            "endpoint": "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash-tts:generateContent",
        }

    model = "gemini-3.8-flash-tts"
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
    body = {
        "contents": [{"role": "user", "parts": [{"text": "你好，这是 ARCH-2 试跑。"}]}],
        "generationConfig": {
            "responseModalities": ["AUDIO"],
            "speechConfig": {"voiceConfig": {"prebuiltVoiceConfig": {"voiceName": "Kore"}}},
        },
    }
    # Gemini accepts x-goog-api-key header or ?key=
    t0 = time.time()
    try:
        status, data, raw = http_json(
            url,
            method="POST",
            headers={"x-goog-api-key": key, "Content-Type": "application/json"},
            body=body,
            timeout=120,
        )
    except RuntimeError as e:
        # try alternate voiceConfig shape
        err = str(e)
        body2 = {
            "contents": [{"parts": [{"text": "你好，这是 ARCH-2 试跑。"}]}],
            "generationConfig": {
                "responseModalities": ["AUDIO"],
                "speechConfig": {"voiceConfig": {"voice": "Kore"}},
            },
        }
        try:
            status, data, raw = http_json(
                url,
                method="POST",
                headers={"x-goog-api-key": key, "Content-Type": "application/json"},
                body=body2,
                timeout=120,
            )
        except RuntimeError as e2:
            return {"ok": False, "reason": f"Gemini TTS 调用失败: {str(e2)[:180]}", "need_keys": ["GEMINI_API_KEY"], "model": model}

    ms = int((time.time() - t0) * 1000)
    # Look for inline audio data
    audio_b64 = None
    if isinstance(data, dict):
        for cand in data.get("candidates") or []:
            parts = ((cand.get("content") or {}).get("parts")) or []
            for part in parts:
                inline = part.get("inlineData") or part.get("inline_data") or {}
                if inline.get("data"):
                    audio_b64 = inline["data"]
                    break
            if audio_b64:
                break
    ok = bool(audio_b64)
    out = None
    if ok:
        out = OUT_DIR / "gemini-tts-tryrun.wav"
        # may be pcm or wav; write raw bytes
        out.write_bytes(base64.b64decode(audio_b64))
    return {
        "ok": ok,
        "model": model,
        "ms": ms,
        "bytes": len(base64.b64decode(audio_b64)) if audio_b64 else 0,
        "file": str(out.relative_to(ROOT)) if out else None,
        "reason": "通" if ok else "响应无音频 data",
    }


def probe_b04d(file_env: dict[str, str]) -> dict:
    """B-04d: image-gen key failure path — observe current behavior (no code change)."""
    base = (file_env.get("IMAGE_GEN_BASE_URL") or "https://api.siliconflow.cn/v1").rstrip("/")
    # deliberately bad key
    bad = "sk-arch2-tryrun-invalid-key"
    try:
        http_json(
            f"{base}/images/generations",
            method="POST",
            headers={"Authorization": f"Bearer {bad}"},
            body={"model": file_env.get("IMAGE_GEN_MODEL") or "Kwai-Kolors/Kolors", "prompt": "cat", "image_size": "512x512"},
            timeout=60,
        )
        return {"observed": "unexpected_success_with_bad_key", "debt": "B-04d still open"}
    except RuntimeError as e:
        msg = str(e)[:200]
        return {
            "observed": "upstream_http_error_on_bad_key",
            "error_preview": msg,
            "note": "上游会拒坏 Key；产品侧「失败回流人话/不装未实现」路径是否接好需对照 routes；本试跑仅观测上游。",
            "debt": "B-04d remains 暂缓 unless product path verified in app",
        }


def main() -> int:
    file_env = load_dotenv(ROOT / ".env")
    results = {
        "deepseek_text": run_deepseek(file_env),
        "official_vlm": run_vlm(file_env),
        "gemini_tts": run_gemini_tts(file_env),
        "b04d_probe": probe_b04d(file_env),
    }
    out = OUT_DIR / "arch2-tryrun-result.json"
    out.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(results, ensure_ascii=False, indent=2))
    print("WROTE", out.relative_to(ROOT))
    oks = [results["deepseek_text"].get("ok"), results["official_vlm"].get("ok"), results["gemini_tts"].get("ok")]
    return 0 if all(oks) else 2


if __name__ == "__main__":
    sys.exit(main())
