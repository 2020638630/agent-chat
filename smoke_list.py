import json, urllib.request, urllib.error

def get(url):
    with urllib.request.urlopen(url, timeout=15) as r:
        return json.loads(r.read().decode("utf-8"))

def dump(path, obj):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)

chars = get("http://127.0.0.1:8787/api/characters")["characters"]
convs = get("http://127.0.0.1:8787/api/conversations")
dump(r"C:\Users\Administrator\smoke_state.json", {"characters": chars, "conversations": convs})
print("CHARS", len(chars))
for c in chars:
    print(c["id"], "|", c["name"])
print("---CONVS---")
items = convs.get("conversations", convs if isinstance(convs, list) else [])
print("keys", list(convs.keys()) if isinstance(convs, dict) else type(convs))
for c in items[:20]:
    print(json.dumps(c, ensure_ascii=False)[:300])
