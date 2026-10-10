# -*- coding: utf-8 -*-
import json, urllib.request, urllib.error, time
from pathlib import Path

BASE = "http://127.0.0.1:8787"
setup = json.loads(Path(r"C:\Users\Administrator\smoke_setup.json").read_text(encoding="utf-8"))
PRIV = setup["priv_id"]
MID = "dbe4b21c-74be-4fb8-be73-0f1dfdea5ccf"
prev = json.loads(Path(r"C:\Users\Administrator\smoke_results.json").read_text(encoding="utf-8"))

def req(method, path, data=None, timeout=300):
    url = BASE + path
    body = None
    hdrs = {}
    if data is not None:
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        hdrs["Content-Type"] = "application/json; charset=utf-8"
    r = urllib.request.Request(url, data=body, headers=hdrs, method=method)
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            j = json.loads(raw.decode("utf-8"))
        except Exception:
            j = raw.decode("utf-8", errors="replace")[:800]
        return e.code, j
    except Exception as e:
        return 0, {"error": str(e)}

# Wait remaining time for moment reactions (scheduled 45s; ~already waited 12s earlier + elapsed)
print("waiting for moment reactions...")
time.sleep(40)
st, moments = req("GET", "/api/moments")
found = None
for m in (moments.get("moments") or []):
    if m.get("id") == MID:
        found = m
        break
likes = (found or {}).get("like_count") or 0
comments = (found or {}).get("comments") or []
ccount = len(comments) if isinstance(comments, list) else int(comments or 0)
print("moment react likes", likes, "comments", ccount)
prev["results"]["4_moments"]["like_count"] = likes
prev["results"]["4_moments"]["comment_count"] = ccount
prev["results"]["4_moments"]["reaction_ok"] = (likes or ccount) > 0
prev["results"]["4_moments"]["moment_after_wait"] = found

# Retry image gen with matching phrase
print("retry image gen...")
for phrase in ["帮我画一只猫", "画一张猫"]:
    st, payload = req("POST", f"/api/conversations/{PRIV}/messages", {"content": phrase}, timeout=300)
    asts = payload.get("assistantMessages") or []
    has_path = any(a.get("image_path") for a in asts)
    print("phrase", phrase, "status", st, "img", has_path)
    for a in asts:
        print("  content", (a.get("content") or "")[:120], "image_path", a.get("image_path"))
    if has_path:
        prev["results"]["6_imagegen"] = {
            "status": st, "ok": True, "has_image_path": True,
            "phrase": phrase,
            "assistants": [{
                "id": a.get("id"), "content": (a.get("content") or "")[:400],
                "image_path": a.get("image_path"), "source": a.get("source"),
            } for a in asts],
        }
        prev["summary"]["6"] = True
        break
    else:
        prev["results"]["6_imagegen"] = {
            "status": st, "ok": False, "has_image_path": False,
            "phrase": phrase,
            "assistants": [{
                "id": a.get("id"), "content": (a.get("content") or "")[:400],
                "image_path": a.get("image_path"), "source": a.get("source"),
            } for a in asts],
            "error": payload,
        }

# Check vision reply content precisely
v = prev["results"]["5_vision"]
print("vision reply:", (v.get("assistants") or [{}])[0].get("content"))
print("vision user_image:", v.get("user_image"))

Path(r"C:\Users\Administrator\smoke_results.json").write_text(
    json.dumps(prev, ensure_ascii=False, indent=2), encoding="utf-8"
)
print("SUMMARY", json.dumps(prev["summary"], ensure_ascii=False))
