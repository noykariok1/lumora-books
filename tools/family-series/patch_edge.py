import sys
src=open(sys.argv[1]).read()
def rep(a,b,n=1):
    global src
    c=src.count(a); assert c==n,(c,a[:80]); src=src.replace(a,b)
# header doc
rep('//        Response also carries engine: "gpt"|"gemini".',
'''//        Response also carries engine: "gpt"|"gemini".
//   v21 (family series): render accepts person?: "father"|"mother"|"brother"|"sister"|"grandfather"|"grandmother" when image 1 is a photo of a family member
//        (draws that person's character instead of the child's), and render/swap accept cast?: [{ role, hero, heroMime? }] (up to 3) =
//        approved characters of the other family members who appear on the page.''')
# helpers after RENDER_RULES
rep('''// ---- Art direction (v7)''','''// ---- v21: family members (cast) ----
const ROLE_EN: Record<string, string> = { father: "father", mother: "mother", brother: "brother", sister: "sister", grandfather: "grandfather", grandmother: "grandmother" };
const ROLE_NOTE: Record<string, string> = {
  father: "an adult man, the child's father", mother: "an adult woman, the child's mother",
  brother: "a child, the hero's brother", sister: "a child, the hero's sister",
  grandfather: "an older man, the child's grandfather", grandmother: "an older woman, the child's grandmother",
};
const personOf = (body: Record<string, unknown>) => ROLE_EN[String(body.person || "")] || "";
function castOf(body: Record<string, unknown>) {
  return (Array.isArray(body.cast) ? body.cast : []).slice(0, 3).map((c) => c as Record<string, unknown>)
    .filter((c) => ROLE_EN[String(c.role)] && typeof c.hero === "string" && c.hero.length > 0 && String(c.hero).length <= MAX_B64)
    .map((c) => ({ role: ROLE_EN[String(c.role)], hero: String(c.hero), mime: /^image\\/(png|jpeg|webp)$/.test(String(c.heroMime)) ? String(c.heroMime) : "image/jpeg" }));
}
function castText(cast: { role: string }[], first: number, swap: boolean) {
  if (!cast.length) return "";
  const list = cast.map((c, k) => `image ${first + k} is the approved illustrated character of the hero's ${c.role} (${ROLE_NOTE[c.role]})`).join("; ");
  return `\\nFAMILY CAST: ${list}. ${swap
    ? `Wherever the ${cast.map((c) => c.role).join(" or ")} appears in the page as a PLACEHOLDER, replace that placeholder's identity (face, skin tone, hair, glasses, facial hair, build) with the matching approved character, keeping the placeholder's pose, position, size, outfit and expression. Each family member must look exactly like their approved character, the same on every page.`
    : `Whenever the scene has the ${cast.map((c) => c.role).join(" or ")}, draw them exactly like their approved character (face, skin tone, hair, glasses, facial hair, build), the same on every page.`} Keep the cast images only for identity, never for style. Do not add a family member who is not in the scene.`;
}

// ---- Art direction (v7)''')
# finalLock / stylize wording for a family member
rep("The face must still be unmistakably this real child: same face shape, eyes, nose, mouth, teeth, skin tone, freckles, hair colour, length and texture, glasses.`;",
"The face must still be unmistakably this real ${personOf(body) || \"child\"}: same face shape, eyes, nose, mouth, teeth, skin tone, freckles, hair colour, length and texture, glasses${personOf(body) ? \", facial hair, wrinkles and real age\" : \"\"}.`;")
rep("Likeness still comes first: keep this child's own face shape,","Likeness still comes first: keep this ${personOf(body) || \"child\"}'s own face shape,")
# render: who line for a family member + cast images
rep('''    const who = refIsArt ? "Image 1 is the approved illustrated character of the real child, the hero (no photo available): keep this exact face, hair, skin tone and proportions."''',
'''    const person = personOf(body);
    const who = person ? (nP === 1 ? `Image 1 is the photo of ${ROLE_NOTE[person]} (NOT the hero child). Draw this real person, keeping their real age.` : `Images 1 to ${nP} are photos of ${ROLE_NOTE[person]} (NOT the hero child). Draw this real person, keeping their real age.`)
      : refIsArt ? "Image 1 is the approved illustrated character of the real child, the hero (no photo available): keep this exact face, hair, skin tone and proportions."''')
rep('''    const notes = ART[String(body.style || "")] && ["hero", "face"].includes(String(body.slot)) && body.describe !== false && !refIsArt ? await describeChild([photo, ...extra]) : "";''',
'''    const notes = ART[String(body.style || "")] && ["hero", "face"].includes(String(body.slot)) && body.describe !== false && !refIsArt && !person ? await describeChild([photo, ...extra]) : "";
    const rCast = person ? [] : castOf(body);
    const iCast = nP + 1 + (sheet ? 1 : 0) + (prev && prev.length <= MAX_B64 ? 1 : 0);''')
rep('''      ...(prev && prev.length <= MAX_B64 ? [{ inline_data: { mime_type: mt(body.prevMime), data: prev } }] : []),
      { text: `${intro}\\n${artDirection(body)}\\n${RENDER_RULES}\\n${prompt}''',
'''      ...(prev && prev.length <= MAX_B64 ? [{ inline_data: { mime_type: mt(body.prevMime), data: prev } }] : []),
      ...rCast.map((c) => ({ inline_data: { mime_type: c.mime, data: c.hero } })),
      { text: `${intro}${castText(rCast, iCast, false)}\\n${artDirection(body)}\\n${person ? RENDER_RULES.replace(/\\bchild\\b/g, "person") : RENDER_RULES}\\n${prompt}''')
# swap: cast images after the base page
rep('''      { inline_data: { mime_type: mt(body.baseMime), data: base } },
      { text: `${who} Image ${iHero} is this child's approved illustrated character''',
'''      { inline_data: { mime_type: mt(body.baseMime), data: base } },
      ...sCast.map((c) => ({ inline_data: { mime_type: c.mime, data: c.hero } })),
      { text: `${who} Image ${iHero} is this child's approved illustrated character''')
rep('''    const nP = photos.length, iHero = nP + 1, iFace = face ? nP + 2 : 0, iBase = nP + (face ? 3 : 2);''',
'''    const nP = photos.length, iHero = nP + 1, iFace = face ? nP + 2 : 0, iBase = nP + (face ? 3 : 2);
    const sCast = castOf(body);''')
rep('''STYLE IS FIXED: render the hero in exactly the same style, lighting, materials and detail as image ${iBase}. Use the other images only for who the child is (identity), never for drawing style, outfit, size or proportions.''',
'''STYLE IS FIXED: render the hero in exactly the same style, lighting, materials and detail as image ${iBase}. Use the other images only for who the child is (identity), never for drawing style, outfit, size or proportions.${castText(sCast, iBase + 1, true)}''')
open(sys.argv[2],'w').write(src)
print("ok")
