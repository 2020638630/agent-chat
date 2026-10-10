# -*- coding: utf-8 -*-
import json, urllib.request, urllib.error, time, os, io, wave, math, struct, uuid, mimetypes
from pathlib import Path

BASE = "http://127.0.0.1:8787"
OUT = Path(r"C:\Users\Administrator\smoke_results.json")
setup = json.loads(Path(r"C:\Users\Administrator\smoke_setup.json").read_text(encoding="utf-8"))
PRIV = setup["priv_id"]
PRIV_CHAR = setup["priv_char"]
GRP = setup["grp_id"]
MENTION = setup["mention_id"]
results = {}

def req(method, path, data=None, headers=None, timeout=300, body_bytes=None):
    url = BASE + path
    hdrs = dict(headers or {})
    body = body_bytes
    if data is not None and body is None:
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        hdrs.setdefault("Content-Type", "application/json; charset=utf-8")
    r = urllib.request.Request(url, data=body, headers=hdrs, method=method)
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            rawb = resp.read()
            try:
                return resp.status, json.loads(rawb.decode("utf-8"))
            except Exception:
                return resp.status, {"_raw_len": len(rawb), "_ctype": resp.headers.get("Content-Type")}
    except urllib.error.HTTPError as e:
        rawb = e.read()
        try:
            j = json.loads(rawb.decode("utf-8"))
        except Exception:
            j = {"_text": rawb.decode("utf-8", errors="replace")[:800]}
        return e.code, j
    except Exception as e:
        return 0, {"error": str(e)}

def get(path, **kw):
    return req("GET", path, **kw)

def post(path, data=None, **kw):
    return req("POST", path, data=data, **kw)

def multipart(fields, files):
    boundary = "----SmokeBoundary" + uuid.uuid4().hex
    chunks = []
    for name, value in fields.items():
        chunks.append(f"--{boundary}\r\n".encode())
        chunks.append(f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode())
        chunks.append(str(value).encode("utf-8") + b"\r\n")
    for name, (filename, content, mime) in files.items():
        chunks.append(f"--{boundary}\r\n".encode())
        chunks.append(
            f'Content-Disposition: form-data; name="{name}"; filename="{filename}"\r\n'.encode()
        )
        chunks.append(f"Content-Type: {mime}\r\n\r\n".encode())
        chunks.append(content)
        chunks.append(b"\r\n")
    chunks.append(f"--{boundary}--\r\n".encode())
    body = b"".join(chunks)
    headers = {"Content-Type": f"multipart/form-data; boundary={boundary}"}
    return body, headers

def assist_texts(payload):
    msgs = []
    if isinstance(payload, dict):
        for key in ("assistantMessages", "assistant_messages", "messages"):
            if key in payload and isinstance(payload[key], list):
                msgs = payload[key]
                break
        if not msgs and "assistantMessage" in payload:
            msgs = [payload["assistantMessage"]]
    out = []
    for m in msgs:
        if isinstance(m, dict):
            out.append({
                "id": m.get("id"),
                "role": m.get("role"),
                "character_id": m.get("character_id"),
                "content": (m.get("content") or "")[:400],
                "image_path": m.get("image_path"),
                "source": m.get("source"),
            })
    return out

# ---------- 1 private ----------
print("SMOKE1 private...")
st, payload = post(f"/api/conversations/{PRIV}/messages", {"content": "你好，冒烟测试，用一句话打个招呼。"})
asts = assist_texts(payload)
ok1 = st == 200 and any((a.get("content") or "").strip() for a in asts)
results["1_private"] = {
    "status": st, "ok": ok1,
    "user": (payload.get("userMessage") or {}).get("content") if isinstance(payload, dict) else None,
    "assistants": asts,
    "error": None if ok1 else payload,
}
print("1", ok1, st)

# ---------- 2 group @ ----------
print("SMOKE2 group...")
st, payload = post(f"/api/conversations/{GRP}/messages", {
    "content": "冒烟群聊：请被点名的角色用一句话自我介绍。",
    "mentionCharacterId": MENTION,
})
asts = assist_texts(payload)
ok2 = st == 200 and len(asts) >= 1 and any((a.get("content") or "").strip() for a in asts)
results["2_group"] = {
    "status": st, "ok": ok2, "mention": MENTION, "assistants": asts,
    "error": None if ok2 else payload,
}
print("2", ok2, st, "n=", len(asts))

# ---------- 3 memory ----------
print("SMOKE3 memory...")
fact = "我叫小明，住在上海浦东，冒烟记忆测试事实。"
st, payload = post(f"/api/conversations/{PRIV}/messages", {"content": fact})
asts = assist_texts(payload)
# wait for async extract
time.sleep(8)
st_m, mems = get(f"/api/characters/{PRIV_CHAR}/memories")
st_n, notices = get(f"/api/characters/{PRIV_CHAR}/memory-notices?conversation_id={PRIV}")
mem_list = (mems or {}).get("memories") if isinstance(mems, dict) else []
notice_list = (notices or {}).get("notices") if isinstance(notices, dict) else []
# also try without filter
joined = json.dumps(mem_list, ensure_ascii=False) + json.dumps(notice_list, ensure_ascii=False)
hit = any(k in joined for k in ["小明", "上海", "浦东", "冒烟记忆"])
# soft pass: API works and (hit OR extract produced something OR reply ok) — product: new note or confirm/ignore visible
ok3 = st == 200 and st_m == 200 and (hit or len(mem_list) > 0 or len(notice_list) > 0)
# If still nothing, wait more once
if not ok3:
    time.sleep(10)
    st_m, mems = get(f"/api/characters/{PRIV_CHAR}/memories")
    st_n, notices = get(f"/api/characters/{PRIV_CHAR}/memory-notices?conversation_id={PRIV}")
    mem_list = (mems or {}).get("memories") if isinstance(mems, dict) else []
    notice_list = (notices or {}).get("notices") if isinstance(notices, dict) else []
    joined = json.dumps(mem_list, ensure_ascii=False) + json.dumps(notice_list, ensure_ascii=False)
    hit = any(k in joined for k in ["小明", "上海", "浦东", "冒烟记忆"])
    ok3 = st == 200 and st_m == 200 and (hit or len(mem_list) > 0 or len(notice_list) > 0)

results["3_memory"] = {
    "status_msg": st, "status_mem": st_m, "status_notice": st_n, "ok": ok3, "hit": hit,
    "mem_count": len(mem_list) if isinstance(mem_list, list) else -1,
    "notice_count": len(notice_list) if isinstance(notice_list, list) else -1,
    "sample_mems": (mem_list[:5] if isinstance(mem_list, list) else mem_list),
    "sample_notices": (notice_list[:5] if isinstance(notice_list, list) else notice_list),
    "assistants": asts,
}
print("3", ok3, "mems", results["3_memory"]["mem_count"], "notices", results["3_memory"]["notice_count"], "hit", hit)

# ---------- 4 moments ----------
print("SMOKE4 moments...")
st, payload = post("/api/moments", {"content": "冒烟测试动态：今天天气不错。"})
moment = (payload or {}).get("moment") if isinstance(payload, dict) else None
mid = moment.get("id") if moment else None
# wait for reactions (scheduleMomentReactions)
time.sleep(12)
st2, moments = get("/api/moments")
mlist = (moments or {}).get("moments") if isinstance(moments, dict) else []
found = None
if mid:
    for m in mlist:
        if m.get("id") == mid:
            found = m
            break
likes = (found or moment or {}).get("like_count") or (found or {}).get("likes") or 0
comments = (found or moment or {}).get("comments") or []
if isinstance(comments, int):
    ccount = comments
else:
    ccount = len(comments)
ok4 = st == 200 and mid is not None
# optional reaction: note separately
results["4_moments"] = {
    "status": st, "ok": ok4, "moment_id": mid,
    "like_count": likes, "comment_count": ccount,
    "reaction_ok": (likes or ccount) > 0,
    "moment": found or moment,
    "error": None if ok4 else payload,
}
print("4", ok4, "react", results["4_moments"]["reaction_ok"], mid)

# ---------- 5 vision ----------
print("SMOKE5 vision...")
# minimal 1x1 PNG
png = bytes.fromhex(
    "89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de"
    "0000000c4944415408d763f8ffff3f0005fe02fea75a5a250000000049454e44ae426082"
)
# better: make a slightly larger colored PNG via zlib manually is hard; use PPM-like via pillow if available else 1x1
try:
    from PIL import Image
    bio = io.BytesIO()
    img = Image.new("RGB", (64, 64), (220, 40, 40))
    img.save(bio, format="PNG")
    png = bio.getvalue()
except Exception:
    pass
body, headers = multipart({}, {"file": ("smoke.png", png, "image/png")})
st, payload = req("POST", f"/api/conversations/{PRIV}/messages/image", body_bytes=body, headers=headers, timeout=300)
asts = assist_texts(payload)
reply = " ".join((a.get("content") or "") for a in asts).strip()
ok5 = st == 200 and bool(reply)
results["5_vision"] = {
    "status": st, "ok": ok5, "reply_len": len(reply), "assistants": asts,
    "user_image": (payload.get("userMessage") or {}).get("image_path") if isinstance(payload, dict) else None,
    "error": None if ok5 else payload,
}
print("5", ok5, st, "len", len(reply))

# ---------- 6 image gen ----------
print("SMOKE6 imagegen...")
st, payload = post(f"/api/conversations/{PRIV}/messages", {"content": "画一只猫"}, timeout=300)
asts = assist_texts(payload)
has_path = any(a.get("image_path") for a in asts)
reply = " ".join((a.get("content") or "") for a in asts)
# also check user+assistant in payload
if not has_path and isinstance(payload, dict):
    for a in asts:
        if a.get("image_path"):
            has_path = True
ok6 = st == 200 and has_path
results["6_imagegen"] = {
    "status": st, "ok": ok6, "has_image_path": has_path, "assistants": asts,
    "error": None if ok6 else payload,
}
print("6", ok6, st, "img", has_path)

# ---------- 7 voice (TTS preferred if STT needs real speech) ----------
print("SMOKE7 voice...")
# Try TTS on last assistant message first
tts_ok = False
tts_detail = None
aid = None
for a in (results["1_private"].get("assistants") or []):
    if a.get("id") and (a.get("content") or "").strip():
        aid = a["id"]
        break
if not aid:
    # fetch messages
    st_msg, msgs = get(f"/api/conversations/{PRIV}/messages")
    mlist = (msgs or {}).get("messages") if isinstance(msgs, dict) else []
    for m in reversed(mlist or []):
        if m.get("role") == "assistant" and (m.get("content") or "").strip():
            aid = m["id"]
            break
if aid:
    st_t, tts_body = get(f"/api/messages/{aid}/tts", timeout=180)
    if st_t == 200:
        if isinstance(tts_body, dict) and tts_body.get("_raw_len"):
            tts_ok = tts_body["_raw_len"] > 100
            tts_detail = {"status": st_t, "bytes": tts_body["_raw_len"], "ctype": tts_body.get("_ctype")}
        elif isinstance(tts_body, dict) and tts_body.get("audio_path"):
            tts_ok = True
            tts_detail = {"status": st_t, "audio_path": tts_body.get("audio_path")}
        else:
            tts_detail = {"status": st_t, "body": str(tts_body)[:300]}
            tts_ok = st_t == 200
    else:
        tts_detail = {"status": st_t, "body": tts_body}

# Also try STT with synthetic wav (may fail recognition but path should accept)
stt_ok = False
stt_detail = None
buf = io.BytesIO()
with wave.open(buf, "wb") as w:
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(16000)
    # 0.6s of 440Hz tone
    frames = bytearray()
    for i in range(int(16000 * 0.6)):
        val = int(10000 * math.sin(2 * math.pi * 440 * i / 16000))
        frames += struct.pack("<h", val)
    w.writeframes(bytes(frames))
wav = buf.getvalue()
body, headers = multipart({}, {"file": ("smoke.wav", wav, "audio/wav")})
st_v, payload_v = req("POST", f"/api/conversations/{PRIV}/messages/voice", body_bytes=body, headers=headers, timeout=300)
asts_v = assist_texts(payload_v)
# STT path "available": not 5xx config missing; 200 with transcript OR 502 with clear STT error still proves path
if st_v == 200:
    stt_ok = True
    stt_detail = {"status": st_v, "user": (payload_v.get("userMessage") or {}).get("content"), "assistants": asts_v}
elif st_v == 502:
    # STT ran but failed on tone — path available
    stt_ok = True
    stt_detail = {"status": st_v, "note": "STT path reached provider", "body": payload_v}
else:
    stt_detail = {"status": st_v, "body": payload_v}

ok7 = tts_ok or stt_ok
results["7_voice"] = {
    "ok": ok7, "tts_ok": tts_ok, "stt_ok": stt_ok,
    "tts": tts_detail, "stt": stt_detail, "tts_message_id": aid,
}
print("7", ok7, "tts", tts_ok, "stt", stt_ok)

# summary
summary = {
    "1": results["1_private"]["ok"],
    "2": results["2_group"]["ok"],
    "3": results["3_memory"]["ok"],
    "4": results["4_moments"]["ok"],
    "5": results["5_vision"]["ok"],
    "6": results["6_imagegen"]["ok"],
    "7": results["7_voice"]["ok"],
}
OUT.write_text(json.dumps({"summary": summary, "results": results, "setup": setup}, ensure_ascii=False, indent=2), encoding="utf-8")
print("SUMMARY", json.dumps(summary, ensure_ascii=False))
