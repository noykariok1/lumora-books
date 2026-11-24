# Agadibook: index.html patch for "סיפור משלכם" (own-story.js). Apply to the master source: python3 own_patch.py index.html
import sys,re
p=sys.argv[1];s=open(p,encoding="utf-8").read()
def rep(old,new,count=1):
    global s
    n=s.count(old)
    assert n==count,(n,old[:80])
    s=s.replace(old,new)
# A. own books live next to the ready books, looked up by id (never listed in the shop grids)
rep("const pbBy=id=>PB_ALL().find(b=>b.id===id);","const PB_OWN={}; // \"סיפור משלכם\": books the parent wrote on this device (own-story.js)\nconst pbBy=id=>PB_ALL().find(b=>b.id===id)||PB_OWN[id];")
# B. register them before the first route, and they have no pre-made art
rep('const PB_BASE_URL=(book,slot)=>"https://','try{Object.values(JSON.parse(localStorage.getItem("agadi-own-books")||"{}")).forEach(b=>{if(b&&b.id){b.custom=true;PB_OWN[b.id]=b;PB_V2.add(b.id)}})}catch(e){} // own stories: 3D house style, drawn from scratch\nconst PB_BASE_URL=(book,slot)=>PB_OWN[book]?"data:,":"https://')
# C. own book pages are drawn from scratch (no base page to swap the child into)
rep('async function pbSwapPage(m,slot,hero,quality){const photo=','async function pbSwapPage(m,slot,hero,quality){if(PB_OWN[m.book]&&window.ownDrawPage)return ownDrawPage(m,slot,hero,quality);const photo=')
# D. the name typed in the studio is already filled in
rep('<input class="inp" id="pbName" maxlength="20" autocomplete="off" placeholder=','<input class="inp" id="pbName" maxlength="20" autocomplete="off" value="${esc(b.heroName||"")}" placeholder=')
# E. the order keeps the story text of an own book
rep('char:i.char,art:i.art||null,project:i.project})),','char:i.char,art:i.art||null,project:i.project,...(window.ownOrderInfo&&ownOrderInfo(i)?{own:ownOrderInfo(i)}:{})})),')
# F. the old prototype studio is replaced by own-story.js (stub until it loads)
a=s.index('/* ================= CREATE YOUR OWN ================= */');b=s.index('/* ================= ADMIN (owner) ================= */')
s=s[:a]+'/* ================= CREATE YOUR OWN: own-story.js (loaded after this script) ================= */\nroutes["create-own"]={title:()=>"סיפור משלכם",html(){return `<div class="wrap section"><div class="skel" style="height:240px"></div></div>`},mount(){}};\n'+s[b:]
# G. load the studio
if '<script src="own-story.js' not in s:
    i=s.rindex('</body>');s=s[:i]+'<script src="own-story.js?v=20261121"></script>\n'+s[i:]
open(p,"w",encoding="utf-8").write(s);print("ok")
