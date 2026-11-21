#!/usr/bin/env python3
"""Base art for the family book fam_grand_son ("התזמורת שבארון"), cinema3d house style, GPT Image 2 via generate-character.
Placeholder people only (never a customer photo): a generic boy (soccer_hero v2 hero as face ref) + a described grandfather and grandmother.
On the site the swap step replaces the boy with the customer's child and the grandparents with their approved characters (edge v21 `cast`).

  python3 -I gen_orchestra_art.py <hosted index.html> <family.json> <out_dir>            # draws hero, sheet, cover, p1..p12 (15 images, ~$2.5)
  python3 -I gen_orchestra_art.py <hosted index.html> <family.json> <out_dir> --only p3  # redraw one slot
  python3 -I gen_orchestra_art.py <hosted index.html> <family.json> <out_dir> --upload   # upload out_dir/*.jpg to covers/base/v2/fam_grand_son/
Needs network access to the Supabase project. Upload uses the anon key, so it only works while the temp policy base_tmp_upload exists.
"""
import base64, json, re, sys, os, urllib.request, concurrent.futures as cf

idx, fj, out = sys.argv[1], sys.argv[2], sys.argv[3]
args = sys.argv[4:]
os.makedirs(out, exist_ok=True)
html = open(idx).read()
m = re.search(r'const AI=\{endpoint:"([^"]+)",anonKey:"([^"]+)"\}', html)
EP, KEY = m.group(1), m.group(2)
SUPA = EP.split("/functions/")[0]
B = [b for b in json.load(open(fj))["books"] if b["id"] == "fam_grand_son"][0]
BOOK = "fam_grand_son"

GRANDPA = "the grandfather (placeholder): a friendly man about 68, short grey hair, clean-shaven, simple round glasses, warm smile; beige knitted cardigan over a light blue shirt, dark trousers"
GRANDMA = "the grandmother (placeholder): a warm woman about 65, chin-length silver-grey hair, no glasses, kind smile; soft green blouse, long navy skirt, small pearl earrings"
GIRL = "a little girl about 4 from the last bench: brown hair in two puffy pigtails, yellow dress"
GIRL_DAD = "the little girl's father: a man about 35, short dark hair, blue t-shirt"
HERO = "the hero: a boy about 6 (face from image 1), casual colourful clothes: red t-shirt, blue shorts, white sneakers, the same on every page"
PRESENT = {4: [GIRL], 6: [GIRL], 7: [GIRL], 8: [GIRL, GIRL_DAD], 11: [GIRL]}

def post(body):
    req = urllib.request.Request(EP, data=json.dumps(body).encode(), headers={"Content-Type": "application/json", "apikey": KEY, "Authorization": "Bearer " + KEY})
    for t in range(4):
        try:
            with urllib.request.urlopen(req, timeout=300) as r:
                d = json.loads(r.read())
            if d.get("image"):
                return base64.b64decode(d["image"])
            raise RuntimeError(str(d)[:300])
        except Exception as e:
            print("retry", t, e)
    raise RuntimeError("failed")

def get(url):
    with urllib.request.urlopen(url, timeout=60) as r:
        return r.read()

def b64f(p):
    return base64.b64encode(open(p, "rb").read()).decode()

def prompt(slot):
    if slot == "hero":
        return f"Draw ONE character only: the hero of this book, a generic friendly boy aged 6, based on the reference image's face. Full body, no other characters, no props, no text.\nFixed outfit and look: {HERO}"
    if slot == "sheet":
        return f"Character reference sheet. The hero exactly as in the hero reference image ({HERO}). Other characters, each drawn exactly as described: {GRANDPA}; {GRANDMA}; {GIRL}; {GIRL_DAD}. Key props along the bottom: a wooden spoon with a small sauce stain, an empty wooden crate, a drinking glass with a teaspoon, a glass salad bowl, a striped picnic mat. No text, names, labels or numbers."
    if slot == "cover":
        return f"Book cover scene: {B['coverPromptTemplate']}\nCharacters: {HERO}; {GRANDPA}; {GRANDMA}. Same designs as the reference sheet."
    n = int(slot[1:]); p = B["pages"][n - 1]
    who = "; ".join([HERO, GRANDPA, GRANDMA] + PRESENT.get(n, []))
    return (f"Page {n} of 12. The story text on this page (Hebrew, for mood only, never draw it): \"{p['textTemplate']}\"\n"
            f"Scene (Hebrew): {p['illustrationPromptTemplate']}\nCharacters in this picture: {who}\n"
            "Only these characters; same designs, outfits and colours as the reference sheet. The grandfather and grandmother are always clearly visible with their faces lit (they will be personalised later).")

def draw(slot, ref_face, sheet):
    body = {"mode": "render", "engine": "gpt", "quality": "high", "style": "cinema3d", "book": BOOK, "gender": "m",
            "slot": "page" if slot.startswith("p") else slot, "aspect": "16:9" if slot == "sheet" else "4:5",
            "photo": ref_face, "prompt": prompt(slot), "describe": False}
    if sheet:
        body["sheet"] = sheet; body["sheetMime"] = "image/jpeg"
    img = post(body)
    open(f"{out}/{slot}.jpg", "wb").write(img)
    print("done", slot)

if "--upload" in args:
    for f in sorted(os.listdir(out)):
        if not f.endswith(".jpg"): continue
        req = urllib.request.Request(f"{SUPA}/storage/v1/object/covers/base/v2/{BOOK}/{f}", data=open(f"{out}/{f}", "rb").read(), method="POST",
                                     headers={"apikey": KEY, "Authorization": "Bearer " + KEY, "Content-Type": "image/jpeg", "cache-control": "3600"})
        try:
            urllib.request.urlopen(req, timeout=60); print("uploaded", f)
        except Exception as e:
            print("upload failed", f, getattr(e, "read", lambda: b"")()[:200])
    sys.exit()

only = args[args.index("--only") + 1] if "--only" in args else None
face = base64.b64encode(get(f"{SUPA}/storage/v1/object/public/covers/base/v2/soccer_hero/hero.jpg")).decode()
if not only or only == "hero":
    draw("hero", face, None)
hero = b64f(f"{out}/hero.jpg")
if not only or only == "sheet":
    draw("sheet", hero, hero)
sheet = b64f(f"{out}/sheet.jpg")
slots = ["cover"] + [f"p{i}" for i in range(1, 13)]
if only and only not in ("hero", "sheet"):
    slots = [only]
if not only or only not in ("hero", "sheet"):
    with cf.ThreadPoolExecutor(5) as ex:
        list(ex.map(lambda s: draw(s, hero, sheet), slots))
