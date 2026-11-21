import json, re, sys
D = sys.argv[1] if len(sys.argv) > 1 else "."
exec(open(D + "/series_texts.py").read())
PDF = json.load(open(D + "/pdfbooks3.json"))

SERIES = [
    ("kid", "לילד או לילדה"),
    ("dad_son", "אבא ובן"), ("mom_son", "אמא ובן"), ("dad_daughter", "אבא ובת"), ("mom_daughter", "אמא ובת"),
    ("bro_bro", "אח ואח"), ("bro_sis", "אח ואחות"), ("sis_sis", "אחות ואחות"),
    ("grand_son", "סבא, סבתא ונכד"), ("grand_daughter", "סבא, סבתא ונכדה"),
]
DAD = {"id": "dad", "label": "אבא", "role": "father"}
MOM = {"id": "mom", "label": "אמא", "role": "mother"}
SIB = lambda g: {"id": "sib", "label": "האח" if g == "m" else "האחות", "role": "brother" if g == "m" else "sister", "nameKey": "sibName", "gender": g}
GP = {"id": "grandpa", "label": "סבא", "role": "grandfather", "nameKey": "grandpaName", "def": "סבא", "ask": "איך הילד קורא לו?"}
GM = {"id": "grandma", "label": "סבתא", "role": "grandmother", "nameKey": "grandmaName", "def": "סבתא", "ask": "איך הילד קורא לה?"}
CAST = {
    "dad_son": ("m", [DAD]), "mom_son": ("m", [MOM]), "dad_daughter": ("f", [DAD]), "mom_daughter": ("f", [MOM]),
    "bro_bro": ("m", [SIB("m")]), "bro_sis": ("m", [SIB("f")]), "sis_sis": ("f", [SIB("f")]),
    "grand_son": ("m", [GP, GM]), "grand_daughter": ("f", [GP, GM]),
}
SAMPLE_SIB = {"bro_bro": "עומר", "bro_sis": "מאיה", "sis_sis": "שירה"}

def hero_rule(g):
    w = "הגיבור" if g == "m" else "הגיבורה"
    return w + " {{childName}}: תווי הפנים, צבע העור, צבע העיניים, השיער והתספורת לפי התמונה, זהים בכל העמודים. לבוש יומיומי נוח וצבעוני, זהה בכל העמודים, בלי כיתוב או לוגו."

def mk(id, series, g, title, genre, pages, cast=None, textOnly=True, extra=None):
    b = {
        "id": id, "series": series, "audience": "בנים" if g == "m" else "בנות", "titleTemplate": title,
        "ageRange": "3–8", "genre": genre, "pageCount": 12, "textOnly": textOnly,
        "illustrationStyle": "cinema3d (house style)", "heroAppearanceRule": hero_rule(g),
        "characters": [{"id": "hero", "nameTemplate": "{{childName}}", "appearance": "לפי התמונה"}],
        "recurringProps": [], "coverPromptTemplate": "",
        "pages": [{"pageNumber": i + 1, "textTemplate": t, "illustrationPromptTemplate": ""} for i, t in enumerate(pages)],
    }
    if cast:
        b["cast"] = cast
    if series in SAMPLE_SIB:
        b["castDefaults"] = {"sibName": SAMPLE_SIB[series]}
    if extra:
        b.update(extra)
    return b

books = []
# single-child books from noy's file (masculine hero, noy's own titles)
KID_IDS = {"כדורסל": "kid_basketball", "פיראטים": "kid_pirates", "פוליטיקאים": "kid_council", "איש עסקים": "kid_business", "חקלאי": "kid_farmer"}
KID_GENRE = {"כדורסל": "ספורט / חברות", "פיראטים": "הרפתקה / ים / תעלומה", "פוליטיקאים": "קהילה / הקשבה / בחירות", "איש עסקים": "יזמות / יצירתיות", "חקלאי": "טבע / חקר / סבלנות"}
for pb in PDF:
    if pb["topic"] in KID_IDS:
        pages = [p.replace("נועם", "{{childName}}") for p in pb["pages"]]
        books.append(mk(KID_IDS[pb["topic"]], "kid", "m", pb["title"], KID_GENRE[pb["topic"]], pages))

for k in ["dad_son", "mom_son", "dad_daughter", "mom_daughter", "bro_bro", "bro_sis", "sis_sis"]:
    s = S[k]; g, cast = CAST[k]
    books.append(mk("fam_" + k, k, g, s["title"], s["genre"], s["pages"], cast))

# grandparents + grandson: noy's "התזמורת שבארון" (the one illustrated family book)
orch = [p for p in PDF if p["title"] == "התזמורת שבארון"][0]
def gfix(t):
    t = t.replace("נועם", "{{childName}}").replace("סבא יוסי וסבתא רותי", "סבא וסבתא")
    return t.replace("סבא יוסי", "{{grandpaName}}").replace("סבתא רותי", "{{grandmaName}}")
opages = [gfix(p) for p in orch["pages"]]
ORCH_SCENES = [
    "מטבח ביתי חמים בבוקר שבת: הגיבור עומד ליד השולחן ומוחא כפיים פעמיים בשמחה; הסבא שורק ליד הכיריים עם מחבת פנקייק; הסבתא מקישה בכפית על קערת סלט זכוכית; ערמת פנקייקים על צלחת; אור בוקר מהחלון.",
    "אותו מטבח: הגיבור שולף ממגירה פתוחה כף עץ עם כתם רוטב ומרים אותה כמו שרביט של מנצח, בהבעה נלהבת; הסבתא מחזיקה קערה, הסבא מחייך; על המקרר תלויה הזמנה צבעונית (בלי כיתוב קריא).",
    "שולחן המטבח: הסבא מתופף על השולחן, הסבתא מקישה בכפית על כוס, הגיבור מוחא כפיים בעיניים עצומות; רגע מצחיק: הסבא מוחא בטעות על הברך של הסבתא והיא צוחקת.",
    "גינה ציבורית ירוקה עם מזרקה: שלושתם יושבים על מחצלת ומנגנים; ספסלים עם כמה אנשים ברקע; בספסל האחרון ילדה קטנה מנופפת אליהם; עלים זזים ברוח.",
    "בגינה: הסבא יושב על ארגז עץ ריק; הגיבור כורע ומצמיד לחי לדופן הארגז ומקשיב בהפתעה; הסבתא מסתכלת בסקרנות.",
    "בגינה: הסבתא מרימה כפית מעל כוס זכוכית ומחכה, ריכוז שקט; העלים נחים; ברקע הילדה מהספסל האחרון מרימה אצבע בהתלהבות.",
    "הגיבור רץ על השביל אל הספסל האחרון ומושיט יד אל הילדה הקטנה, שואל אותה בחיוך; הסבא והסבתא על המחצלת ברקע.",
    "רגע של שיא: הגיבור עומד מול המחצלת ומרים את כף העץ כמנצח; הסבא מתופף על הארגז, הסבתא מקישה בכוס, הילדה ואבא שלה מוחאים כפיים מהספסל; תווים מדומיינים קטנים באוויר.",
    "כף העץ נופלת מיד הגיבור אל הקרקע, כולם קופאים לרגע; הגיבור מרים אותה ומקיש בה על הארגז ומקשיב; הסבא קורץ אליו.",
    "סיבוב אחרון: הגיבור מרים שתי ידיים באוויר, כל הגינה מנגנת ומוחאת כפיים איתם; הסבא מתופף, הסבתא מקישה; אור אחר הצהריים זהוב.",
    "מקפלים את המחצלת: הגיבור מצייר ארגז על דף, הסבתא מציירת כוס, הסבא מקיף בעיפרון את כף היד הקטנה של הילדה שמונחת על הדף; כולם רכונים יחד.",
    "שולחן ארוחת שישי בבית: קערת סלט מלאה, הגיבור מניח כף הגשה ומוחא שתי מחיאות; הסבא והסבתא מחליפים מבט מחויך ועונים במחיאות; אווירה חמה וביתית.",
]
for p, sc in zip([], []):
    pass
gs = mk("fam_grand_son", "grand_son", "m", orch["title"], "מוזיקה / משפחה / סבא, סבתא ונכד", opages, CAST["grand_son"][1], textOnly=True, extra={
    "titleOriginal": orch["title"],
    "characters": [
        {"id": "hero", "nameTemplate": "{{childName}}", "appearance": "לפי התמונה"},
        {"id": "grandpa", "nameTemplate": "{{grandpaName}}", "appearance": "סבא חם ומחייך, לפי התמונה של הסבא"},
        {"id": "grandma", "nameTemplate": "{{grandmaName}}", "appearance": "סבתא חמה ומחייכת, לפי התמונה של הסבתא"},
        {"id": "girl", "nameTemplate": "הילדה מהספסל האחרון", "appearance": "ילדה כבת 4, שיער חום אסוף בשתי קוקיות, שמלה צהובה"},
        {"id": "girl_dad", "nameTemplate": "אבא של הילדה", "appearance": "גבר כבן 35 בחולצה כחולה"},
    ],
    "recurringProps": ["כף עץ עם כתם רוטב", "ארגז עץ ריק", "כוס זכוכית וכפית", "קערת סלט זכוכית", "מחצלת פסים"],
    "coverPromptTemplate": "הגיבור במרכז מרים כף עץ כמו מנצח, משני צדדיו הסבא מתופף על ארגז עץ והסבתא מקישה בכפית על כוס, בגינה ירוקה עם מזרקה, אור זהוב; החלק העליון רגוע לכותרת.",
})
for pg, sc in zip(gs["pages"], ORCH_SCENES):
    pg["illustrationPromptTemplate"] = sc
books.append(gs)

s = S["grand_daughter"]
books.append(mk("fam_grand_daughter", "grand_daughter", "f", s["title"], s["genre"], s["pages"], CAST["grand_daughter"][1]))

for b in books:
    for p in b["pages"] + [{"textTemplate": b["titleTemplate"]}]:
        assert not re.search(r"[ולבמשכה]\{\{", p["textTemplate"]), (b["id"], p["textTemplate"])
    assert len(b["pages"]) == 12
out = {"series": [{"id": i, "label": l} for i, l in SERIES], "books": books}
json.dump(out, open(D + "/family.json", "w"), ensure_ascii=False, indent=1)
print(len(books), [b["id"] for b in books])
