/* Gh057 theme motion core (from the CySEC Club scoreboard): rolling odometer,
   orbit stage, gauges, signal strip, score chart, toasts, confirm modal,
   capture moment. Exposes window.GH. */
(function () {
  "use strict";
  const GH = (window.GH = {});
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const pad2 = (n) => String(Math.max(0, Math.floor(n))).padStart(2, "0");
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  Object.assign(GH, { $, $$, esc, pad2, clamp, reduced });

  /* ───────────── server clock sync ───────────── */
  let offset = 0;
  GH.now = () => Date.now() + offset;
  GH.syncClock = (serverEpochS) => { if (serverEpochS) offset = serverEpochS * 1000 - Date.now(); };

  /* ───────────── rolling odometer (HH:MM:SS) ───────────── */
  GH.Odometer = function (el) {
    const cell = () => {
      let s = "";
      for (let k = 0; k < 3; k++) for (let d = 0; d < 10; d++) s += `<span>${d}</span>`;
      return `<span class="odo-d"><span class="odo-reel">${s}</span></span>`;
    };
    const sep = `<span class="odo-sep" aria-hidden="true"><i></i><i></i></span>`;
    el.innerHTML = `<span class="odo-g">${cell()}${cell()}</span>${sep}<span class="odo-g">${cell()}${cell()}</span><span class="odo-sec">${sep}${cell()}${cell()}</span>`;
    el.setAttribute("role", "timer");
    const reels = $$(".odo-reel", el);
    const pos = reels.map(() => 10);
    const apply = (i) => (reels[i].style.transform = `translateY(${-pos[i]}em)`);
    const snap = (i) => {
      const n = 10 + (((pos[i] % 10) + 10) % 10);
      if (n === pos[i]) return;
      pos[i] = n;
      reels[i].classList.add("snap");
      apply(i);
      void reels[i].offsetHeight;
      reels[i].classList.remove("snap");
    };
    reels.forEach((r, i) => { apply(i); r.addEventListener("transitionend", () => snap(i)); });
    return {
      set(str, label) {
        if (label) el.setAttribute("aria-label", label);
        for (let i = 0; i < 6; i++) {
          const d = +str[i];
          const cur = ((pos[i] % 10) + 10) % 10;
          if (d === cur) continue;
          let delta = d - cur;
          if (delta > 5) delta -= 10;
          if (delta < -5) delta += 10;
          if (pos[i] + delta < 2 || pos[i] + delta > 27) snap(i);
          pos[i] += delta;
          if (reduced) { pos[i] = 10 + d; reels[i].classList.add("snap"); }
          apply(i);
        }
      },
    };
  };
  GH.hms = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    return pad2(Math.min(99, Math.floor(s / 3600))) + pad2((s % 3600) / 60) + pad2(s % 60);
  };

  /* ───────────── count-up numbers ───────────── */
  GH.count = (el, to, dur = 900) => {
    if (!el) return;
    const from = +el.dataset.v || 0;
    el.dataset.v = to;
    if (reduced || from === to) { el.textContent = to.toLocaleString("en-IN"); return; }
    const t0 = performance.now();
    const step = (t) => {
      const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3);
      el.textContent = Math.round(from + (to - from) * e).toLocaleString("en-IN");
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  };

  /* ───────────── orbit stage ───────────── */
  GH.Stage = function (orbit, opts) {
    const o = Object.assign({ left: "", right: "", gauges: [], maxStepL: 30, maxStepR: 20, flatAt: 860 }, opts);
    const ticks = Array.from({ length: 72 }, (_, i) => {
      const a = (i / 72) * Math.PI * 2, r1 = i % 6 ? 58.6 : 57.6;
      return `<line x1="${(Math.cos(a) * r1).toFixed(2)}" y1="${(Math.sin(a) * r1).toFixed(2)}" x2="${(Math.cos(a) * 59.6).toFixed(2)}" y2="${(Math.sin(a) * 59.6).toFixed(2)}"/>`;
    }).join("");
    orbit.insertAdjacentHTML("afterbegin", `
      <svg class="links" aria-hidden="true"></svg>
      <div class="core" aria-hidden="true">
        <div class="core-atmo"></div><div class="core-disc"></div><div class="core-grid"></div>
        <div class="core-eyes"><i></i><i></i></div><i class="emb"></i>
        <svg class="core-rings" viewBox="-63 -63 126 126">
          <g class="r1"><circle r="54" fill="none" stroke="#7be3f2" stroke-opacity=".45" stroke-width=".35" stroke-dasharray=".4 1.6"/></g>
          <g class="r2" stroke="#7be3f2" stroke-opacity=".28" stroke-width=".3">${ticks}
            <path d="M 0 -61.5 A 61.5 61.5 0 0 1 43.5 -43.5" fill="none" stroke="#ff2b3d" stroke-opacity=".75" stroke-width=".6"/></g>
          <g class="r3"><circle cx="0" cy="-54" r=".9" fill="#7be3f2"/><circle cx="0" cy="-54" r="2.2" fill="#7be3f2" fill-opacity=".18"/></g>
        </svg>
        <div class="ping"></div>
      </div>
      <div class="arc-h L">${esc(o.left)}</div><div class="arc-h R">${esc(o.right)}</div>
      <div class="arc-list L"></div><div class="arc-list R"></div>
      <div class="gauges">${o.gauges.map((g) => GH.gaugeHTML(g)).join("")}</div>`);
    const core = $(".core", orbit), links = $("svg.links", orbit);
    const lists = { L: $(".arc-list.L", orbit), R: $(".arc-list.R", orbit) };
    const heads = { L: $(".arc-h.L", orbit), R: $(".arc-h.R", orbit) };
    const rows = { L: new Map(), R: new Map() };
    const order = { L: [], R: [] };
    const geo = { flat: false, cx: 0, cy: 0, R: 0, fscale: 1, anchors: { L: new Map(), R: new Map() } };

    function setGeo(R) {
      const d = R * 2;
      geo.R = R;
      orbit.style.setProperty("--cx", geo.cx + "px");
      orbit.style.setProperty("--cy", geo.cy + "px");
      orbit.style.setProperty("--d", d + "px");
      orbit.style.setProperty("--gy", geo.cy + R * 0.74 + "px");
      orbit.style.setProperty("--gd", clamp(d * 0.24, 56, 128) + "px");
    }
    const widest = (side) => order[side].reduce((m, k) => Math.max(m, rows[side].get(k)?.offsetWidth || 0), 0);
    const flatten = () => {
      for (const s of ["L", "R"]) {
        order[s].forEach((k) => { const el = rows[s].get(k); if (el) { el.style.transform = ""; el.style.opacity = ""; lists[s].appendChild(el); } });
      }
    };

    /* Fit the board to the space it has: wide screens get a bigger planet and
       bigger text; when the lists would run off the edge, the planet shrinks
       first, then the text, and only then does it fall back to stacked lists. */
    function layout() {
      const W = orbit.clientWidth;
      let flat = W < o.flatAt;
      if (!flat) {
        orbit.classList.remove("flat");
        const N = Math.max(order.L.length, order.R.length);
        // tall enough that every row keeps its own line above the headline, however many teams
        const minStep = orbit.closest(".big") ? 12 : 15; // big screen packs rows a little tighter
        const need = ((N - 1) * minStep) / 2, dockH = dockSpace();
        orbit.style.setProperty("--need", N > 1 ? Math.ceil(Math.max((need + 44) / 0.46, (need + dockH) / 0.54)) + "px" : "0px");
        const H = orbit.clientHeight, pad = 18, Rmin = Math.max(56, H * 0.15);
        geo.cx = W / 2; geo.cy = H * 0.46; geo.fscale = 1;
        setGeo(Math.min(H * 0.6, W * 0.34) / 2);
        place("L"); place("R");
        let fits = true;
        for (let pass = 0; pass < 4; pass++) {
          const wide = Math.max(widest("L"), widest("R"));
          const reach = W / 2 - pad - wide;            // how far out the arc may sit
          const fitR = (reach - 14) / 1.17;
          if (fitR >= geo.R - 0.5) { fits = true; break; }
          fits = false;
          if (fitR >= Rmin) setGeo(fitR);
          else {
            setGeo(Rmin);
            geo.fscale *= clamp((W / 2 - pad - (Rmin * 1.17 + 14)) / Math.max(wide, 1), 0.55, 0.95);
          }
          place("L"); place("R");
        }
        if (!fits) {
          const wide = Math.max(widest("L"), widest("R"));
          fits = geo.cx - (geo.R * 1.17 + 14) - wide >= 0;
        }
        flat = !fits;
      }
      geo.flat = flat;
      orbit.classList.toggle("flat", flat);
      if (flat) flatten();
    }
    // room the headline and date box take at the bottom of the stage
    const dockSpace = () => ($(".dock", orbit)?.offsetHeight || 0) + 30;
    function place(side) {
      const keys = order[side], N = keys.length;
      const r = geo.R * 1.17 + 14;
      const H = orbit.clientHeight;
      // rows stay clear of the arc headers above and the headline below
      const span = Math.max(0, Math.min(r * 0.9, geo.cy - 44, H - dockSpace() - geo.cy));
      const W = orbit.clientWidth;
      const maxStep = (side === "L" ? o.maxStepL : o.maxStepR) * clamp(W / 1200, 1, 1.6);
      const step = N > 1 ? Math.min((2 * span) / (N - 1), maxStep) : 0;
      // text grows on big screens and shrinks when space is tight
      const top = side === "L" ? clamp(W / 100, 13, 20) : clamp(W / 120, 11.5, 17);
      const fs = clamp((N > 1 ? step : maxStep) * (side === "L" ? 0.6 : 0.74), 9.5, top) * geo.fscale;
      lists[side].style.setProperty("--fs", Math.max(fs, 7.5) + "px");
      let topY = null, topX = null;
      keys.forEach((k, i) => {
        const el = rows[side].get(k);
        if (!el) return;
        const dy = (i - (N - 1) / 2) * step;
        const dx = Math.sqrt(Math.max(0, r * r - dy * dy));
        const x = side === "L" ? geo.cx - dx : geo.cx + dx, y = geo.cy + dy;
        geo.anchors[side].set(k, [x, y, dy]);
        if (i === 0) { topY = y; topX = x; }
        const tf = side === "L" ? `translate(${x}px,${y}px) translate(-100%,-50%)` : `translate(${x}px,${y}px) translate(0,-50%)`;
        if (el._fresh) {
          el.style.transition = "none";
          el.style.transform = `translate(${geo.cx}px,${geo.cy}px) translate(-50%,-50%) scale(.4)`;
          el.style.opacity = "0";
          void el.offsetWidth;
          el.style.transition = "";
          el.style.transitionDelay = (reduced ? 0 : 0.25 + i * 0.03) + "s";
          el._fresh = false;
          setTimeout(() => (el.style.transitionDelay = ""), 1600 + i * 30);
        }
        el.style.transform = tf;
        el.style.opacity = "";
      });
      const h = heads[side];
      if (topY != null) {
        h.style.display = "";
        h.style.transform = side === "L" ? `translate(${topX - 40}px,${topY - 26}px) translate(-100%,0)` : `translate(${topX + 40}px,${topY - 26}px)`;
        h.style.left = "0"; h.style.top = "0";
      } else h.style.display = "none";
    }
    function update(side, items) {
      const seen = new Set();
      items.forEach((it) => {
        seen.add(it.key);
        let el = rows[side].get(it.key);
        if (!el) {
          el = document.createElement("div");
          el._fresh = true;
          rows[side].set(it.key, el);
          lists[side].appendChild(el);
        }
        const cls = `arc-row ${side} ${it.cls || ""}`.trim();
        if (el._cls !== cls) { el.className = cls + (el.classList.contains("hot") ? " hot" : ""); el._cls = cls; }
        if (el._html !== it.html) { el.innerHTML = it.html; el._html = it.html; }
        if (it.title) el.title = it.title;
      });
      for (const [k, el] of rows[side]) if (!seen.has(k)) { el.remove(); rows[side].delete(k); }
      order[side] = items.map((i) => i.key);
      if (geo.flat) order[side].forEach((k) => lists[side].appendChild(rows[side].get(k)));
      else place(side);
      // names or counts changed width: refit once both sides have settled
      cancelAnimationFrame(fitT);
      fitT = requestAnimationFrame(layout);
    }
    let fitT = 0;
    function hit(pairs) {
      core.classList.add("flare");
      const p = $(".ping", core);
      p.classList.remove("go"); void p.offsetWidth; p.classList.add("go");
      setTimeout(() => core.classList.remove("flare"), 1800);
      pairs.forEach(([side, key]) => {
        const el = rows[side].get(key);
        if (!el) return;
        el.classList.remove("hot"); void el.offsetWidth; el.classList.add("hot");
        setTimeout(() => el.classList.remove("hot"), 3300);
        if (geo.flat) return;
        const a = geo.anchors[side].get(key);
        if (!a) return;
        const [x, y, dy] = a;
        const ang = Math.asin(clamp(dy / (geo.R * 1.17 + 14), -1, 1));
        const ex = geo.cx + (side === "L" ? -1 : 1) * Math.cos(ang) * geo.R * 0.98, ey = geo.cy + Math.sin(ang) * geo.R * 0.98;
        const sx = x + (side === "L" ? 6 : -6);
        const mx = (sx + ex) / 2, my = (y + ey) / 2 - 10;
        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("d", `M${sx.toFixed(1)} ${y.toFixed(1)} Q${mx.toFixed(1)} ${my.toFixed(1)} ${ex.toFixed(1)} ${ey.toFixed(1)}`);
        links.appendChild(path);
        setTimeout(() => path.remove(), 3300);
      });
    }
    let rT;
    const ro = new ResizeObserver(() => { clearTimeout(rT); rT = setTimeout(layout, 60); });
    ro.observe(orbit);
    layout();
    return { update, hit, layout, gauge: (k, v, t) => GH.setGauge(orbit, k, v, t) };
  };

  /* ───────────── gauges ───────────── */
  const GC = 2 * Math.PI * 40, GV = GC * 0.75;
  GH.gaugeHTML = (g) => {
    const tk = Array.from({ length: 28 }, (_, i) => {
      const a = ((135 + (i * 270) / 27) * Math.PI) / 180;
      return `<line class="tk" x1="${(50 + Math.cos(a) * 45.5).toFixed(2)}" y1="${(50 + Math.sin(a) * 45.5).toFixed(2)}" x2="${(50 + Math.cos(a) * 47.5).toFixed(2)}" y2="${(50 + Math.sin(a) * 47.5).toFixed(2)}"/>`;
    }).join("");
    return `<div class="gauge" data-g="${esc(g.key)}" style="--gc:${g.color || "var(--ice)"}" role="img" aria-label="${esc(g.label)}">
      <svg viewBox="0 0 100 100">${tk}
        <circle class="trk" cx="50" cy="50" r="40" stroke-dasharray="${GV.toFixed(1)} ${GC.toFixed(1)}" transform="rotate(135 50 50)"/>
        <circle class="val" cx="50" cy="50" r="40" stroke-dasharray="${GV.toFixed(1)} ${GC.toFixed(1)}" stroke-dashoffset="${GV.toFixed(1)}" transform="rotate(135 50 50)"/>
      </svg><div class="gv"><b>0</b><small>${esc(g.label)}</small></div></div>`;
  };
  GH.setGauge = (root, key, v01, text) => {
    const g = $(`.gauge[data-g="${key}"]`, root);
    if (!g) return;
    $(".val", g).style.strokeDashoffset = (GV * (1 - clamp(v01 || 0, 0, 1))).toFixed(1);
    $(".gv b", g).textContent = text;
  };

  /* ───────────── signal strip (barcode of submissions per minute) ───────────── */
  GH.signal = function (canvas, buckets, opt = {}) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = canvas.clientWidth, H = canvas.clientHeight;
    if (!W || !H) return;
    if (canvas.width !== W * dpr || canvas.height !== H * dpr) { canvas.width = W * dpr; canvas.height = H * dpr; }
    const c = canvas.getContext("2d");
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(document.documentElement);
    const col = (n) => css.getPropertyValue(n).trim();
    const N = buckets.length || 1;
    const labelH = 14, mid = Math.round((H - labelH) * 0.62);
    const upMax = Math.max(3, ...buckets.map((b) => b.correct));
    const dnMax = Math.max(3, ...buckets.map((b) => b.wrong));
    const slot = W / N, bw = Math.max(1.5, Math.min(4, slot * 0.38));
    const k = opt.k == null ? 1 : opt.k;
    c.clearRect(0, 0, W, H);
    // baseline + quarter-hour grid
    c.fillStyle = col("--line-2");
    c.fillRect(0, mid, W, 1);
    c.font = `9px ${col("--f-mono")}`;
    c.textBaseline = "alphabetic";
    buckets.forEach((b, i) => {
      const x = i * slot + slot / 2;
      const d = new Date(b.t);
      if (d.getMinutes() % 15 === 0) {
        c.fillStyle = col("--line");
        c.fillRect(Math.round(x), 0, 1, H - labelH);
        c.fillStyle = col("--faint");
        c.fillText(pad2(d.getHours()) + ":" + pad2(d.getMinutes()), Math.min(W - 30, Math.max(0, x - 14)), H - 2);
      }
      // resting stub so quiet minutes still read as a live signal
      c.fillStyle = col("--faint");
      c.fillRect(x - bw / 2, mid - 2, bw, 2);
      const up = (b.correct / upMax) * (mid - 6) * k;
      const fbH = b.correct ? (b.fb / b.correct) * up : 0;
      c.fillStyle = col("--bone");
      c.fillRect(x - bw / 2, mid - up, bw, up - fbH);
      if (fbH) { c.fillStyle = col("--blood"); c.fillRect(x - bw / 2, mid - up, bw, fbH); }
      const dn = (b.wrong / dnMax) * (H - labelH - mid - 4) * k;
      c.fillStyle = col("--ice");
      c.globalAlpha = 0.85;
      c.fillRect(x - bw / 2, mid + 2, bw, dn);
      c.globalAlpha = 1;
    });
    // "now" cursor
    c.fillStyle = col("--blood");
    c.fillRect(W - 2, 0, 2, H - labelH);
  };
  GH.signalAnimated = function (canvas, buckets) {
    if (reduced || canvas._drawn) { GH.signal(canvas, buckets); return; }
    canvas._drawn = true;
    const t0 = performance.now();
    const step = (t) => {
      const k = Math.min(1, (t - t0) / 900);
      GH.signal(canvas, buckets, { k: 1 - Math.pow(1 - k, 3) });
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  };

  /* ───────────── score-over-time chart ───────────── */
  GH.PALETTE = ["#ff2b3d", "#7be3f2", "#e6e4de", "#ffc857", "#41d99a", "#b58cff", "#ff7ab6", "#5aa9ff"];
  GH.chart = function (box, data, opt = {}) {
    const players = (data.players || []).filter((p) => p.line && p.line.length);
    const sig = JSON.stringify(players) + "|" + box.clientWidth;
    if (box._sig === sig) return;
    box._sig = sig;
    if (!players.length) { box.innerHTML = `<div class="chart-empty">The chart starts with the first capture.</div>`; return; }
    const W = Math.max(300, box.clientWidth), H = opt.h || 260, pl = 40, pr = 118, pt = 14, pb = 26;
    let tmin = Infinity, tmax = GH.now(), ymax = 10;
    players.forEach((p) => p.line.forEach(([ts, v]) => { const t = +new Date(ts); tmin = Math.min(tmin, t); tmax = Math.max(tmax, t); ymax = Math.max(ymax, v); }));
    if (opt.since) tmin = Math.min(tmin, opt.since);
    if (tmax - tmin < 60000) tmin = tmax - 60000;
    const nice = (v) => { const p = Math.pow(10, Math.floor(Math.log10(v))); return Math.ceil(v / p / (v / p > 5 ? 2 : 1)) * p * (v / p > 5 ? 2 : 1); };
    ymax = nice(ymax);
    const X = (t) => pl + ((+new Date(t) - tmin) / (tmax - tmin)) * (W - pl - pr);
    const Y = (v) => H - pb - (v / ymax) * (H - pt - pb);
    let s = `<svg class="chart" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Score over time for the top ${players.length} operatives">`;
    for (let g = 0; g <= 4; g++) {
      const v = (ymax * g) / 4, y = Y(v);
      s += `<line x1="${pl}" x2="${W - pr}" y1="${y}" y2="${y}" style="stroke:var(--line)" stroke-width="1"/>`;
      s += `<text x="${pl - 8}" y="${y + 3}" text-anchor="end" font-size="10" style="fill:var(--dim);font-family:var(--f-mono)">${Math.round(v)}</text>`;
    }
    const span = tmax - tmin, stepMs = [5, 10, 15, 30, 60].map((m) => m * 60000).find((m) => span / m <= 7) || 3600000;
    for (let t = Math.ceil(tmin / stepMs) * stepMs; t <= tmax; t += stepMs) {
      const d = new Date(t), x = X(t);
      s += `<text x="${x}" y="${H - 8}" text-anchor="middle" font-size="10" style="fill:var(--faint);font-family:var(--f-mono)">${pad2(d.getHours())}:${pad2(d.getMinutes())}</text>`;
    }
    const ends = [];
    players.forEach((p, i) => {
      const c = GH.PALETTE[i % GH.PALETTE.length];
      let prev = 0, d = `M${X(p.line[0][0]).toFixed(1)} ${Y(0).toFixed(1)}`;
      p.line.forEach(([ts, v]) => { d += ` H${X(ts).toFixed(1)} V${Y(v).toFixed(1)}`; prev = v; });
      d += ` H${X(tmax).toFixed(1)}`;
      const len = 4000;
      s += `<path d="${d}" fill="none" stroke="${c}" stroke-width="${i === 0 ? 2.4 : 1.6}" stroke-linejoin="round" style="filter:drop-shadow(0 0 4px ${c}66);stroke-dasharray:${len};stroke-dashoffset:${reduced ? 0 : len};animation:draw 1.6s ${i * 0.08}s cubic-bezier(.2,.8,.2,1) forwards"/>`;
      ends.push({ y: Y(prev), c, name: p.name, pts: p.points });
    });
    ends.sort((a, b) => a.y - b.y);
    for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 13) ends[i].y = ends[i - 1].y + 13;
    ends.forEach((e) => {
      s += `<circle cx="${W - pr}" cy="${e.y}" r="3" fill="${e.c}"/>`;
      s += `<text x="${W - pr + 8}" y="${e.y + 3.5}" fill="${e.c}" font-size="10.5" style="font-family:var(--f-mono)">${esc(e.name.slice(0, 11))} ${e.pts}</text>`;
    });
    s += `</svg>`;
    box.innerHTML = s;
  };

  /* ───────────── toasts, modal, moment ───────────── */
  GH.toast = (msg, kind = "") => {
    let host = $(".toasts");
    if (!host) { host = document.createElement("div"); host.className = "toasts"; host.setAttribute("aria-live", "polite"); document.body.appendChild(host); }
    const t = document.createElement("div");
    t.className = "toast " + kind;
    t.innerHTML = `<i></i><div>${msg}</div>`;
    host.appendChild(t);
    while (host.children.length > 4) host.firstChild.remove();
    setTimeout(() => { t.classList.add("out"); setTimeout(() => t.remove(), 400); }, 4200);
  };
  GH.confirm = ({ title, body, ok = "Confirm", danger = true, type = "" }) =>
    new Promise((res) => {
      const m = document.createElement("div");
      m.className = "modal";
      m.innerHTML = `<div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="mdl-t">
        <h3 id="mdl-t">${esc(title)}</h3><p>${body}</p>
        ${type ? `<div class="field"><label for="mdl-in">Type ${esc(type)} to confirm</label><input id="mdl-in" class="inp" autocomplete="off"></div>` : ""}
        <div class="row"><button class="btn ghost" data-x>Cancel</button><button class="btn ${danger ? "red" : ""}" data-ok ${type ? "disabled" : ""}>${esc(ok)}</button></div></div>`;
      document.body.appendChild(m);
      const okb = $("[data-ok]", m), inp = $("#mdl-in", m);
      const done = (v) => { m.remove(); document.removeEventListener("keydown", key); res(v); };
      const key = (e) => { if (e.key === "Escape") done(false); };
      document.addEventListener("keydown", key);
      if (inp) { inp.focus(); inp.addEventListener("input", () => (okb.disabled = inp.value.trim() !== type)); }
      else okb.focus();
      m.addEventListener("click", (e) => { if (e.target === m || e.target.closest("[data-x]")) done(false); if (e.target.closest("[data-ok]") && !okb.disabled) done(true); });
    });
  GH.moment = ({ kind = "fb", small, big, line }) => {
    if (reduced) return;
    const m = document.createElement("div");
    m.className = "moment " + kind;
    m.innerHTML = `<div class="disc"></div><div class="txt"><small>${esc(small)}</small><b>${esc(big)}</b><span>${esc(line)}</span></div>`;
    document.body.appendChild(m);
    setTimeout(() => m.remove(), 2900);
  };

  /* ───────────── nav spy ───────────── */
  GH.navSpy = () => {
    const links = $$(".seg a[href^='#']");
    const map = new Map(links.map((a) => [a.getAttribute("href").slice(1), a]));
    const io = new IntersectionObserver((ents) => {
      ents.forEach((e) => { if (e.isIntersecting) { links.forEach((l) => l.classList.remove("on")); map.get(e.target.id)?.classList.add("on"); } });
    }, { rootMargin: "-40% 0px -55% 0px" });
    map.forEach((_, id) => { const s = document.getElementById(id); if (s) io.observe(s); });
  };

  GH.fmtAgo = (iso) => {
    if (!iso) return "—";
    const s = Math.max(0, Math.round((GH.now() - +new Date(iso)) / 1000));
    if (s < 60) return s + "s ago";
    if (s < 3600) return Math.floor(s / 60) + "m ago";
    return Math.floor(s / 3600) + "h " + Math.floor((s % 3600) / 60) + "m ago";
  };
  GH.hhmm = (iso) => { if (!iso) return "—"; const d = new Date(iso); return pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds()); };
  GH.diffPips = (diff) => ({ "very easy": 1, easy: 2, "easy-medium": 3, medium: 4, final: 5 }[diff] || 1);
})();
