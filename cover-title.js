/* Sefer VaChetzi cover lettering.
   Draws the book title as crisp vector "sticker" lettering over the cover art, with the child's name as the hero word.
   The image model never draws text (Hebrew from image models is unreliable); the title is always sharp, spelled right and
   personal. The same SVG is used on the site and rasterised for print.

   Usage:
     await AgadiCover.ready();                       // waits for the display font
     el.innerHTML = AgadiCover.svg({ template: "{{childName}} והגול של כולם", name: "איתי",
                                     theme: "soccer_hero", photo: dataUrlOrNull });
     const png = await AgadiCover.toPNG(coverImgUrl, opts, 2048); // print raster (cover art + lettering)
*/
(function () {
  const W = 1000, H = 1250; // 4:5, same as the cover art
  const FONT = "Rubik";     // has Hebrew glyphs, weight 900 for the sticker look; loaded by the page from Google Fonts

  // Per-book lettering colours: [name fill top, name fill bottom, outline, glow/shadow, secondary word fill]
  const THEMES = {
    soccer_hero:        { top: "#FFE066", bot: "#FFB627", line: "#0B3B5C", shadow: "#06263D", rest: "#FFFFFF", star: "#FFD34D" },
    little_firefighter: { top: "#FFE27A", bot: "#FF9F1C", line: "#7A1010", shadow: "#4A0909", rest: "#FFFFFF", star: "#FFD34D" },
    fairy_garden:       { top: "#FFF1FA", bot: "#FFB8E0", line: "#5B2A86", shadow: "#3A1658", rest: "#FFFFFF", star: "#FFE38A" },
    space_captain:      { top: "#B9FBFF", bot: "#3ED6F0", line: "#1B1553", shadow: "#0B0830", rest: "#FFFFFF", star: "#FFD34D" },
    _default:           { top: "#FFE066", bot: "#FFB627", line: "#1B1F4B", shadow: "#0E1030", rest: "#FFFFFF", star: "#FFD34D" },
  };

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  let _ctx;
  function measure(text, size) {
    _ctx = _ctx || document.createElement("canvas").getContext("2d");
    _ctx.font = `900 ${size}px ${FONT}, "Assistant", sans-serif`;
    return _ctx.measureText(text).width;
  }

  // Split the template into lines: words before the name, the name alone, the words after (balanced into 1-2 lines).
  function lines(template, name) {
    // a title without the child's name (e.g. "התזמורת שבארון"): the title itself is the hero, balanced into 1-2 lines
    if (!String(template).includes("{{childName}}")) {
      const w = String(template).trim().split(/\s+/).filter(Boolean);
      if (w.length < 2) return [{ t: w.join(" "), hero: true }];
      let best = 1, diff = 1e9;
      for (let i = 1; i < w.length; i++) {
        const d = Math.abs(w.slice(0, i).join(" ").length - w.slice(i).join(" ").length);
        if (d < diff) { diff = d; best = i; }
      }
      return [{ t: w.slice(0, best).join(" "), hero: true }, { t: w.slice(best).join(" "), hero: true }];
    }
    const [pre, post = ""] = String(template).split("{{childName}}");
    const out = [];
    if (pre.trim()) out.push({ t: pre.trim(), hero: false });
    out.push({ t: name.trim() || "השם", hero: true });
    const words = post.trim().split(/\s+/).filter(Boolean);
    if (words.length) {
      const full = words.join(" ");
      if (full.length > 13 && words.length > 2) {
        // balance into two lines by character count
        let best = 1, diff = 1e9;
        for (let i = 1; i < words.length; i++) {
          const d = Math.abs(words.slice(0, i).join(" ").length - words.slice(i).join(" ").length);
          if (d < diff) { diff = d; best = i; }
        }
        out.push({ t: words.slice(0, best).join(" "), hero: false }, { t: words.slice(best).join(" "), hero: false });
      } else out.push({ t: full, hero: false });
    }
    return out;
  }

  // One sticker word: shadow, thick dark outline, white rim, fill. paint-order keeps strokes outside the glyph.
  function stickerText(x, y, size, text, fill, th, rot) {
    const common = `x="${x}" y="${y}" font-size="${size}" text-anchor="middle" direction="rtl" font-family="${FONT}, Assistant, sans-serif" font-weight="900" transform="rotate(${rot} ${x} ${y})"`;
    const t = esc(text);
    const s = size;
    return `<g>
      <text ${common} fill="${th.shadow}" stroke="${th.shadow}" stroke-width="${s * 0.17}" stroke-linejoin="round" dx="${s * 0.02}" dy="${s * 0.06}" opacity=".5">${t}</text>
      <text ${common} fill="${th.line}" stroke="${th.line}" stroke-width="${s * 0.17}" stroke-linejoin="round">${t}</text>
      <text ${common} fill="#FFFFFF" stroke="#FFFFFF" stroke-width="${s * 0.075}" stroke-linejoin="round">${t}</text>
      <text ${common} fill="${fill}">${t}</text>
      <text ${common} fill="url(#ag-gloss)" opacity=".55">${t}</text>
    </g>`;
  }

  function sparkle(x, y, r, color, op = 1) {
    const k = r * 0.28;
    return `<path d="M${x} ${y - r} Q${x + k} ${y - k} ${x + r} ${y} Q${x + k} ${y + k} ${x} ${y + r} Q${x - k} ${y + k} ${x - r} ${y} Q${x - k} ${y - k} ${x} ${y - r}Z" fill="${color}" opacity="${op}"/>`;
  }

  /* opts: template, name, theme, photo (data URL or null), position ("top" default | "bottom"), brand (default true)
     Returns an <svg> string sized to fill its container (absolute inset 0 works). */
  function svg(opts) {
    const th = THEMES[opts.theme] || THEMES._default;
    const L = lines(opts.template, opts.name || "");
    const maxW = W * 0.84;
    // fit: hero line 1.5x the others, every line inside maxW, total block within ~40% of the cover height
    let base = 110;
    for (const l of L) {
      const k = l.hero ? 1.5 : 1;
      const w = measure(l.t, 100 * k) / 100;
      base = Math.min(base, maxW / (w || 1) / k);
    }
    const heights = () => L.reduce((a, l) => a + (l.hero ? 1.5 : 1) * base * 1.18, 0);
    while (heights() > H * 0.31 && base > 40) base -= 2;
    base = Math.max(40, Math.floor(base));

    const bottom = opts.position === "bottom";
    let y = bottom ? H - 70 - heights() : 46;
    const rows = [];
    const rots = [-3, 2, -1.5, 2.5];
    L.forEach((l, i) => {
      const size = l.hero ? base * 1.5 : base;
      y += size * 0.92;
      rows.push(stickerText(W / 2, y, size, l.t, l.hero ? "url(#ag-hero)" : th.rest, th, rots[i % rots.length] * (l.hero ? 0.7 : 1)));
      y += size * 0.26;
    });

    // twinkles around the title block (sparkles around the title)
    const top = bottom ? H - 70 - heights() : 46;
    const tw = [
      sparkle(W * 0.1, top + 40, 26, th.star), sparkle(W * 0.9, top + heights() * 0.55, 20, th.star),
      sparkle(W * 0.16, top + heights() * 0.85, 12, "#fff", 0.9), sparkle(W * 0.84, top + 20, 11, "#fff", 0.9),
    ].join("");

    // optional photo: a tilted keepsake snapshot in the lower corner with a sparkle trail toward the hero
    let photo = "";
    if (opts.photo) {
      const px = 70, py = H - 330, pw = 230, ph = 260;
      photo = `<g transform="rotate(-6 ${px + pw / 2} ${py + ph / 2})" filter="url(#ag-soft)">
          <rect x="${px}" y="${py}" width="${pw}" height="${ph}" rx="14" fill="#fff"/>
          <clipPath id="ag-ph"><rect x="${px + 14}" y="${py + 14}" width="${pw - 28}" height="${pw - 28}" rx="8"/></clipPath>
          <image href="${esc(opts.photo)}" x="${px + 14}" y="${py + 14}" width="${pw - 28}" height="${pw - 28}" preserveAspectRatio="xMidYMid slice" clip-path="url(#ag-ph)"/>
          <text x="${px + pw / 2}" y="${py + ph - 14}" text-anchor="middle" font-family="${FONT}, Assistant, sans-serif" font-weight="700" font-size="24" fill="${th.line}">${esc(opts.photoLabel || "זה אני!")}</text>
          <rect x="${px + pw / 2 - 45}" y="${py - 16}" width="90" height="30" rx="4" fill="${th.star}" opacity=".85" transform="rotate(4 ${px + pw / 2} ${py})"/>
        </g>
        <path d="M ${px + pw + 10} ${py + 60} C ${px + pw + 90} ${py - 10}, ${px + pw + 150} ${py + 40}, ${px + pw + 200} ${py - 40}" fill="none" stroke="#fff" stroke-width="7" stroke-linecap="round" stroke-dasharray="1 18" opacity=".95"/>
        ${sparkle(px + pw + 215, py - 55, 24, th.star)}`;
    }

    const brand = opts.brand === false ? "" : `<g opacity=".95">
        <rect x="${W / 2 - 92}" y="${H - 64}" width="184" height="40" rx="20" fill="rgba(14,16,48,.55)"/>
        ${sparkle(W / 2 + 64, H - 44, 11, th.star)}
        <text x="${W / 2 - 8}" y="${H - 35}" text-anchor="middle" font-family="${FONT}, Assistant, sans-serif" font-weight="700" font-size="25" fill="#fff">ספר וחצי</text>
      </g>`;

    // soft scrim behind the title so lettering reads on any artwork
    const scrim = bottom
      ? `<rect x="0" y="${H * 0.52}" width="${W}" height="${H * 0.48}" fill="url(#ag-scrim-b)"/>`
      : `<rect x="0" y="0" width="${W}" height="${H * 0.5}" fill="url(#ag-scrim-t)"/>`;

    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="100%" height="100%" preserveAspectRatio="xMidYMid slice" style="position:absolute;inset:0;pointer-events:none" aria-label="${esc(String(opts.template).replace("{{childName}}", opts.name || ""))}" role="img">
      <defs>
        <linearGradient id="ag-hero" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${th.top}"/><stop offset="1" stop-color="${th.bot}"/></linearGradient>
        <linearGradient id="ag-gloss" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".9"/><stop offset=".45" stop-color="#fff" stop-opacity="0"/></linearGradient>
        <linearGradient id="ag-scrim-t" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${th.shadow}" stop-opacity=".28"/><stop offset="1" stop-color="${th.shadow}" stop-opacity="0"/></linearGradient>
        <linearGradient id="ag-scrim-b" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="${th.shadow}" stop-opacity=".5"/><stop offset="1" stop-color="${th.shadow}" stop-opacity="0"/></linearGradient>
        <filter id="ag-soft" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="8" stdDeviation="10" flood-color="#000" flood-opacity=".35"/></filter>
      </defs>
      ${scrim}${tw}${rows.join("")}${photo}${brand}
    </svg>`;
  }

  async function ready() {
    if (!document.fonts) return;
    await Promise.all([document.fonts.load(`900 100px ${FONT}`, "אבג"), document.fonts.load(`700 30px ${FONT}`, "אבג")]).catch(() => {});
  }

  // Cover art + lettering flattened into one PNG (for print / sharing). size = long edge in px.
  async function toPNG(artUrl, opts, size = 2048) {
    await ready();
    const h = size, w = Math.round(size * 0.8);
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    const g = c.getContext("2d");
    const load = (src) => new Promise((ok, no) => { const i = new Image(); i.crossOrigin = "anonymous"; i.onload = () => ok(i); i.onerror = no; i.src = src; });
    const art = await load(artUrl);
    const s = Math.max(w / art.width, h / art.height);
    g.drawImage(art, (w - art.width * s) / 2, (h - art.height * s) / 2, art.width * s, art.height * s);
    // canvas cannot use page fonts inside an SVG image, so embed the font as a data URL first
    const css = await fontFaceCSS();
    const markup = svg(opts).replace("<defs>", `<defs><style>${css}</style>`);
    const over = await load("data:image/svg+xml;charset=utf-8," + encodeURIComponent(markup));
    g.drawImage(over, 0, 0, w, h);
    return c.toDataURL("image/png");
  }

  let _fontCSS;
  async function fontFaceCSS() {
    if (_fontCSS !== undefined) return _fontCSS;
    try {
      const css = await (await fetch("https://fonts.googleapis.com/css2?family=Rubik:wght@700;900&display=swap")).text();
      const rules = [...css.matchAll(/@font-face\s*{[^}]*}/g)].map((m) => m[0]).filter((r) => /U\+0590|U\+05/.test(r) || /latin/.test(r));
      const out = [];
      for (const r of rules) {
        const url = (r.match(/url\(([^)]+)\)/) || [])[1];
        if (!url) continue;
        const b = await (await fetch(url)).arrayBuffer();
        const u = new Uint8Array(b); let bin = ""; for (let i = 0; i < u.length; i += 0x8000) bin += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); const b64 = btoa(bin);
        out.push(r.replace(url, `data:font/woff2;base64,${b64}`));
      }
      _fontCSS = out.join("\n");
    } catch { _fontCSS = ""; }
    return _fontCSS;
  }

  window.AgadiCover = { svg, ready, toPNG, THEMES, lines };
})();
