# Family series + combined catalog for index.html (agadibook). Usage: python3 -I patch_site.py <index.html> <family.json>
import sys, json
P, FJ = sys.argv[1], sys.argv[2]
src = open(P).read()
fam = json.load(open(FJ))

def rep(a, b, n=1):
    global src
    c = src.count(a)
    assert c == n, (c, a[:90])
    src = src.replace(a, b)

FAM_JSON = json.dumps(fam, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")

# ---------- CSS ----------
rep(".pb-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:18px}",
".pb-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:18px}"
"#pbGrid{grid-template-columns:repeat(auto-fill,minmax(220px,1fr))}"
".pb-series{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 18px}.pb-series .chip{cursor:pointer}"
".pb-card .pb-soon{align-self:flex-start;font-size:12px;font-weight:700;padding:3px 10px;border-radius:999px;background:var(--canvas);border:1px solid var(--line);color:var(--muted)}"
".pb-card .pb-who{font-size:13px;color:var(--muted)}"
".pb-readall{display:flex;flex-direction:column;gap:14px;margin:0;padding:0;list-style:none}.pb-readall li{display:flex;gap:12px;align-items:flex-start;line-height:1.75}.pb-readall li span{flex:none;width:28px;height:28px;border-radius:50%;background:var(--canvas);border:1px solid var(--line);display:grid;place-items:center;font-size:13px;font-weight:700}"
".pb-cast{display:flex;flex-direction:column;gap:14px}.pb-cast-p{display:flex;flex-direction:column;gap:8px;padding:12px;border:1px dashed var(--line);border-radius:16px}")

# ---------- data ----------
rep("const PB=PB_DATA.books;",
"const PB=PB_DATA.books;\n"
"/* ---- family series (2026-11-21): books with more than one person (parent, sibling, grandparents) + the single-child books from noy's file.\n"
"   textOnly books are shown in the catalog with their full story, and become orderable once their base art exists (then set textOnly:false). ---- */\n"
"const PB_FAM=" + FAM_JSON + ";\n"
"const PB_SERIES=PB_FAM.series;\n"
"for(const b of PB_FAM.books)if(!b.textOnly&&!PB.some(x=>x.id===b.id))PB.push(b);\n"
"const PB_ALL=()=>PB.concat(PB_FAM.books.filter(b=>b.textOnly&&!PB.includes(b)));")
rep("const pbBy=id=>PB.find(b=>b.id===id);", "const pbBy=id=>PB_ALL().find(b=>b.id===id);")
rep('const pbFill=(t,v)=>String(t||"").split("{{childName}}").join(v);',
'const PB_CAST_FALLBACK={sibName:"האח",grandpaName:"סבא",grandmaName:"סבתא"};\n'
'const pbFill=(t,v)=>{const o=v&&typeof v==="object"?v:{childName:v};return String(t||"").replace(/\\{\\{(\\w+)\\}\\}/g,(x,k)=>k==="childName"?String(o.childName):o[k]||PB_CAST_FALLBACK[k]||x)};\n'
'const pbDefs=b=>{const o={};for(const c of (b&&b.cast)||[])if(c.nameKey)o[c.nameKey]=(b.castDefaults||{})[c.nameKey]||c.def||"";return o};\n'
'const pbN=m=>({...pbDefs(pbBy(m.book)),...(m.castNames||{}),childName:m.name});')
rep("const pbTitle=(b,name)=>noNikud(pbFill(b.titleTemplate,name||pbDefName(b)));",
"const pbTitle=(b,name)=>noNikud(pbFill(b.titleTemplate,{...pbDefs(b),...(name&&typeof name===\"object\"?name:{childName:name||pbDefName(b)})}));")
rep("pbTitle(b,m.name)", "pbTitle(b,pbN(m))", 5)
rep("pbLetter(b,m.name)", "pbLetter(b,pbN(m))")
rep("pbPageText(pg.pg,m.name)", "pbPageText(pg.pg,pbN(m))")
rep("AgadiCover.svg({template:b.titleTemplate,name:name||pbDefName(b),theme:b.id,...(o||{})})",
"AgadiCover.svg({template:pbFill(b.titleTemplate,{...pbDefs(b),...(name&&typeof name===\"object\"?name:{}),childName:\"{{childName}}\"}),name:(name&&typeof name===\"object\"?name.childName:name)||pbDefName(b),theme:b.id,...(o||{})})")
rep("const PB_PAL={", "const PB_PAL={kid_basketball:[\"#E8742A\",\"#FFD35A\"],kid_pirates:[\"#1F6F8B\",\"#F3B23C\"],kid_council:[\"#7A4FD1\",\"#FFCC75\"],kid_business:[\"#1F9D6B\",\"#FFD35A\"],kid_farmer:[\"#5C9E3A\",\"#FFB84D\"],fam_dad_son:[\"#1B2A6B\",\"#FFD34D\"],fam_mom_son:[\"#2BA8C9\",\"#FFB8A0\"],fam_dad_daughter:[\"#D9473B\",\"#FFD35A\"],fam_mom_daughter:[\"#4B6FD1\",\"#FFB8C9\"],fam_bro_bro:[\"#3C4FB8\",\"#FFC83D\"],fam_bro_sis:[\"#B8642A\",\"#9FE0C9\"],fam_sis_sis:[\"#B048B0\",\"#FFD35A\"],fam_grand_son:[\"#2B7A5C\",\"#FFCC75\"],fam_grand_daughter:[\"#E07A2A\",\"#FFE08A\"],")

# ---------- cart / checkout titles carry the family names ----------
rep("function bookTitle(b,p){p=p||SAMPLE.f;return GT(b.title,p.gender,p.name)}",
"function bookTitle(b,p){p=p||SAMPLE.f;if(p.title)return p.title;return GT(b.title,p.gender,p.name)}")
rep("const p={name:it.child.name,gender:it.child.gender};", "const p={name:it.child.name,gender:it.child.gender,title:it.child.title};")
rep('child:{name:m.name,gender:pbG(b),age:"",', 'child:{name:m.name,gender:pbG(b),...(b.cast?{title:pbTitle(b,pbN(m)),cast:m.castNames||{}}:{}),age:"",')

# ---------- catalog: all books together + series chips ----------
rep('\n <div class="pb-grid">${PB.map(b=>pbCardHTML(b)).join("")}</div>', '\n ${pbCatalogHTML()}')
rep('$$("[data-del]",root).forEach(bt=>bt.onclick=async()=>{if(!confirmInline(bt,"למחוק לצמיתות?"))',
'pbCatalogBind(root);$$("[data-del]",root).forEach(bt=>bt.onclick=async()=>{if(!confirmInline(bt,"למחוק לצמיתות?"))')

# ---------- book page: text-only reader; family photos in the form ----------
rep('function pbFormView(root,b){const g=pbG(b);let photo=null,avatar=-1,extras=[];',
'function pbFormView(root,b){if(b.textOnly)return pbReadView(root,b);const g=pbG(b);let photo=null,avatar=-1,extras=[];const CS={};')
rep(' <div class="stack box pb-consent"><b>פרטיות התמונה</b>', ' ${pbCastFormHTML(b)}\n <div class="stack box pb-consent"><b>פרטיות התמונה</b>')
rep('$$("input[name=pbsrc]",root).forEach(r=>r.onchange=()=>{const av=r.value==="avatar"&&r.checked;$("#pbAvBox",root).hidden=!av;$("#pbPhotoBox",root).hidden=av;$(".pb-consent",root).hidden=av});',
'$$("input[name=pbsrc]",root).forEach(r=>r.onchange=()=>{const av=r.value==="avatar"&&r.checked;$("#pbAvBox",root).hidden=!av;$("#pbPhotoBox",root).hidden=av;$(".pb-consent",root).hidden=av});pbCastBind(root,b,CS);')
rep('else if(avatar<0){err.textContent="צריך לבחור אווטאר";return}',
'else if(avatar<0){err.textContent="צריך לבחור אווטאר";return}\n  {const ce=pbCastCheck(root,b,CS);if(ce){err.textContent=ce;return}}')
rep('if(src==="photo")for(let i=0;i<extras.length;i++)await pbSetImg(id,"photo"+(i+2),extras[i]);',
'if(src==="photo")for(let i=0;i<extras.length;i++)await pbSetImg(id,"photo"+(i+2),extras[i]);\n   for(const c of b.cast||[])if(CS[c.id])await pbSetImg(id,"cphoto_"+c.id,CS[c.id]);')
rep('consentAt:src==="photo"?Date.now():null,createdAt:Date.now(),sheetOk:false,approved:false,fmt:"hard"}',
'consentAt:src==="photo"?Date.now():null,createdAt:Date.now(),sheetOk:false,approved:false,fmt:"hard",...(b.cast?{castNames:pbCastNames(root,b),castOk:{},castConsentAt:Date.now()}:{})}')

# ---------- project: one character step per family member, after the child ----------
rep(' if(!m.sheetOk){', ' {const c=pbCastNext(b,m);if(c)return pbCastStep(root,m,b,c,head,foot)}\n if(!m.sheetOk){')
rep('for(const k of ["photo","photo2","photo3"])await PBDB.del', 'for(const k of ["photo","photo2","photo3",...((pbBy(m.book)||{}).cast||[]).map(c=>"cphoto_"+c.id)])await PBDB.del')
rep('...pbArt(bk,slot==="cover"?"cover":"page")};', '...pbArt(bk,slot==="cover"?"cover":"page"),...(await pbCastRefs(m))};')
rep('...pbArt(b,slot==="cover"?"cover":"page")})}', '...pbArt(b,slot==="cover"?"cover":"page"),...(await pbCastRefs(m))})}')

# ---------- new functions (placed before the personal route) ----------
FUNCS = r'''
/* ---- family series: catalog, reader, family-member photos and characters ---- */
const PB_ROLE_HE={father:"אבא",mother:"אמא",brother:"האח",sister:"האחות",grandfather:"סבא",grandmother:"סבתא"};
const pbWho=b=>{const g=pbG(b)==="f"?"הילדה":"הילד";return b.cast&&b.cast.length?[g,...b.cast.map(c=>c.label)].join(" + "):g};
function pbCatalogHTML(){const all=PB_ALL();const used=PB_SERIES.filter(s=>all.some(b=>(b.series||"kid")===s.id));
 return `<div class="pb-series" role="group" aria-label="סינון לפי סדרה"><button type="button" class="chip" data-ser="" aria-pressed="true">כל הספרים</button>${used.map(s=>`<button type="button" class="chip" data-ser="${s.id}" aria-pressed="false">${esc(s.label)}</button>`).join("")}</div>
 <div class="pb-grid" id="pbGrid">${all.map(b=>pbCardHTML(b)).join("")}</div>`}
function pbCatalogBind(root){const set=v=>{$$("[data-ser]",root).forEach(x=>x.setAttribute("aria-pressed",x.dataset.ser===v));$$("#pbGrid .pb-card",root).forEach(c=>c.hidden=!!v&&c.dataset.series!==v);try{sessionStorage.setItem("agadi-ser",v)}catch(e){}};
 $$("[data-ser]",root).forEach(bt=>bt.onclick=()=>set(bt.dataset.ser));let v="";try{v=sessionStorage.getItem("agadi-ser")||""}catch(e){}if(v&&$(`[data-ser="${v}"]`,root))set(v)}
function pbReadView(root,b){const n=pbDefs(b);n.childName=pbDefName(b);
 root.innerHTML=`<a class="small" href="#personal">→ כל הספרים</a><div class="pb-form"><div>${pbCoverArt(b)}<p class="small muted" style="margin-top:10px">${esc(b.genre)} · גילאי ${esc(b.ageRange)} · ${esc(pbWho(b))}</p></div>
 <div class="stack box"><h1 style="font-size:clamp(24px,3vw,32px)">${esc(pbTitle(b,n))}</h1>
 <div class="note info">האיורים לספר הזה עוד בהכנה, ולכן עדיין אי אפשר ליצור אותו. בינתיים אפשר לקרוא את כל הסיפור. בספר שלכם יופיעו השמות${b.cast?" והתמונות של המשפחה שלכם":" והתמונה של הילד שלכם"}.</div>
 <ol class="pb-readall">${b.pages.map(p=>`<li><span>${p.pageNumber}</span><p style="margin:0">${esc(pbPageText(p,n))}</p></li>`).join("")}</ol>
 <a class="btn btn-ghost" href="#personal" style="align-self:flex-start">לכל הספרים</a></div></div>`}
function pbCastFormHTML(b){if(!b.cast||!b.cast.length)return "";
 return `<div class="stack box pb-cast"><b>${b.cast.length>1?"עוד משתתפים בספר":"עוד משתתף בספר"}</b><p class="small muted" style="margin:0">כל אחד מצויר כדמות משלו, ונראה אותו דבר בכל העמודים. מעלים תמונה ברורה של הפנים, מלפנים ובאור טוב.</p>
 ${b.cast.map(c=>`<div class="pb-cast-p" data-cast="${c.id}"><b>${esc(c.label)}</b>
  ${c.nameKey?`<label class="f">${esc(c.ask||("השם של "+c.label))}<input class="inp" data-cname="${c.id}" maxlength="20" autocomplete="off" placeholder="${esc((b.castDefaults||{})[c.nameKey]||c.def||"")}"></label>`:""}
  <label class="pb-drop pb-drop-sm" for="pbCF_${c.id}"><input type="file" id="pbCF_${c.id}" data-cfile="${c.id}" accept="image/*" hidden><span id="pbCP_${c.id}">לבחור תמונה של ${esc(c.label)}</span></label><div class="pb-q" id="pbCQ_${c.id}" aria-live="polite"></div></div>`).join("")}
 <p class="small pb-privacy"><span><b>גם כאן הפרטיות חשובה לנו.</b> כל תמונה משמשת רק כדי לצייר את הדמות, השרתים שלנו לא שומרים אותה, ועותק נשאר רק בדפדפן שלכם ונמחק אוטומטית אחרי ${PB_KEEP_DAYS} ימים.</span></p>
 <label class="chk"><input type="checkbox" id="pbC3"> מי שמופיע בתמונות (או ההורה שלו, אם הוא ילד) הסכים שנשתמש בתמונה שלו רק כדי ליצור את איורי הספר, באותם תנאים של התמונה של הילד.</label></div>`}
function pbCastBind(root,b,CS){for(const c of b.cast||[]){const inp=$("#pbCF_"+c.id,root);if(!inp)continue;
 inp.onchange=async e=>{const file=e.target.files[0];if(!file||!/^image\//.test(file.type)||file.size>15e6)return;const url=await new Promise(r=>{const fr=new FileReader();fr.onload=()=>r(fr.result);fr.readAsDataURL(file)});
  try{CS[c.id]=await pbPrepPhoto(url,1536);$("#pbCP_"+c.id,root).innerHTML=`<img src="${CS[c.id]}" alt="התמונה של ${esc(c.label)}">`;pbShowQ($("#pbCQ_"+c.id,root),(await pbPhotoCheck(CS[c.id])).filter(t=>!/הילד/.test(t)))}catch(x){}}}}
function pbCastCheck(root,b,CS){if(!b.cast)return "";for(const c of b.cast)if(!CS[c.id])return "צריך להעלות גם תמונה של "+c.label;const k=$("#pbC3",root);if(k&&!k.checked)return "צריך לאשר את סעיף הפרטיות של שאר המשתתפים";
 for(const c of b.cast){const i=$(`[data-cname="${c.id}"]`,root);if(i&&/[<>{}]/.test(i.value))return "השם יכול להכיל רק אותיות ורווחים"}return ""}
function pbCastNames(root,b){const o={};for(const c of b.cast||[]){if(!c.nameKey)continue;const i=$(`[data-cname="${c.id}"]`,root);const v=i?i.value.trim().replace(/\s+/g," ").replace(/[<>{}]/g,""):"";if(v)o[c.nameKey]=v.slice(0,20)}return o}
const pbCastNext=(b,m)=>m.heroOk&&b.cast?b.cast.find(c=>!(m.castOk||{})[c.id]):null;
const pbCastLabel=(b,m,c)=>c.nameKey?pbN(m)[c.nameKey]||c.label:c.label;
async function pbCastRefs(m){const b=pbBy(m.book);if(!b||!b.cast)return {};const cast=[];for(const c of b.cast){const u=await pbImg(m.id,"chero_"+c.id);if(u)cast.push({role:c.role,hero:b64(u),heroMime:pbMime(u)})}return cast.length?{cast}:{}}
function pbCastPrompt(b,c,n,fix){const adult=!/brother|sister/.test(c.role);return [
 "TASK: create a completely NEW image from scratch. Image 1 is reference only for who this person is: do NOT edit, retouch, extend or restyle image 1, and nothing of image 1 (background, furniture, photo texture) may appear in the output.",
 "Draw ONE character only: the hero's "+c.role+" in this family picture book, drawn from the real person in the reference photo. Full body, front view, the person fills about 90% of the image height, standing relaxed and smiling warmly, face large and clearly lit, on a plain very light cream background. No other characters, no props, no scenery, no text.",
 "Outfit: casual, warm everyday clothes in soft colours, no text or logos; keep glasses and jewellery only if worn in the photo.",
 "LIKENESS IS THE TOP PRIORITY. The family must instantly recognise this person. Copy from the photo: face shape, eye shape and colour, eyebrows, nose, mouth and smile, ears, the exact skin tone, "+(adult?"wrinkles and laugh lines, facial hair (beard or moustache exactly as in the photo, or none), ":"freckles, ")+"hair colour (including grey or white), hair length, texture and style, baldness or hairline, and glasses if worn. Keep the person's real age"+(adult?" and build":", height and build of a child")+". Do not make them younger, slimmer or idealised, and never change skin tone or ethnicity. Stylise only the rendering, never the features.",
 fix?"The family saw an earlier attempt and asked for this correction (written in Hebrew): \""+fix+"\". Apply it while keeping everything else.":"",
 n?"Variation "+(n+1)+": a slightly different expression, same features.":"",
 "Art style: the HOUSE STYLE (premium 3D animated feature film character), matching the child's character in this book."].filter(Boolean).join("\n")}
async function pbRenderCast(m,b,c,n,fix,prev){const photo=await pbImg(m.id,"cphoto_"+c.id);if(!photo)throw Object.assign(new Error("photo deleted"),{code:"no_photo"});
 return aiCall({mode:"render",engine:PB_ENGINE,photo:b64(photo),prompt:pbCastPrompt(b,c,n,fix),aspect:"4:5",gender:/mother|sister|grandmother/.test(c.role)?"f":"m",person:c.role,describe:false,...(fix&&prev&&PB_V2.has(b.id)?{prev:b64(prev),prevMime:pbMime(prev)}:{}),...pbArt(b,"hero")})}
async function pbCastStep(root,m,b,c,head,foot){const id=m.id,k="chero_"+c.id,ka="cheroAlt_"+c.id,who=pbCastLabel(b,m,c);let n=(m.castN||{})[c.id]||0;
 const hero=await pbImg(id,k);const wait=`<div class="pb-wait"><span class="spin" aria-hidden="true"></span><span>מציירים שתי גרסאות של ${esc(who)}. זה לוקח פחות מדקה.</span></div>`;
 const cands=u=>u.filter(Boolean).map((x,i)=>`<button type="button" class="pb-cand" data-k="${i}" aria-pressed="${i===0}"><img src="${x}" alt="גרסה ${i+1} של ${esc(who)}"><span>${i===0?"נבחרה":"לבחור בגרסה הזו"}</span></button>`).join("");
 const idx=b.cast.indexOf(c)+1;
 root.innerHTML=head+`<section class="box stack pb-sheet"><h2>הדמות של ${esc(who)}</h2><p class="muted">הדמות של ${esc(m.name)} מוכנה. עכשיו מציירים את ${esc(who)}${b.cast.length>1?` (${idx} מתוך ${b.cast.length})`:""}. בחרו את הגרסה הכי דומה, ואם משהו לא דומה כתבו מה לתקן.</p>
  <div class="pb-cands" id="pbCastBox">${hero?cands([hero,await pbImg(id,ka)]):wait}</div><span class="small bad" id="pbMsg" aria-live="polite"></span>
  <div class="row"><button class="btn btn-primary" id="pbOkCast" ${hero?"":"disabled"}>זה ${esc(who)}, אפשר להמשיך</button><button class="btn btn-ghost" id="pbBackHero" type="button">לחזור לדמות של ${esc(m.name)}</button></div>
  <div class="pb-fix stack" id="pbFixBox" ${hero?"":"hidden"}><label class="f" for="pbFix">לא מספיק דומה? כתבו מה שונה, ונצייר שוב<textarea class="inp" id="pbFix" rows="2" maxlength="200" placeholder="למשל: השיער אפור יותר, יש זקן קצר, משקפיים עגולים"></textarea></label><button class="btn btn-ghost" id="pbReCast" type="button">לצייר שוב</button></div></section>`+foot;
 pbBindFoot(root,m);
 const bindC=()=>$$(".pb-cand",root).forEach(bt=>bt.onclick=async()=>{if(bt.dataset.k==="0")return;const h=await pbImg(id,k),a=await pbImg(id,ka);await pbSetImg(id,k,a);await pbSetImg(id,ka,h);$("#pbCastBox",root).innerHTML=cands([a,h]);bindC()});
 const draw=async fix=>{const box=$("#pbCastBox",root),msg=$("#pbMsg",root);msg.textContent="";box.innerHTML=wait;$("#pbOkCast",root).disabled=true;$("#pbFixBox",root).hidden=true;
  const cur=fix?await pbImg(id,k):null;const r=await Promise.allSettled([pbRenderCast(m,b,c,n,fix,cur),pbRenderCast(m,b,c,n+1,fix,cur)]);n+=2;const ok=r.filter(x=>x.status==="fulfilled").map(x=>x.value);if(!root.isConnected)return;
  if(ok.length){await pbSetImg(id,k,ok[0]);if(ok[1])await pbSetImg(id,ka,ok[1]);else await PBDB.del("i:"+id+":"+ka);m.castN={...(m.castN||{}),[c.id]:n};await pbSaveMeta(m);box.innerHTML=cands(ok);bindC();$("#pbOkCast",root).disabled=false}
  else{msg.textContent=pbErr(r[0].reason);const h=await pbImg(id,k);box.innerHTML=h?cands([h,await pbImg(id,ka)]):"";if(h)bindC();$("#pbOkCast",root).disabled=!h}
  $("#pbFixBox",root).hidden=false};
 bindC();
 $("#pbReCast",root).onclick=()=>draw($("#pbFix",root).value.trim().replace(/[<>{}]/g,"").slice(0,200));
 $("#pbBackHero",root).onclick=async()=>{m.heroOk=false;await pbSaveMeta(m);pbProjectView(root,id)};
 $("#pbOkCast",root).onclick=async()=>{m.castOk={...(m.castOk||{}),[c.id]:true};m.hq={};for(const s of pbSlots())await PBDB.del("i:"+id+":"+s);await PBDB.del("i:"+id+":"+ka);await pbSaveMeta(m);pbProjectView(root,id)};
 if(!hero&&AI_ON())draw();else if(!hero)$("#pbMsg",root).textContent="יצירת האיורים פועלת באתר המלא בלבד"}
function pbCardHTML(b){const soon=b.textOnly;return `<a class="pb-card" href="#personal?book=${b.id}" data-series="${esc(b.series||"kid")}">${pbCoverArt(b)}<div class="stack" style="gap:4px"><b>${esc(pbTitle(b,{childName:"השם שלכם"}))}</b><span class="small muted">${esc(b.genre)} · גילאי ${esc(b.ageRange)} · ${b.pageCount} עמודים</span>${b.cast?`<span class="pb-who">משתתפים: ${esc(pbWho(b))}</span>`:""}${soon?`<span class="pb-soon">האיורים בהכנה · אפשר לקרוא את הסיפור</span>`:`<span class="small pb-price">ספר מ־${fmtPrice(FORMATS.digital.price)} · מודפס מ־${fmtPrice(FORMATS.hard.price)}</span>`}</div><span class="btn ${soon?"btn-soft":"btn-primary"} btn-sm">${soon?"לקרוא את הסיפור":"תצוגה מקדימה חינם"}</span></a>`}
'''
# replace the old card function with the new one (kept inside FUNCS)
import re
m = re.search(r'\nfunction pbCardHTML\(b\)\{return `<a class="pb-card".*?</a>`\}\n', src)
assert m, "card"
src = src[:m.start()] + "\n" + src[m.end():]
rep("routes.personal={title:()=>", FUNCS.strip("\n") + "\nroutes.personal={title:()=>")
rep("const books=PB.filter(b=>pbG(b)===c.gender);", "const books=PB.filter(b=>pbG(b)===c.gender&&!b.cast);")
rep("if(q.book&&q.char&&pbBy(q.book))return", "if(q.book&&q.char&&pbBy(q.book)&&!pbBy(q.book).cast&&!pbBy(q.book).textOnly)return")
open(P, "w").write(src)
print("patched", len(src))
