# Run AFTER the 15 base images are uploaded to covers/base/v2/fam_grand_son/: makes "התזמורת שבארון" orderable (preview p1-p2, cast swap).
import sys
P = sys.argv[1]; s = open(P).read()
a = '"id":"fam_grand_son","series":"grand_son","audience":"בנים","titleTemplate":"התזמורת שבארון","ageRange":"3–8","genre":"מוזיקה / משפחה / סבא, סבתא ונכד","pageCount":12,"textOnly":true'
assert s.count(a) == 1; s = s.replace(a, a.replace('"textOnly":true', '"textOnly":false'))
b = 'const PB_V2=new Set(["fairy_garden",'
assert s.count(b) == 1; s = s.replace(b, 'const PB_V2=new Set(["fam_grand_son","fairy_garden",')
open(P, "w").write(s); print("ok")
