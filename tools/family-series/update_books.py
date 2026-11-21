# Replace books inside index.html's PB_FAM with their current version from family.json, and optionally enable them (art ready).
#   python3 -I update_books.py <index.html> <family.json> fam_grand_daughter [fam_grand_son ...] [--enable]
# --enable: textOnly=false and add the ids to PB_V2 (base art must already be at covers/base/v2/<id>/).
import sys, json, re
P, FJ, *rest = sys.argv[1:]
enable = "--enable" in rest; ids = [x for x in rest if not x.startswith("--")]
src = open(P).read()
m = re.search(r"\nconst PB_FAM=(\{.*?\});\n", src)
assert m, "PB_FAM not found"
cur = json.loads(m.group(1).replace("<\\/", "</"))
new = {b["id"]: b for b in json.load(open(FJ))["books"]}
for i, b in enumerate(cur["books"]):
    if b["id"] in ids:
        nb = dict(new[b["id"]])
        if enable: nb["textOnly"] = False
        cur["books"][i] = nb
js = json.dumps(cur, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")
src = src[:m.start()] + "\nconst PB_FAM=" + js + ";\n" + src[m.end():]
if enable:
    a = 'const PB_V2=new Set(['
    assert src.count(a) == 1
    add = "".join(f'"{i}",' for i in ids if f'"{i}"' not in src[src.index(a):src.index(a)+400])
    src = src.replace(a, a + add)
open(P, "w").write(src); print("updated", ids, "enabled" if enable else "")
