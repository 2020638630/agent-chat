import json, urllib.request, urllib.error, time, os, io, struct, wave, math

BASE = "http://127.0.0.1:8787"
OUT = r"C:\Users\Administrator\smoke_results.json"
results = {}

def req(method, path, data=None, headers=None, timeout=180, raw=False):
    url = BASE + path
    body = None
    hdrs = dict(headers or {})
    if data is not None and not raw:
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        hdrs.setdefault("Content-Type", "application/json; charset=utf-8")
    elif raw:
        body = data
    r = urllib.request.Request(url, data=body, headers=hdrs, method=method)
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            rawb = resp.read()
            ctype = resp.headers.get("Content-Type", "")
            if "json" in ctype or rawb[:1] in (b"{", b"["):
                try:
                    return resp.status, json.loads(rawb.decode("utf-8"))
                except Exception:
                    return resp.status, rawb[:200]
            return resp.status, rawb
    except urllib.error.HTTPError as e:
        rawb = e.read()
        try:
            j = json.loads(rawb.decode("utf-8"))
        except Exception:
            j = rawb.decode("utf-8", errors="replace")[:500]
        return e.code, j
    except Exception as e:
        return 0, {"error": str(e)}

def get(path, **kw):
    return req("GET", path, **kw)

def post(path, data=None, **kw):
    return req("POST", path, data=data, **kw)

# Load chars
st, chars_wrap = get("/api/characters")
chars = chars_wrap["characters"]
# Prefer known names if readable; else take first two
char_ids = [c["id"] for c in chars]
char_names = {c["id"]: c["name"] for c in chars}
c1, c2 = char_ids[0], char_ids[1]
# Prefer 陆晚 if present in previous tests - use 788ad7c9 from earlier list (last one was 糯米?)
# Use first for private; first two for group
# From earlier: 788ad7c9 had private conv 25a468a0

st, convs_wrap = get("/api/conversations")
convs = convs_wrap["conversations"]
private = [c for c in convs if c.get("type") == "private"]
group = [c for c in convs if c.get("type") == "group"]

# Ensure private with c1
if private:
    priv = private[0]
    priv_id = priv["id"]
    priv_char = (priv.get("members") or [{}])[0].get("id") or c1
else:
    st, created = post("/api/conversations", {"characterIds": [c1], "type": "private"})
    priv = created.get("conversation") or created
    priv_id = priv["id"]
    priv_char = c1

# Ensure group with two chars
if group:
    grp = group[0]
    grp_id = grp["id"]
    grp_members = [m["id"] for m in (grp.get("members") or [])]
    mention_id = grp_members[0] if grp_members else c1
else:
    # pick two distinct
    ids2 = [c1, c2]
    st, created = post("/api/conversations", {"characterIds": ids2, "type": "group", "title": "smoke-group"})
    grp = created.get("conversation") or created
    grp_id = grp["id"]
    mention_id = c1

with open(OUT.replace("results","setup"), "w", encoding="utf-8") as f:
    json.dump({
        "priv_id": priv_id, "priv_char": priv_char, "priv_name": char_names.get(priv_char),
        "grp_id": grp_id, "mention_id": mention_id, "mention_name": char_names.get(mention_id),
        "chars": [{"id":c["id"],"name":c["name"]} for c in chars],
    }, f, ensure_ascii=False, indent=2)
print("SETUP_OK", priv_id, grp_id)
