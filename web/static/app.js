/* Browser app: one shell, routed by path. Talks only to the JSON API.
   Every dynamic value goes through esc() before it touches innerHTML. */
const GH = window.GH;
const { $, $$, esc, pad2 } = GH;

/* ───────────── API ───────────── */
let CSRF = "", ME = null, SITE = { name: "CTF" };

function errText(d, status) {
  if (d && typeof d.detail === "string") return d.detail;
  if (d && Array.isArray(d.detail))
    return d.detail.map((x) => {
      const f = Array.isArray(x.loc) ? x.loc[x.loc.length - 1] : "";
      return (f && f !== "body" ? f + ": " : "") + String(x.msg || "").replace(/^Value error, /, "");
    }).join("; ");
  if (status === 429) return "Too many requests. Wait a moment and try again.";
  if (status === 413) return "That file is too large.";
  return `Something went wrong (${status}).`;
}

async function api(method, path, body, form) {
  const opt = { method, headers: {}, credentials: "same-origin", cache: "no-store" };
  if (method !== "GET") opt.headers["X-CSRF-Token"] = CSRF;
  if (form) opt.body = form;
  else if (body !== undefined) { opt.headers["Content-Type"] = "application/json"; opt.body = JSON.stringify(body); }
  const r = await fetch(path, opt);
  let data = null;
  try { data = await r.json(); } catch (e) { /* empty body */ }
  if (!r.ok) { const e = new Error(errText(data, r.status)); e.status = r.status; throw e; }
  return data;
}
const GET = (p) => api("GET", p);
const POST = (p, b) => api("POST", p, b ?? {});
const PATCH = (p, b) => api("PATCH", p, b);
const DEL = (p) => api("DELETE", p);

async function loadMe() {
  try { const r = await GET("/api/auth/me"); ME = r.user; CSRF = r.csrf; }
  catch (e) { ME = null; CSRF = ""; }
}

/* ───────────── helpers ───────────── */
const toast = (t, kind = "") => GH.toast(esc(t), kind);
const confirmBox = (title, body, ok = "Confirm", danger = true) => GH.confirm({ title, body: esc(body), ok, danger });
const slugify = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
const fmtDate = (iso) => iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—";
const fmtSize = (n) => n < 1024 ? n + " B" : n < 1048576 ? (n / 1024).toFixed(1) + " KB" : (n / 1048576).toFixed(1) + " MB";
const toLocalInput = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
const fromLocalInput = (v) => (v ? new Date(v).toISOString() : null);
const qs = (k) => new URLSearchParams(location.search).get(k);

function setMsg(el, text, kind = "err") { if (!el) return; el.className = "msg " + kind; el.textContent = text || ""; }

/* Per-browser conveniences; private windows may refuse storage, which is fine. */
const store = {
  get(k, area = localStorage) { try { return area.getItem(k) || ""; } catch (e) { return ""; } },
  set(k, v, area = localStorage) { try { area.setItem(k, v); } catch (e) { /* not saved */ } },
};

/* ───────────── sound: the scoreboard's "yay" and "fahh", plus a chime ───────────── */
const SFX = (() => {
  const clips = { ok: "/static/sounds/correct.mp3", bad: "/static/sounds/wrong.mp3" };
  const audio = {};
  let on = store.get("gh_sfx") !== "off", actx = null;
  const clip = (k) => {
    if (!audio[k]) { audio[k] = new Audio(clips[k]); audio[k].preload = "auto"; audio[k].volume = 0.85; }
    return audio[k];
  };
  function chime() { // two short notes for hints and announcements
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      const t = actx.currentTime;
      [880, 1320].forEach((f, i) => {
        const o = actx.createOscillator(), g = actx.createGain(), at = t + i * 0.12;
        o.type = "sine"; o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, at);
        g.gain.exponentialRampToValueAtTime(0.22, at + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, at + 0.38);
        o.connect(g).connect(actx.destination);
        o.start(at); o.stop(at + 0.4);
      });
    } catch (e) { /* no audio here */ }
  }
  return {
    get on() { return on; },
    toggle() { on = !on; store.set("gh_sfx", on ? "on" : "off"); if (on) chime(); return on; },
    play(kind) {
      if (!on) return;
      if (kind === "ping") return chime();
      Object.values(audio).forEach((a) => { a.pause(); a.currentTime = 0; }); // never overlap the two
      const p = clip(kind).play();
      if (p && p.catch) p.catch(() => {}); // browsers block sound until the page has been clicked once
    },
  };
})();

/* ───────────── team alerts: what teammates and organisers just did ───────────── */
const NOTE = {
  solve: ["Teammate solved a challenge", "ok", (n) => `<b>${esc(n.actor)}</b> solved <b>${esc(n.subject)}</b>`],
  first_blood: ["First blood for your team", "ok", (n) => `<b>${esc(n.actor)}</b> drew first blood on <b>${esc(n.subject)}</b>`],
  hint: ["Hint unlocked", "ping", (n) => `<b>${esc(n.actor)}</b> unlocked a hint on <b>${esc(n.subject)}</b>`],
  penalty: ["Wrong flag", "bad", (n) => `<b>${esc(n.actor)}</b> submitted a wrong flag on <b>${esc(n.subject)}</b>`],
  lockout: ["Team locked out", "bad", (n) => `Too many wrong flags on <b>${esc(n.subject)}</b>. Your team can try it again in ${esc(n.text)}.`],
  attempts: ["No attempts left", "bad", (n) => `Your team has used every attempt on <b>${esc(n.subject)}</b>.`],
  award: ["Bonus points from the organisers", "ok", (n) => esc(n.text)],
  deduction: ["Points deducted by the organisers", "bad", (n) => esc(n.text)],
  instance_limit: ["Instance limit reached", "bad", (n) => esc(n.text)],
  announcement: ["Announcement from the organisers", "ping", (n) => esc(n.text)],
};
const OWN = new Set(["solve", "first_blood", "hint", "penalty", "lockout", "attempts"]); // the actor already saw these

function showNotice(n, withSound) {
  const k = NOTE[n.kind];
  if (!k) return;
  let host = $(".notes");
  if (!host) { host = document.createElement("div"); host.className = "notes"; host.setAttribute("aria-live", "polite"); document.body.appendChild(host); }
  const el = document.createElement("div");
  el.className = `note k-${n.kind} tone-${k[1]}`; // prefixed: the theme already styles .hint, .ping, .ok
  el.setAttribute("role", "status");
  const pts = n.points ? `<span class="np ${n.points > 0 ? "pos" : "neg"}">${n.points > 0 ? "+" : ""}${n.points}</span>` : "";
  el.innerHTML = `<div class="nt"><b>${k[0]}</b>${pts}<button class="nx" type="button" aria-label="Dismiss">×</button></div><div class="nb">${k[2](n)}</div>`;
  host.prepend(el);
  while (host.children.length > 4) host.lastElementChild.remove();
  const kill = () => { el.classList.add("out"); setTimeout(() => el.remove(), 350); };
  $(".nx", el).addEventListener("click", kill);
  setTimeout(kill, n.kind === "announcement" ? 15000 : 8000);
  if (withSound) SFX.play(k[1]);
  if (n.kind === "first_blood") GH.moment({ kind: "fb", small: "FIRST BLOOD", big: n.subject, line: `${n.actor} · +${n.points} pts` });
  window.dispatchEvent(new CustomEvent("gh:notice", { detail: n }));
}

/* Polls the event's notices every few seconds while you're on its pages. */
const watch = { slug: null, last: null, timer: 0, busy: false };
function watchNotices(slug) {
  if (!ME) return stopNotices();
  if (watch.slug === slug) return;
  stopNotices();
  watch.slug = slug;
  const saved = store.get("gh_n_" + slug, sessionStorage);
  watch.last = saved ? +saved : null;
  pollNotices();
  watch.timer = setInterval(pollNotices, 3000);
}
function stopNotices() { clearInterval(watch.timer); Object.assign(watch, { slug: null, last: null, timer: 0 }); }
async function pollNotices() {
  const slug = watch.slug;
  if (!slug || watch.busy || document.hidden) return;
  watch.busy = true;
  try {
    const r = await GET(`/api/events/${slug}/notices${watch.last == null ? "" : "?after=" + watch.last}`);
    if (slug !== watch.slug) return;
    const fresh = watch.last == null ? [] : r.notices.filter((n) => !(OWN.has(n.kind) && ME && n.actor === ME.username));
    watch.last = r.last;
    store.set("gh_n_" + slug, String(r.last), sessionStorage);
    fresh.forEach((n) => showNotice(n, false));
    // one sound per batch, the most serious one
    const kinds = new Set(fresh.map((n) => NOTE[n.kind]?.[1]));
    const sound = ["bad", "ok", "ping"].find((k) => kinds.has(k));
    if (sound) SFX.play(sound);
  } catch (e) { if (e.status === 401 || e.status === 404) stopNotices(); }
  finally { watch.busy = false; }
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) pollNotices(); });

/* Wire a <form> to an async handler with a busy button and a message line. */
function bindForm(form, handler) {
  const msg = $(".msg", form), btn = $("button[type=submit]", form);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    setMsg(msg, "");
    if (btn) btn.disabled = true;
    try {
      const data = Object.fromEntries(new FormData(form).entries());
      const out = await handler(data, form);
      if (typeof out === "string") setMsg(msg, out, "ok");
    } catch (err) { setMsg(msg, err.message, "err"); }
    finally { if (btn) btn.disabled = false; }
  });
}

/* Minimal, safe Markdown: the text is escaped first, then a few patterns are
   turned back into tags. Links must be http(s). */
function inline(t) {
  return t
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer nofollow">$1</a>');
}
function md(src) {
  const parts = String(src || "").replace(/\r\n/g, "\n").split("```");
  let out = "";
  parts.forEach((part, i) => {
    if (i % 2) { out += `<pre class="code"><code>${esc(part.replace(/^[\w-]*\n/, ""))}</code></pre>`; return; }
    part.split(/\n{2,}/).forEach((p) => {
      p = p.trim();
      if (!p) return;
      const h = p.match(/^#{1,3}\s+(.+)$/);
      if (h && !p.includes("\n")) out += `<h4>${inline(esc(h[1]))}</h4>`;
      else if (/^[-*]\s/.test(p)) out += "<ul>" + p.split("\n").map((l) => `<li>${inline(esc(l.replace(/^[-*]\s+/, "")))}</li>`).join("") + "</ul>";
      else out += `<p>${inline(esc(p)).replace(/\n/g, "<br>")}</p>`;
    });
  });
  return out || '<p class="muted">No description.</p>';
}

/* Event phase from its dates, using the server-synced clock. */
function phase(ev) {
  const now = GH.now();
  const s = ev.starts_at ? +new Date(ev.starts_at) : null, e = ev.ends_at ? +new Date(ev.ends_at) : null;
  if (ev.status === "draft") return "draft";
  if (ev.status === "archived") return "ended";
  if (s && now < s) return "upcoming";
  if (e && now > e) return "ended";
  return "live";
}
const PHASE_CHIP = { draft: ["paused", "Draft"], upcoming: ["demo", "Upcoming"], live: ["open", "Live"], ended: ["over", "Ended"] };
const phaseChip = (ev) => { const [c, t] = PHASE_CHIP[phase(ev)]; return `<span class="chip ${c}">${ev.paused && phase(ev) === "live" ? "Paused" : t}</span>`; };

/* ───────────── router ───────────── */
let leaving = [];
const onLeave = (fn) => leaving.push(fn);
function every(ms, fn) { const id = setInterval(fn, ms); onLeave(() => clearInterval(id)); }

const routes = [
  [/^\/$/, pageHome],
  [/^\/login$/, pageLogin],
  [/^\/register$/, pageRegister],
  [/^\/account$/, pageAccount],
  [/^\/dashboard$/, pageDashboard],
  [/^\/e\/([a-z0-9-]+)$/, pageEvent],
  [/^\/e\/([a-z0-9-]+)\/challenges$/, pageChallenges],
  [/^\/e\/([a-z0-9-]+)\/scoreboard$/, pageScoreboard],
  [/^\/manage\/([a-z0-9-]+)$/, pageManage],
];

function go(href) { history.pushState(null, "", href); render(); window.scrollTo(0, 0); }

async function render() {
  leaving.forEach((f) => { try { f(); } catch (e) { /* ignore */ } });
  leaving = [];
  $$(".modal").forEach((m) => m.remove());
  const path = location.pathname.replace(/\/+$/, "") || "/";
  const view = $("#view");
  view.innerHTML = '<div class="loading">Loading…</div>';
  if (!/^\/(e|manage)\//.test(path)) stopNotices();
  drawHeader(path);
  for (const [re, fn] of routes) {
    const m = path.match(re);
    if (!m) continue;
    try { await fn(view, ...m.slice(1)); }
    catch (e) { showError(view, e); }
    drawHeader(path);
    return;
  }
  showError(view, Object.assign(new Error("Page not found"), { status: 404 }));
}

function showError(view, e) {
  if (e.status === 401) { go("/login?next=" + encodeURIComponent(location.pathname)); return; }
  view.innerHTML = `<div class="narrow panel stack"><div class="sec-h"><h2>${e.status === 404 ? "Not found" : "Can't show this page"}</h2></div>
    <p class="muted">${esc(e.message)}</p><div><a class="btn ghost sm" href="/">Back to events</a></div></div>`;
}

let navEvent = null; // {slug, is_organiser} of the event being viewed, for the top nav
function drawHeader(path) {
  $("#siteName").textContent = SITE.name;
  document.title = SITE.name;
  const links = [["/", "Events"]];
  const m = path.match(/^\/(?:e|manage)\/([a-z0-9-]+)/);
  if (m && navEvent && navEvent.slug === m[1]) {
    const b = "/e/" + m[1];
    links.push([b, "Overview"], [b + "/challenges", "Challenges"], [b + "/scoreboard", "Scoreboard"]);
    if (navEvent.is_organiser) links.push(["/manage/" + m[1], "Manage"]);
  } else if (ME) links.push(["/dashboard", "Organise"]);
  $("#nav").innerHTML = links.map(([h, t]) => `<a href="${h}" class="${path === h ? "on" : ""}">${t}</a>`).join("");
  const snd = `<button class="snd ${SFX.on ? "on" : ""}" id="sndBtn" type="button" aria-pressed="${SFX.on}" title="${SFX.on ? "Sound on: click to mute alerts" : "Sound off: click to hear alerts"}">
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4z"/>${SFX.on ? '<path class="w" d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12"/>' : '<path class="w" d="M16.5 9.5l5 5m0-5l-5 5"/>'}</svg><span class="sr">${SFX.on ? "Sound on" : "Sound off"}</span></button>`;
  $("#who").innerHTML = snd + (ME
    ? `<a class="chip" href="/account" title="Your account">${esc(ME.username)}</a><button class="btn ghost sm" id="logout">Log out</button>`
    : `<a class="btn ghost sm" href="/login">Log in</a><a class="btn sm" href="/register">Sign up</a>`);
  $("#sndBtn").addEventListener("click", () => { SFX.toggle(); drawHeader(location.pathname.replace(/\/+$/, "") || "/"); });
  const lo = $("#logout");
  if (lo) lo.addEventListener("click", async () => { try { await POST("/api/auth/logout"); } catch (e) { /* already out */ } ME = null; CSRF = ""; stopNotices(); go("/"); });
}

document.addEventListener("click", (e) => {
  const a = e.target.closest("a[href]");
  if (!a || a.target || a.hasAttribute("download") || e.ctrlKey || e.metaKey || e.shiftKey || e.button) return;
  const href = a.getAttribute("href");
  if (!href.startsWith("/") || href.startsWith("/api/") || href.startsWith("/static/") || href.startsWith("//")) return;
  e.preventDefault();
  go(href);
});
window.addEventListener("popstate", render);

/* ───────────── slab clock (shared by event pages) ───────────── */
function slabHTML(title, sub, citiesHTML, n) {
  return `<div class="slab">
    <div class="slab-head"><i class="emb"></i><span>${esc(title)}</span><span class="t2">${esc(sub)}</span><span class="dots" aria-hidden="true"><i></i><i></i><i></i><i></i></span></div>
    <div class="slab-body">
      <div class="clock">
        <div class="clock-state" id="clockState"><b id="clockTag">…</b><span id="clockSub"></span></div>
        <div class="odo-labels" aria-hidden="true"><span>hours</span><span>minutes</span><span>seconds</span></div>
        <div class="odo" id="odo"></div>
        <div class="rail" id="rail" aria-hidden="true"><b></b><i></i></div>
      </div>
      <div class="cities" style="--n:${n};margin-left:auto">${citiesHTML}</div>
    </div></div>`;
}
const city = (label, id, value = "—", cls = "") => `<div class="city"><small>${esc(label)}</small><b id="${id}" class="${cls}">${esc(value)}</b></div>`;

/* Starts the rolling clock for an event: countdown to start, time left, or local time. */
function startClock(getEv) {
  const odo = GH.Odometer($("#odo"));
  let last = "";
  const tick = () => {
    const ev = getEv();
    if (!ev || !$("#odo")) return;
    const now = GH.now(), ph = phase(ev);
    const s = ev.starts_at ? +new Date(ev.starts_at) : null, e = ev.ends_at ? +new Date(ev.ends_at) : null;
    let digits, tag, sub, over = false, frac = null;
    if (ev.home) {
      const d = new Date(now); digits = pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
      tag = "Local time"; sub = d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
    } else if (ph === "upcoming") {
      digits = GH.hms(s - now); tag = "Starts in";
      const days = Math.floor((s - now) / 86400000);
      sub = days >= 4 ? `${days} days to go · ${fmtDate(ev.starts_at)}` : fmtDate(ev.starts_at);
    } else if (ph === "ended") {
      digits = "000000"; tag = "Event over"; sub = "submissions are closed"; over = true; frac = 1;
    } else if (ph === "draft") {
      const d = new Date(now); digits = pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
      tag = "Draft"; sub = "only organisers can see this event";
    } else if (e) {
      digits = GH.hms(e - now); tag = ev.paused ? "Paused" : "Time left";
      sub = ev.paused ? "the organisers paused submissions" : "until submissions close";
      if (s) frac = GH.clamp((now - s) / (e - s), 0, 1);
    } else {
      const d = new Date(now); digits = pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
      tag = ev.paused ? "Paused" : "Live"; sub = ev.paused ? "the organisers paused submissions" : "no end time set";
    }
    if (digits !== last) { odo.set(digits, `${tag}: ${digits.slice(0, 2)}:${digits.slice(2, 4)}:${digits.slice(4)}`); last = digits; }
    $("#clockTag").textContent = tag;
    $("#clockSub").textContent = sub;
    $("#clockState").classList.toggle("over", over);
    const rail = $("#rail");
    rail.hidden = frac == null;
    if (frac != null) { $("b", rail).style.width = frac * 100 + "%"; $("i", rail).style.left = frac * 100 + "%"; }
  };
  tick();
  every(250, tick);
}

/* ───────────── boot ───────────── */
(async function boot() {
  try { SITE = await GET("/api/site"); } catch (e) { /* default name */ }
  await loadMe();
  render();
})();

/* PAGES */

/* ───────────── auth ───────────── */
function afterLogin(r) {
  ME = r.user; CSRF = r.csrf;
  const next = qs("next");
  go(next && next.startsWith("/") && !next.startsWith("//") ? next : "/");
}

async function pageLogin(view) {
  view.innerHTML = `<div class="narrow panel">
    <div class="sec-h"><h2>Log in</h2><span>New here? <a class="lnk" href="/register${location.search}">Create an account</a></span></div>
    <form class="form" novalidate>
      <div class="field"><label for="em">Email</label><input class="inp" id="em" name="email" type="email" autocomplete="email" required></div>
      <div class="field"><label for="pw">Password</label><input class="inp" id="pw" name="password" type="password" autocomplete="current-password" required></div>
      <div class="field"><label for="tf">2FA code <span class="muted">(only if you turned it on)</span></label><input class="inp" id="tf" name="totp" autocomplete="one-time-code" maxlength="16" spellcheck="false" autocapitalize="off">
        <p class="help">Lost your phone? Type one of your recovery codes here instead.</p></div>
      <button class="btn red" type="submit">Log in</button>
      <div class="msg" role="status"></div>
    </form></div>`;
  bindForm($("form", view), async (d) => {
    const body = { email: d.email.trim(), password: d.password };
    if (d.totp.trim()) body.totp = d.totp.trim();
    const r = await POST("/api/auth/login", body);
    if (r.recovery_codes_left != null)
      toast(`You used a recovery code. ${r.recovery_codes_left} left. Make new ones on your Account page.`, r.recovery_codes_left <= 3 ? "err" : "");
    afterLogin(r);
  });
  $("#em").focus();
}

async function pageRegister(view) {
  view.innerHTML = `<div class="narrow panel">
    <div class="sec-h"><h2>Create an account</h2><span>Have one? <a class="lnk" href="/login${location.search}">Log in</a></span></div>
    <form class="form" novalidate>
      <div class="field"><label for="em">Email</label><input class="inp" id="em" name="email" type="email" autocomplete="email" required></div>
      <div class="field"><label for="un">Username</label><input class="inp" id="un" name="username" autocomplete="username" maxlength="32" required>
        <p class="help">3–32 letters, digits or underscores. Shown on team lists.</p></div>
      <div class="field"><label for="pw">Password</label><input class="inp" id="pw" name="password" type="password" autocomplete="new-password" minlength="10" required>
        <p class="help">At least 10 characters.</p></div>
      <div class="field"><label for="pw2">Repeat password</label><input class="inp" id="pw2" name="password2" type="password" autocomplete="new-password" required></div>
      <button class="btn red" type="submit">Create account</button>
      <div class="msg" role="status"></div>
    </form></div>`;
  bindForm($("form", view), async (d) => {
    if (d.password !== d.password2) throw new Error("The passwords don't match.");
    afterLogin(await POST("/api/auth/register", { email: d.email.trim(), username: d.username.trim(), password: d.password }));
  });
  $("#em").focus();
}

/* What the security log entries mean, in words. */
const ACTIVITY = {
  register: "Account created", login: "Logged in", login_failed: "Failed login attempt",
  "2fa_on": "Two-factor login turned on", "2fa_off": "Two-factor login turned off",
  recovery_codes_new: "New recovery codes made", password_changed: "Password changed",
  password_change_failed: "Wrong current password typed", sessions_revoked: "Logged out other browsers",
  session_revoked: "Logged out a browser", org_created: "Created an organisation", org_member_added: "Added an organiser",
};
const WARN_ACTS = new Set(["login_failed", "password_change_failed", "2fa_off"]);

/* "Chrome on Windows" from a user-agent string; only for display. */
function device(ua) {
  ua = ua || "";
  const b = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox"
    : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : /curl|python|httpx|go-http|wget/i.test(ua) ? "Script" : "Browser";
  const os = /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Windows/.test(ua) ? "Windows"
    : /Mac OS X/.test(ua) ? "macOS" : /CrOS/.test(ua) ? "ChromeOS" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${b} on ${os}` : b;
}

/* Shows fresh recovery codes once, with copy and download. */
function showRecoveryCodes(box, codes, done) {
  box.innerHTML = `<div class="sec-h"><h2>Save your recovery codes</h2></div>
    <p class="msg warn">If you lose your phone, each code lets you log in once in place of an app code. This is the only time they're shown.</p>
    <div class="rc-grid">${codes.map((c) => `<code>${esc(c)}</code>`).join("")}</div>
    <div class="row"><button class="btn ghost sm" id="rcCopy" type="button">Copy</button>
      <button class="btn ghost sm" id="rcSave" type="button">Download .txt</button>
      <button class="btn red sm" id="rcDone" type="button">I've saved them</button></div>`;
  const text = `${SITE.name} recovery codes for ${ME.email}\nEach code works once.\n\n${codes.join("\n")}\n`;
  $("#rcCopy").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(text); toast("Copied.", "ok"); } catch (e) { toast("Your browser blocked copying. Select the codes instead.", "err"); }
  });
  $("#rcSave").addEventListener("click", () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    a.download = "recovery-codes.txt";
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  $("#rcDone").addEventListener("click", done);
}

async function pageAccount(view) {
  navEvent = null;
  if (!ME) throw Object.assign(new Error("Log in first"), { status: 401 });
  const me = await GET("/api/auth/me");
  ME = me.user; CSRF = me.csrf;
  const left = me.recovery_codes_left, mustMfa = SITE.organiser_mfa === "required";
  view.innerHTML = `
    <div class="ph"><h1><small>Account</small>${esc(ME.username)}</h1></div>
    <section class="panel"><div class="me-stats">
      <div><small>Username</small><b>${esc(ME.username)}</b></div>
      <div><small>Email</small><b class="sm">${esc(ME.email)}</b></div>
      <div><small>Two-factor</small><b class="${ME.totp_enabled ? "ok" : "red"}">${ME.totp_enabled ? "On" : "Off"}</b></div>
      <div><small>Recovery codes</small><b class="${ME.totp_enabled && left <= 3 ? "red" : ""}">${ME.totp_enabled ? left : "—"}</b></div>
    </div></section>
    <div class="cols acct">
      <div class="stack"><section class="panel stack" id="tfa"></section><section class="panel stack" id="pwBox"></section></div>
      <div class="stack"><section class="panel stack" id="sessBox"></section><section class="panel stack" id="actBox"></section></div>
    </div>`;

  /* two-factor login */
  const box = $("#tfa");
  if (ME.totp_enabled) {
    box.innerHTML = `<div class="sec-h"><h2>Two-factor login</h2><span class="pill published">On</span></div>
      <p class="muted">Every login asks for a code from your authenticator app as well as your password. You have ${left} unused recovery code${left === 1 ? "" : "s"}.</p>
      ${left <= 3 ? '<p class="msg warn">You are running low on recovery codes. Make new ones below.</p>' : ""}
      <details><summary class="btn ghost sm">Make new recovery codes</summary>
        <form class="form" id="rcForm" novalidate><div class="field"><label for="rcc">Code from your app</label>
          <input class="inp" id="rcc" name="code" inputmode="numeric" maxlength="6" autocomplete="one-time-code" required></div>
          <p class="help">Your old recovery codes stop working.</p>
          <div><button class="btn" type="submit">Make new codes</button></div><div class="msg" role="status"></div></form></details>
      <details><summary class="btn ghost sm">Turn off 2FA</summary>
        <form class="form" id="offForm" novalidate>
          <div class="field"><label for="ofp">Password</label><input class="inp" id="ofp" name="password" type="password" autocomplete="current-password" required></div>
          <div class="field"><label for="ofc">Code from your app, or a recovery code</label><input class="inp" id="ofc" name="code" maxlength="16" autocomplete="one-time-code" required></div>
          ${mustMfa ? '<p class="msg warn">While 2FA is off you can\'t create or manage events.</p>' : ""}
          <div><button class="btn red" type="submit">Turn off 2FA</button></div><div class="msg" role="status"></div></form></details>`;
    bindForm($("#rcForm"), async (d) => {
      const r = await POST("/api/auth/2fa/recovery-codes", { code: d.code.trim() });
      showRecoveryCodes(box, r.recovery_codes, () => render());
    });
    bindForm($("#offForm"), async (d) => {
      const r = await POST("/api/auth/2fa/disable", { password: d.password, code: d.code.trim() });
      ME = r.user;
      toast("Two-factor login is off. Other browsers were logged out.", "ok");
      render();
    });
  } else {
    box.innerHTML = `<div class="sec-h"><h2>Two-factor login</h2><span class="pill draft">Off</span></div>
      <p class="muted">After your password you also type a 6-digit code from an app on your phone, so a stolen password alone can't get in.
        ${mustMfa ? "<b>Organisers need this before they can create or manage events.</b>" : ""}</p>
      <div><button class="btn red" id="tfaStart" type="button">Set up 2FA</button></div><div id="tfaStep"></div>`;
    $("#tfaStart").addEventListener("click", async () => {
      try {
        const r = await POST("/api/auth/2fa/setup");
        $("#tfaStart").hidden = true;
        $("#tfaStep").innerHTML = `<div class="form">
          <ol class="steps"><li>Open an authenticator app: Google Authenticator, Microsoft Authenticator, Authy, Aegis or 2FAS.</li>
            <li>Scan the QR code, or type the key in by hand.</li><li>Type the 6-digit code the app shows.</li></ol>
          <div class="qr-row"><img class="qr" src="${esc(r.qr)}" alt="QR code to scan with your authenticator app" width="200" height="200">
            <div class="grow field"><label>Key</label><div class="code-box">${esc(r.secret.match(/.{1,4}/g).join(" "))}</div>
              <p class="help">Time-based, 6 digits, 30 seconds.</p></div></div>
          <form class="form" novalidate><div class="field"><label for="tc">Code from the app</label>
            <input class="inp" id="tc" name="code" inputmode="numeric" maxlength="6" autocomplete="one-time-code" required></div>
          <div><button class="btn red" type="submit">Turn on 2FA</button></div><div class="msg" role="status"></div></form></div>`;
        bindForm($("#tfaStep form"), async (d) => {
          const out = await POST("/api/auth/2fa/enable", { code: d.code.trim() });
          ME = out.user; CSRF = out.csrf; // other browsers were logged out; this one has a fresh session
          showRecoveryCodes(box, out.recovery_codes, () => render());
          toast("Two-factor login is on.", "ok");
        });
        $("#tc").focus();
      } catch (e) { toast(e.message, "err"); }
    });
  }

  /* password */
  $("#pwBox").innerHTML = `<div class="sec-h"><h2>Change password</h2><span>Other browsers are logged out</span></div>
    <form class="form" id="pwForm" novalidate>
      <div class="field"><label for="pwc">Current password</label><input class="inp" id="pwc" name="current" type="password" autocomplete="current-password" required></div>
      <div class="two"><div class="field"><label for="pwn">New password</label><input class="inp" id="pwn" name="new" type="password" autocomplete="new-password" minlength="10" required></div>
        <div class="field"><label for="pwr">Repeat new password</label><input class="inp" id="pwr" name="again" type="password" autocomplete="new-password" required></div></div>
      <p class="help">At least 10 characters, not a common password, and without your username or email.</p>
      <div><button class="btn" type="submit">Change password</button></div><div class="msg" role="status"></div></form>`;
  bindForm($("#pwForm"), async (d, f) => {
    if (d.new !== d.again) throw new Error("The new passwords don't match.");
    await POST("/api/auth/password", { current: d.current, new: d.new });
    f.reset();
    drawSessions();
    return "Password changed. Other browsers were logged out.";
  });

  /* sessions */
  const sess = $("#sessBox");
  sess.innerHTML = `<div class="sec-h"><h2>Where you're logged in</h2><button class="btn ghost sm" id="endAll" type="button">Log out everywhere else</button></div>
    <div class="adm-list" id="sessList"></div>`;
  async function drawSessions() {
    const rows = await GET("/api/auth/sessions");
    $("#sessList").innerHTML = rows.map((s) => `<div class="adm-item"><div class="grow">
        <div class="t1">${esc(device(s.user_agent))} ${s.current ? '<span class="pill published">This browser</span>' : ""}</div>
        <div class="t2">IP ${esc(s.ip || "unknown")} · logged in ${esc(fmtDate(s.created))} · last active ${esc(fmtDate(s.last_seen))}</div></div>
        ${s.current ? "" : `<button class="btn ghost sm" type="button" data-end="${s.id}">Log out</button>`}</div>`).join("");
    $("#endAll").disabled = rows.length < 2;
  }
  sess.addEventListener("click", async (e) => {
    const one = e.target.closest("[data-end]");
    try {
      if (one) { await DEL("/api/auth/sessions/" + one.dataset.end); toast("Logged out that browser.", "ok"); }
      else if (e.target.closest("#endAll")) {
        if (!(await confirmBox("Log out everywhere else?", "Every other browser and device using your account will have to log in again.", "Log them out"))) return;
        const r = await POST("/api/auth/sessions/revoke-others");
        toast(`Logged out ${r.ended} other session${r.ended === 1 ? "" : "s"}.`, "ok");
      } else return;
      drawSessions(); drawActivity();
    } catch (err) { toast(err.message, "err"); }
  });

  /* activity */
  $("#actBox").innerHTML = `<div class="sec-h"><h2>Recent security activity</h2></div>
    <p class="help">See something you don't recognise? Change your password, then log out everywhere else.</p>
    <div class="adm-list act" id="actList"></div>`;
  async function drawActivity() {
    const rows = await GET("/api/auth/activity");
    $("#actList").innerHTML = rows.length ? rows.map((a) => `<div class="adm-item ${WARN_ACTS.has(a.action) ? "warn" : ""}"><div class="grow">
        <div class="t1">${esc(ACTIVITY[a.action] || a.action)}${a.detail ? ` <span class="muted">· ${esc(a.detail)}</span>` : ""}</div>
        <div class="t2">${esc(fmtDate(a.at))} · IP ${esc(a.ip || "unknown")}</div></div></div>`).join("")
      : '<div class="empty">Nothing yet.</div>';
  }
  await Promise.all([drawSessions(), drawActivity()]);
}

/* ───────────── home: events ───────────── */
async function pageHome(view) {
  navEvent = null;
  const events = await GET("/api/events");
  view.innerHTML = `
    <section class="event hero">${slabHTML(SITE.name, "Capture the flag events", "", 0)}</section>
    <section class="stack">
      <div class="sec-h"><h2>Events</h2><span>${events.length ? events.length + " published" : ""}</span>
        <span class="r">${ME ? '<a class="btn ghost sm" href="/dashboard">Host an event</a>' : '<a class="btn ghost sm" href="/register?next=/dashboard">Host an event</a>'}</span></div>
      <div class="ev-grid" id="evs"></div>
    </section>`;
  // the hero swaps the city row for a short pitch
  $(".hero .cities").outerHTML = `<div class="hero-txt"><h1>Hack. Capture. Climb.</h1>
    <p>Join a team, solve challenges across web, crypto, forensics, reversing and pwn, and watch the board move live.</p>
    <div class="row"><a class="btn ink" href="#evs">Browse events</a>${ME ? "" : '<a class="btn ink-ghost" href="/register">Create an account</a>'}</div></div>`;
  startClock(() => ({ home: true }));
  const grid = $("#evs");
  if (!events.length) { grid.outerHTML = '<div class="empty">No events are open yet. Check back soon.</div>'; return; }
  const order = { live: 0, upcoming: 1, ended: 2, draft: 3 };
  events.sort((a, b) => order[phase(a)] - order[phase(b)]);
  grid.innerHTML = events.map((ev) => `<a class="ev-card" href="/e/${esc(ev.slug)}">
      <div class="row"><span class="org">${esc(ev.org.name)}</span><span class="grow"></span>${phaseChip(ev)}</div>
      <h3>${esc(ev.title)}</h3>
      <div class="when">${ev.starts_at ? esc(fmtDate(ev.starts_at)) : "Open now"}${ev.ends_at ? " → " + esc(fmtDate(ev.ends_at)) : ""}</div>
      <div class="when">Teams of up to ${ev.max_team_size}${ev.registration_open ? "" : " · registration closed"}</div></a>`).join("");
}

/* ───────────── event overview + team signup ───────────── */
async function loadEvent(slug) {
  const ev = await GET("/api/events/" + slug);
  GH.syncClock(ev.server_time);
  navEvent = { slug, is_organiser: ev.is_organiser };
  watchNotices(slug);
  return ev;
}

async function myTeam(slug) {
  if (!ME) return null;
  try { return await GET(`/api/events/${slug}/teams/me`); } catch (e) { if (e.status === 404) return null; throw e; }
}

async function pageEvent(view, slug) {
  const ev = await loadEvent(slug);
  const [teams, team, anns] = await Promise.all([GET(`/api/events/${slug}/teams`), myTeam(slug), GET(`/api/events/${slug}/announcements`).catch(() => [])]);
  const ph = phase(ev);
  const rules = [];
  if (ev.first_blood_bonus) rules.push(`The first team to solve a challenge gets <b>+${ev.first_blood_bonus}</b> points.`);
  if (ev.lockout_threshold) rules.push(`<b>${ev.lockout_threshold}</b> wrong flags on one challenge locks your team out of it for <b>${ev.lockout_minutes} min</b>.`);
  if (ev.wrong_penalty) rules.push(`Every wrong flag costs <b>${ev.wrong_penalty}</b> points.`);
  view.innerHTML = `
    <section class="event">${slabHTML(ev.title, ev.org.name,
      city("Teams", "cT", String(teams.length)) + city("Team size", "cS", "≤ " + ev.max_team_size) +
      city("Starts", "cA", ev.starts_at ? fmtDate(ev.starts_at) : "Open") + city("Ends", "cB", ev.ends_at ? fmtDate(ev.ends_at) : "—", "red"), 4)}</section>
    <section class="cols">
      <div class="panel stack"><div class="sec-h"><h2>About</h2><span class="r">${phaseChip(ev)}</span></div><div class="desc">${md(ev.description)}</div>
        ${rules.length ? `<div class="rules"><h4>Rules</h4><ul>${rules.map((r) => `<li>${r}</li>`).join("")}</ul></div>` : ""}
        ${anns.length ? `<div class="anns"><h4>Announcements</h4>${anns.slice(0, 5).map((a) => `<div class="ann"><time>${esc(fmtDate(a.at))}</time><span>${esc(a.text)}</span></div>`).join("")}</div>` : ""}
        <div class="row"><a class="btn ghost sm" href="/e/${esc(slug)}/challenges">Challenges</a><a class="btn ghost sm" href="/e/${esc(slug)}/scoreboard">Scoreboard</a>
        ${ev.is_organiser ? `<a class="btn sm" href="/manage/${esc(slug)}">Manage event</a>` : ""}</div></div>
      <div class="panel stack" id="teamBox"></div>
    </section>`;
  startClock(() => ev);
  const box = $("#teamBox");
  const open = ev.registration_open && ph !== "ended" && ph !== "draft";

  if (ev.is_organiser) {
    box.innerHTML = `<div class="sec-h"><h2>You're organising</h2></div><p class="muted">Organisers can preview challenges but can't join teams or submit flags in their own event.</p>`;
    return;
  }
  if (!ME) {
    box.innerHTML = `<div class="sec-h"><h2>Play</h2></div><p class="muted">Log in or create an account, then create a team or join one with its code.</p>
      <div class="row"><a class="btn red" href="/register?next=/e/${esc(slug)}">Sign up</a><a class="btn ghost" href="/login?next=/e/${esc(slug)}">Log in</a></div>`;
    return;
  }
  if (team) {
    box.innerHTML = `<div class="sec-h"><h2>Your team</h2><span>${team.members.length}/${ev.max_team_size} members</span></div>
      <div class="me-stats"><div><small>Team</small><b>${esc(team.name)}</b></div><div><small>Members</small><b>${team.members.length}</b></div></div>
      <p class="muted">${team.members.map(esc).join(" · ")}</p>
      <div class="field"><label>Invite code (share only with teammates)</label><div class="code-box" id="jc">${esc(team.join_code)}</div></div>
      <div class="row"><a class="btn red" href="/e/${esc(slug)}/challenges">Go to challenges</a><button class="btn ghost sm" id="leave">Leave team</button></div>`;
    $("#leave").addEventListener("click", async () => {
      if (!(await confirmBox("Leave team?", `You'll leave ${team.name}. If you're the last member the team is deleted.`, "Leave"))) return;
      try { await POST(`/api/events/${slug}/teams/leave`); go(location.pathname); } catch (e) { toast(e.message, "err"); }
    });
    return;
  }
  if (!open) {
    box.innerHTML = `<div class="sec-h"><h2>Registration closed</h2></div><p class="muted">This event isn't taking new teams.</p>`;
    return;
  }
  box.innerHTML = `<div class="sec-h"><h2>Join the event</h2><span>Create a team, or join one with its invite code.</span></div>
    <form class="form" id="mk" novalidate><div class="field"><label for="tn">New team name</label><input class="inp" id="tn" name="name" maxlength="40" required></div>
      <button class="btn red" type="submit">Create team</button><div class="msg" role="status"></div></form>
    <form class="form" id="jn" novalidate><div class="field"><label for="jcode">Invite code</label><input class="inp" id="jcode" name="code" maxlength="32" autocomplete="off" spellcheck="false" required></div>
      <button class="btn ghost" type="submit">Join team</button><div class="msg" role="status"></div></form>`;
  bindForm($("#mk"), async (d) => { await POST(`/api/events/${slug}/teams`, { name: d.name.trim() }); go(location.pathname); });
  bindForm($("#jn"), async (d) => { await POST(`/api/events/${slug}/teams/join`, { code: d.code.trim() }); go(location.pathname); });
}

/* ───────────── challenge board ───────────── */
async function pageChallenges(view, slug) {
  const ev = await loadEvent(slug);
  if (!ME) throw Object.assign(new Error("Log in first"), { status: 401 });
  let chals;
  try { chals = await GET(`/api/events/${slug}/challenges`); }
  catch (e) {
    if (e.status !== 403) throw e;
    view.innerHTML = `<section class="event">${slabHTML(ev.title, ev.org.name, "", 0)}</section>
      <div class="panel stack"><div class="sec-h"><h2>Challenges</h2></div><p class="muted">${esc(e.message)}</p>
      <div><a class="btn ghost sm" href="/e/${esc(slug)}">Back to the event</a></div></div>`;
    startClock(() => ev);
    return;
  }
  const team = ev.is_organiser ? null : await myTeam(slug);
  view.innerHTML = `
    <section class="event">${slabHTML(ev.title, ev.org.name,
      city("Team", "cTeam", team ? team.name : "Preview") + city("Score", "cScore", "0", "red") + city("Rank", "cRank", "—") + city("Solved", "cSolved", "0"), 4)}</section>
    ${ev.is_organiser ? '<p class="help">Organiser preview: you see what players see, but can\'t submit.</p>' : ""}
    <div id="board" class="stack"></div>`;
  startClock(() => ev);

  async function refresh() {
    chals = await GET(`/api/events/${slug}/challenges`);
    draw();
    if (!team) return;
    const sb = await GET(`/api/events/${slug}/scoreboard`);
    const me = sb.standings.find((r) => r.team === team.name);
    GH.count($("#cScore"), me ? me.score : 0);
    $("#cRank").textContent = me ? "#" + me.rank : "—";
  }
  function draw() {
    $("#cSolved").textContent = `${chals.filter((c) => c.solved).length}/${chals.length}`;
    const board = $("#board");
    if (!chals.length) { board.innerHTML = '<div class="empty">No challenges are visible yet.</div>'; return; }
    const cats = {};
    chals.forEach((c) => (cats[c.category] ||= []).push(c));
    board.innerHTML = Object.keys(cats).sort().map((cat) => `<section class="cat"><h3>${esc(cat)}</h3><div class="ch-grid">
      ${cats[cat].map((c) => `<button class="ch ${c.solved ? "solved" : ""} ${c.locked ? "locked" : ""}" data-id="${c.id}" ${c.locked ? 'aria-disabled="true" title="Solve the required challenges first"' : ""}>
        <b>${esc(c.name)}</b><span class="v">${c.value}</span><span class="s"><span>${c.solves} solve${c.solves === 1 ? "" : "s"}</span><span>${c.solved ? "✓ solved" : c.locked ? "locked" : ""}</span></span></button>`).join("")}
      </div></section>`).join("");
  }
  $("#board").addEventListener("click", (e) => {
    const b = e.target.closest(".ch");
    if (!b || b.classList.contains("locked")) return;
    openChallenge(slug, +b.dataset.id, !!team, refresh);
  });
  draw();
  refresh();
  every(30000, () => refresh().catch(() => {}));
  const onNote = () => refresh().catch(() => {});
  window.addEventListener("gh:notice", onNote);
  onLeave(() => window.removeEventListener("gh:notice", onNote));
}

async function openChallenge(slug, id, canPlay, onChange) {
  let c;
  try { c = await GET(`/api/events/${slug}/challenges/${id}`); } catch (e) { toast(e.message, "err"); return; }
  const m = document.createElement("div");
  m.className = "modal";
  m.innerHTML = `<div class="modal-card wide" role="dialog" aria-modal="true" aria-labelledby="chT">
    <div class="mh"><div class="stack" style="gap:8px"><span class="tags"><span class="chip cat-chip">${esc(c.category)}</span>${c.solved ? '<span class="chip open">Solved</span>' : ""}</span>
      <h3 id="chT">${esc(c.name)}</h3><span class="muted">${c.value} points · ${c.solves} solve${c.solves === 1 ? "" : "s"}${c.max_attempts ? ` · ${c.attempts}/${c.max_attempts} attempts used` : ""}</span></div>
      <button class="btn ghost sm x" data-x aria-label="Close">Close</button></div>
    <div class="desc">${md(c.description)}</div>
    ${c.files.length ? `<div class="files">${c.files.map((f) => `<a class="file" href="/api/events/${esc(slug)}/files/${f.id}" download>⬇ ${esc(f.filename)}<small>${fmtSize(f.size)}</small></a>`).join("")}</div>` : ""}
    ${c.hints.length ? `<div class="hints">${c.hints.map((h, i) => h.unlocked
      ? `<div class="hint open"><b>Hint ${i + 1}</b><span class="grow">${esc(h.content)}</span></div>`
      : `<div class="hint"><b>Hint ${i + 1}</b><span class="grow muted">Costs ${h.cost} points</span>${canPlay ? `<button class="btn ghost sm" data-hint="${h.id}" data-cost="${h.cost}">Unlock</button>` : ""}</div>`).join("")}</div>` : ""}
    ${canPlay && !c.solved ? `<form class="flagform" novalidate><input class="inp" name="flag" placeholder="Flag" autocomplete="off" spellcheck="false" autocapitalize="off" maxlength="256" aria-label="Flag">
      <button class="btn red" type="submit">Submit</button></form><div class="msg" role="status" id="fmsg"></div>` : ""}
    <details><summary class="muted">Solved by</summary><div id="solvers" class="sub-list"></div></details></div>`;
  document.body.appendChild(m);
  const close = () => { m.remove(); document.removeEventListener("keydown", key); };
  const key = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", key);
  onLeave(close);
  m.addEventListener("click", async (e) => {
    if (e.target === m || e.target.closest("[data-x]")) return close();
    const hb = e.target.closest("[data-hint]");
    if (hb) {
      if (!(await confirmBox("Unlock hint?", `This costs your team ${hb.dataset.cost} points.`, "Unlock", false))) return;
      try { await POST(`/api/events/${slug}/hints/${hb.dataset.hint}/unlock`); close(); onChange(); openChallenge(slug, id, canPlay, onChange); }
      catch (err) { toast(err.message, "err"); }
    }
  });
  $("details", m).addEventListener("toggle", async (e) => {
    if (!e.target.open || e.target._loaded) return;
    e.target._loaded = true;
    try {
      const rows = await GET(`/api/events/${slug}/challenges/${id}/solves`);
      $("#solvers", m).innerHTML = rows.length ? rows.map((r, i) => `<div class="sub-item"><b>${i + 1}</b><span class="grow">${esc(r.team)}</span>${i === 0 ? '<span class="fbm">first blood</span>' : ""}<span class="muted">${esc(GH.hhmm(r.at))}</span></div>`).join("") : '<p class="muted">Nobody yet.</p>';
    } catch (err) { $("#solvers", m).textContent = err.message; }
  });
  const f = $("form", m);
  if (!f) return;
  const inp = $("input", f);
  inp.focus();
  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const flag = inp.value.trim();
    if (!flag) return;
    const btn = $("button", f);
    btn.disabled = true;
    try {
      const r = await POST(`/api/events/${slug}/challenges/${id}/attempt`, { flag });
      if (r.correct) {
        close();
        SFX.play("ok");
        GH.moment(r.first_blood ? { kind: "fb", small: "FIRST BLOOD", big: c.name, line: `your team drew first blood · +${r.points}` } : { kind: "ok", small: "FLAG CAPTURED", big: c.name, line: `+${r.points} points` });
        toast(r.message, r.first_blood ? "fb" : "ok");
        onChange();
      } else {
        if (r.status !== "already_solved") SFX.play("bad");
        inp.classList.remove("bad"); void inp.offsetWidth; inp.classList.add("bad");
        setMsg($("#fmsg", m), r.message + (r.attempts_left != null ? ` · ${r.attempts_left} attempts left` : ""), r.status === "already_solved" ? "warn" : "err");
        if (r.penalty || r.locked_for) onChange();
      }
    } catch (err) { SFX.play("bad"); setMsg($("#fmsg", m), err.message, "err"); }
    finally { btn.disabled = false; }
  });
}

/* ───────────── scoreboard: orbit stage + CTFd table + graph ─────────────
   Polls every few seconds. Rows glide to their new place when ranks change,
   the orbit refits itself to the screen, and "Big screen" fills the display. */
async function pageScoreboard(view, slug) {
  const ev = await loadEvent(slug);
  const team = ev.is_organiser ? null : await myTeam(slug).catch(() => null);
  view.innerHTML = `
    <section class="event board" id="boardSec" aria-label="Event clock and live board">
      ${slabHTML(ev.title, ev.org.name, city("Teams", "sTeams", "0") + city("Flags captured", "sSolves", "0") + city("First bloods", "sFb", "0") + city("Top score", "sTop", "0", "red") + city("Challenges", "sChal", "0"), 5)}
      <div class="stage">
        <div class="signal">
          <div class="signal-h"><span>Capture signal · last 90 min</span><span id="frozenChip"></span>
            <span class="lg"><span><i style="background:var(--bone)"></i>correct</span><span><i style="background:var(--blood)"></i>first blood</span><span><i style="background:var(--ice)"></i>wrong</span></span>
            <button class="btn ghost sm big-btn" id="bigBtn" type="button" aria-pressed="false">Big screen</button></div>
          <canvas id="sig" role="img" aria-label="Correct and wrong flag submissions per minute"></canvas>
        </div>
        <div class="orbit" id="orbit">
          <div class="dock"><div class="headline" id="headline"><small>Leading</small>Waiting for the first capture</div>
            <div class="datebox"><span id="dDay"></span><b id="dDate"></b></div></div>
        </div>
      </div>
    </section>
    <section class="panel"><div class="sec-h"><h2>Scoreboard</h2><span id="sbNote"></span></div>
      <div class="tbl-wrap"><table class="t"><thead><tr><th>#</th><th>Team</th><th class="r">Score</th><th class="r">Solves</th><th class="r">First bloods</th><th class="r">Last solve</th></tr></thead><tbody id="rows"></tbody></table></div></section>
    <section class="stack"><div class="sec-h"><h2>Challenges</h2><span>Solves and who drew first blood</span></div><div class="lv-grid" id="lvGrid"></div></section>
    <section class="cols">
      <div class="panel"><div class="sec-h"><h2>Score over time</h2><span>Top 10 teams</span></div><div class="chartbox" id="chart"></div></div>
      <div class="panel"><div class="sec-h"><h2>Recent captures</h2></div><ol class="feed" id="feed"></ol></div>
    </section>`;
  startClock(() => ev);
  const stage = GH.Stage($("#orbit"), {
    left: "Rank · score · team", right: "Category · challenges · solves",
    gauges: [{ key: "scoring", label: "Teams scoring", color: "var(--ice)" }, { key: "prog", label: "Field progress", color: "var(--bone)" }, { key: "fb", label: "Bloods drawn", color: "var(--blood)" }],
  });
  const d = new Date(GH.now());
  $("#dDay").textContent = d.toLocaleDateString(undefined, { weekday: "long" }) + ",";
  $("#dDate").textContent = d.toLocaleDateString(undefined, { month: "long", day: "numeric" });

  /* big screen: the board fills the display and refits itself */
  const sec = $("#boardSec"), bigBtn = $("#bigBtn");
  const setBig = (on) => {
    sec.classList.toggle("big", on);
    document.documentElement.classList.toggle("big-on", on);
    bigBtn.textContent = on ? "Exit big screen" : "Big screen";
    bigBtn.setAttribute("aria-pressed", String(on));
    stage.layout();
    if (last) draw(last);
  };
  bigBtn.addEventListener("click", async () => {
    const on = !sec.classList.contains("big");
    if (on) { setBig(true); try { await sec.requestFullscreen?.(); } catch (e) { /* the CSS version is enough */ } }
    else { if (document.fullscreenElement) await document.exitFullscreen().catch(() => {}); setBig(false); }
  });
  const onFs = () => { if (!document.fullscreenElement && sec.classList.contains("big")) setBig(false); };
  const onKey = (e) => { if (e.key === "Escape" && sec.classList.contains("big")) setBig(false); };
  document.addEventListener("fullscreenchange", onFs);
  document.addEventListener("keydown", onKey);
  onLeave(() => {
    document.removeEventListener("fullscreenchange", onFs); document.removeEventListener("keydown", onKey);
    document.documentElement.classList.remove("big-on");
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  });

  let seen = null, last = null, lvSig = "";
  const prevRank = new Map(), moved = new Map(); // team -> {dir, n, until}
  const fkey = (f) => f.at + "|" + f.team + "|" + f.challenge;
  const tkey = (n) => "t:" + n;
  const arrow = (name) => { const mv = moved.get(name); return mv && mv.until > Date.now() ? `<span class="mv ${mv.dir}">${mv.dir === "up" ? "▲" : "▼"}${mv.n}</span>` : ""; };

  function drawTable(rows) {
    const tb = $("#rows");
    if (!rows.length) { tb.innerHTML = '<tr class="none"><td colspan="6" class="muted">No solves yet.</td></tr>'; return; }
    $("tr.none", tb)?.remove();
    const before = new Map([...tb.children].map((tr) => [tr.dataset.k, tr.getBoundingClientRect().top]));
    const have = new Map([...tb.children].map((tr) => [tr.dataset.k, tr]));
    const list = rows.map((r) => {
      let tr = have.get(r.team);
      if (!tr) {
        tr = document.createElement("tr");
        tr.dataset.k = r.team;
        tr.innerHTML = '<td class="rank"></td><td class="tn"></td><td class="r num"><b class="sc"></b></td><td class="r num sv"></td><td class="r num fbv"></td><td class="r muted num ls"></td>';
        tr._new = true;
      }
      tr.className = `${r.rank === 1 ? "top1" : ""} ${team && r.team === team.name ? "mine" : ""}`;
      $(".rank", tr).innerHTML = pad2(r.rank) + arrow(r.team);
      $(".tn", tr).textContent = r.team;
      GH.count($(".sc", tr), r.score);
      $(".sv", tr).textContent = r.solves;
      $(".fbv", tr).innerHTML = r.first_bloods ? `<span class="fbm">${r.first_bloods}</span>` : "0";
      $(".ls", tr).textContent = GH.hhmm(r.last);
      return tr;
    });
    tb.replaceChildren(...list);
    if (GH.reduced) return;
    list.forEach((tr) => {
      if (tr._new) { tr._new = false; if (before.size) { tr.classList.add("enter"); setTimeout(() => tr.classList.remove("enter"), 900); } return; }
      const dy = before.get(tr.dataset.k) - tr.getBoundingClientRect().top;
      if (!dy) return;
      tr.style.transition = "none";
      tr.style.transform = `translateY(${dy}px)`;
      requestAnimationFrame(() => requestAnimationFrame(() => { tr.style.transition = ""; tr.style.transform = ""; }));
    });
  }

  function draw(sb) {
    const rows = sb.standings, top = rows[0];
    const big = sec.classList.contains("big");
    const maxS = Math.max(1, top ? top.score : 1);
    stage.update("L", rows.slice(0, big ? 32 : 24).map((r) => ({
      key: tkey(r.team), cls: (r.rank === 1 ? "top1 " : "") + (team && r.team === team.name ? "me " : "") + (moved.get(r.team)?.until > Date.now() ? moved.get(r.team).dir : ""),
      title: `${r.team}: ${r.score} points, rank ${r.rank}`,
      html: `<span class="dash" style="--p:${Math.round((Math.max(r.score, 0) / maxS) * 100)}%;--w:62px"></span><span class="pts">${r.score}</span><span class="nm">${esc(r.team)}</span><span class="rk">${pad2(r.rank)}</span>${arrow(r.team)}<span class="tick"></span>`,
    })));
    const maxC = Math.max(1, ...sb.categories.map((c) => c.solves));
    stage.update("R", sb.categories.map((c) => ({
      key: "c:" + c.category, title: `${c.category}: ${c.solves} solves`,
      html: `<span class="tick"></span><span class="lvn">${esc(c.category.slice(0, 14))}</span><span class="sk">${c.challenges} chall.</span><span class="dash" style="--p:${Math.round((c.solves / maxC) * 100)}%;--w:38px;--c:var(--ice)"></span><span class="ct">${c.solves}</span>`,
    })));
  }

  async function refresh() {
    const [sb, gr] = await Promise.all([GET(`/api/events/${slug}/scoreboard`), GET(`/api/events/${slug}/scoreboard/graph`)]);
    GH.syncClock(sb.server_time);
    const rows = sb.standings, top = rows[0];
    rows.forEach((r) => {
      const p = prevRank.get(r.team);
      if (p && p !== r.rank) moved.set(r.team, { dir: p > r.rank ? "up" : "down", n: Math.abs(p - r.rank), until: Date.now() + 15000 });
      prevRank.set(r.team, r.rank);
    });
    last = sb;
    const fbs = rows.reduce((a, r) => a + r.first_bloods, 0);
    GH.count($("#sTeams"), sb.teams); GH.count($("#sSolves"), sb.solves); GH.count($("#sTop"), top ? top.score : 0); GH.count($("#sChal"), sb.challenges);
    $("#sFb").textContent = `${fbs}/${sb.challenges}`;
    $("#frozenChip").innerHTML = sb.frozen ? '<span class="chip paused">Scoreboard frozen</span>' : "";
    $("#sbNote").textContent = sb.frozen ? "Frozen: showing standings at the freeze time" : "Live · updates every few seconds";

    draw(sb);
    stage.gauge("scoring", sb.teams ? rows.length / sb.teams : 0, sb.teams ? Math.round((rows.length / sb.teams) * 100) + "%" : "0%");
    const cells = sb.teams * sb.challenges;
    stage.gauge("prog", cells ? sb.solves / cells : 0, cells ? Math.round((sb.solves / cells) * 100) + "%" : "0%");
    stage.gauge("fb", sb.challenges ? fbs / sb.challenges : 0, `${fbs}/${sb.challenges}`);
    $("#headline").innerHTML = top ? `<small>Leading</small>${esc(top.team)}<br><em>${top.score}</em> pts · ${top.solves} solve${top.solves === 1 ? "" : "s"}` : "<small>Leading</small>Waiting for the first capture";
    if (sb.buckets.length) GH.signalAnimated($("#sig"), sb.buckets);
    drawTable(rows);

    // challenge cards (redrawn only when something changed, so the bars don't restart)
    const sig = JSON.stringify(sb.board || []);
    if (sig !== lvSig) {
      lvSig = sig;
      const board = sb.board || [], maxB = Math.max(1, ...board.map((c) => c.solves));
      $("#lvGrid").innerHTML = board.length ? board.map((c) => `<article class="lv ${c.solves ? "" : "zero"}">
          <div class="lv-top"><span class="lv-n">${c.value}</span><span class="lv-p">${esc(c.category)}</span></div>
          <div class="lv-c">${esc(c.name)}</div>
          <div class="lv-bar"><i style="width:${Math.round((c.solves / maxB) * 100)}%"></i></div>
          <div class="lv-s"><span><b>${c.solves}</b> solve${c.solves === 1 ? "" : "s"}</span>${c.first_blood ? `<span class="fb" title="First blood">${esc(c.first_blood)}</span>` : "<span>no first blood yet</span>"}</div></article>`).join("")
        : '<div class="empty">Challenges show up here once the event starts.</div>';
    }

    // graph (theme chart wants {players:[{name,line,points}]})
    GH.chart($("#chart"), { players: gr.series.map((s) => ({ name: s.team, line: s.points, points: s.points.length ? s.points[s.points.length - 1][1] : 0 })) });

    // feed + live moments for captures we haven't seen yet
    const fresh = seen ? sb.feed.filter((f) => !seen.has(fkey(f))) : [];
    $("#feed").innerHTML = sb.feed.length ? sb.feed.map((f) => `<li class="${fresh.includes(f) ? "new" : ""}"><time>${esc(GH.hhmm(f.at).slice(0, 5))}</time><span class="who">${esc(f.team)}</span>
      <span class="lvt" title="${esc(f.category)}">${esc(f.challenge)}</span><span class="p ${f.first_blood ? "fbp" : ""}">${f.first_blood ? "◆ " : "+"}${f.points}</span></li>`).join("")
      : '<li class="empty">Captures show up here as they happen.</li>';
    if (fresh.length) {
      stage.hit(fresh.flatMap((f) => [["L", tkey(f.team)], ["R", "c:" + f.category]]));
      fresh.slice(0, 3).forEach((f) => toast(`${f.team} solved ${f.challenge}${f.first_blood ? " · first blood" : ""}`, f.first_blood ? "fb" : "ok"));
      const fb = fresh.find((f) => f.first_blood);
      if (fb) GH.moment({ kind: "fb", small: "FIRST BLOOD", big: fb.team, line: fb.challenge });
      if (sec.classList.contains("big")) SFX.play(fb ? "ok" : "ping"); // projector mode plays every capture
    }
    seen = new Set(sb.feed.map(fkey));
  }
  await refresh();
  every(4000, () => { if (!document.hidden) refresh().catch(() => {}); });
}

/* ───────────── organiser: dashboard ───────────── */
async function pageDashboard(view) {
  navEvent = null;
  if (!ME) throw Object.assign(new Error("Log in first"), { status: 401 });
  const orgs = await GET("/api/orgs");
  const evs = await Promise.all(orgs.map((o) => GET(`/api/orgs/${o.slug}/events`)));
  view.innerHTML = `
    <div class="ph"><h1><small>Organise</small>Your clubs and events</h1></div>
    ${ME.totp_enabled ? "" : SITE.organiser_mfa === "required"
      ? '<div class="panel mfa-gate"><b>Turn on two-factor login first.</b> Organiser accounts need it before they can create or manage events, so a leaked password can\'t be used to change an event. <a class="btn red sm" href="/account">Set up 2FA</a></div>'
      : '<p class="msg warn">Organisers should turn on 2FA. <a class="lnk" href="/account">Set it up</a></p>'}
    <div id="orgs" class="stack"></div>
    <section class="panel"><div class="sec-h"><h2>New organisation</h2><span>A club, chapter or team that runs events. You'll be its owner.</span></div>
      <form class="form" id="newOrg" novalidate><div class="two">
        <div class="field"><label for="on">Name</label><input class="inp" id="on" name="name" maxlength="80" required placeholder="CySec Club"></div>
        <div class="field"><label for="os">Short URL name</label><input class="inp" id="os" name="slug" maxlength="40" required placeholder="cysec-club"></div></div>
        <div><button class="btn" type="submit">Create organisation</button></div><div class="msg" role="status"></div></form></section>`;
  autoSlug($("#on"), $("#os"));
  bindForm($("#newOrg"), async (d) => { await POST("/api/orgs", { name: d.name.trim(), slug: d.slug.trim() }); go("/dashboard"); });

  $("#orgs").innerHTML = orgs.length ? orgs.map((o, i) => `<section class="panel stack">
      <div class="sec-h"><h2>${esc(o.name)}</h2><span class="pill">${esc(o.role)}</span></div>
      <div class="adm-list">${evs[i].length ? evs[i].map((e) => `<div class="adm-item"><div class="grow"><div class="t1">${esc(e.title)}</div><div class="t2">/e/${esc(e.slug)}</div></div>
          <span class="pill ${esc(e.status)}">${esc(e.status)}</span><a class="btn ghost sm" href="/e/${esc(e.slug)}">View</a><a class="btn sm" href="/manage/${esc(e.slug)}">Manage</a></div>`).join("")
        : '<div class="empty">No events yet.</div>'}</div>
      <details><summary class="btn ghost sm">New event</summary>
        <form class="form" data-org="${esc(o.slug)}" data-kind="event" novalidate><div class="three">
          <div class="field"><label>Title</label><input class="inp" name="title" maxlength="120" required placeholder="Fall CTF 2026"></div>
          <div class="field"><label>Short URL name</label><input class="inp" name="slug" maxlength="40" required placeholder="fall-ctf-2026"></div>
          <div class="field"><label>Max team size</label><input class="inp" name="max_team_size" type="number" min="1" max="10" value="4"></div></div>
          <p class="help">The event starts as a draft that only your organisers can see. Add challenges, then publish it.</p>
          <div><button class="btn" type="submit">Create event</button></div><div class="msg" role="status"></div></form></details>
      ${o.role === "owner" ? `<details><summary class="btn ghost sm">Add an organiser</summary>
        <form class="form" data-org="${esc(o.slug)}" data-kind="member" novalidate>
          <div class="field"><label>Their account email</label><input class="inp" name="email" type="email" required></div>
          <p class="help">They need an account first. Admins can create and run events but can't add other organisers.</p>
          <div><button class="btn" type="submit">Add as admin</button></div><div class="msg" role="status"></div></form></details>` : ""}
    </section>`).join("") : '<div class="empty">You aren\'t part of any organisation yet. Create one below to start hosting events.</div>';

  $$("form[data-kind=event]", view).forEach((f) => {
    autoSlug($("[name=title]", f), $("[name=slug]", f));
    bindForm(f, async (d) => {
      const r = await POST(`/api/orgs/${f.dataset.org}/events`, { title: d.title.trim(), slug: d.slug.trim(), max_team_size: +d.max_team_size || 4 });
      go("/manage/" + r.slug);
    });
  });
  $$("form[data-kind=member]", view).forEach((f) => bindForm(f, async (d) => {
    await POST(`/api/orgs/${f.dataset.org}/members`, { email: d.email.trim(), role: "admin" });
    f.reset();
    return "Added.";
  }));
}

function autoSlug(src, dst) {
  let touched = false;
  dst.addEventListener("input", () => (touched = true));
  src.addEventListener("input", () => { if (!touched) dst.value = slugify(src.value); });
}

/* ───────────── organiser: one event ───────────── */
async function pageManage(view, slug) {
  if (!ME) throw Object.assign(new Error("Log in first"), { status: 401 });
  let ev = await loadEvent(slug);
  if (!ev.is_organiser) throw Object.assign(new Error("Event not found"), { status: 404 });
  if (SITE.organiser_mfa === "required" && !ME.totp_enabled) {
    view.innerHTML = `<div class="narrow panel stack mfa-gate"><div class="sec-h"><h2>Turn on two-factor login</h2></div>
      <p class="muted">Organiser tools need 2FA on your account, so a leaked password can't be used to change ${esc(ev.title)}.</p>
      <div><a class="btn red sm" href="/account">Set up 2FA</a></div></div>`;
    return;
  }
  view.innerHTML = `
    <div class="ph"><h1><small>${esc(ev.org.name)} · manage</small><span id="evTitle">${esc(ev.title)}</span></h1>
      <span class="r row" id="quick"></span></div>
    <div class="tabs" role="tablist"><button data-tab="chals" class="on">Challenges</button><button data-tab="settings">Settings</button><button data-tab="live">Live</button><button data-tab="activity">Activity</button></div>
    <div id="tab"></div>`;
  const tabs = { chals: tabChallenges, settings: tabSettings, live: tabLive, activity: tabActivity };
  let stopTab = null;
  const show = (name) => {
    if (stopTab) stopTab();
    stopTab = null;
    $$(".tabs button", view).forEach((b) => b.classList.toggle("on", b.dataset.tab === name));
    const fresh = document.createElement("div"); // new element, so no listeners carry over between tabs
    fresh.id = "tab";
    $("#tab").replaceWith(fresh);
    const r = tabs[name](fresh, slug, () => ev, (e) => { ev = e; drawQuick(); });
    if (typeof r === "function") stopTab = r;
  };
  $(".tabs", view).addEventListener("click", (e) => { const b = e.target.closest("button[data-tab]"); if (b) show(b.dataset.tab); });
  onLeave(() => stopTab && stopTab());

  function drawQuick() {
    $("#evTitle").textContent = ev.title;
    $("#quick").innerHTML = `<span class="pill ${esc(ev.status)}">${esc(ev.status)}</span>
      ${ev.status === "published" ? `<button class="btn ghost sm" data-q="${ev.paused ? "resume" : "pause"}">${ev.paused ? "Resume submissions" : "Pause submissions"}</button>` : ""}
      <button class="btn sm ${ev.status === "published" ? "ghost" : "red"}" data-q="${ev.status === "published" ? "unpublish" : "publish"}">${ev.status === "published" ? "Unpublish" : "Publish"}</button>
      <a class="btn ghost sm" href="/e/${esc(slug)}">View as player</a>`;
  }
  $("#quick").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-q]");
    if (!b) return;
    const q = b.dataset.q;
    const patch = { publish: { status: "published" }, unpublish: { status: "draft" }, pause: { paused: true }, resume: { paused: false } }[q];
    if (q === "publish" && !(await confirmBox("Publish event?", "Anyone will be able to see the event page and register teams. Only challenges you mark visible are shown, and only once the event starts.", "Publish", false))) return;
    try { ev = Object.assign(ev, await PATCH("/api/events/" + slug, patch)); drawQuick(); toast("Saved.", "ok"); } catch (err) { toast(err.message, "err"); }
  });
  drawQuick();
  show("chals");
}

function tabSettings(box, slug, getEv, setEv) {
  const ev = getEv();
  box.innerHTML = `<section class="panel"><form class="form" novalidate>
    <div class="field"><label>Title</label><input class="inp" name="title" maxlength="120" value="${esc(ev.title)}" required></div>
    <div class="field"><label>Description</label><textarea class="inp" name="description" maxlength="10000">${esc(ev.description)}</textarea>
      <p class="help">Markdown works: **bold**, \`code\`, [link](https://…), lines starting with "- " for lists.</p></div>
    <div class="three">
      <div class="field"><label>Status</label><select class="inp" name="status">${["draft", "published", "archived"].map((s) => `<option ${ev.status === s ? "selected" : ""}>${s}</option>`).join("")}</select></div>
      <div class="field"><label>Starts</label><input class="inp" type="datetime-local" name="starts_at" value="${toLocalInput(ev.starts_at)}"></div>
      <div class="field"><label>Ends</label><input class="inp" type="datetime-local" name="ends_at" value="${toLocalInput(ev.ends_at)}"></div>
    </div>
    <div class="three">
      <div class="field"><label>Max team size</label><input class="inp" type="number" min="1" max="10" name="max_team_size" value="${ev.max_team_size}"></div>
      <div class="field"><label>First blood bonus (points)</label><input class="inp" type="number" min="0" max="1000" name="first_blood_bonus" value="${ev.first_blood_bonus}"></div>
      <div class="field"><label>Freeze scoreboard at</label><input class="inp" type="datetime-local" name="freeze_at" value="${toLocalInput(ev.freeze_at)}"></div>
    </div>
    <div class="three">
      <div class="field"><label>Lock out after wrong flags</label><input class="inp" type="number" min="0" max="100" name="lockout_threshold" value="${ev.lockout_threshold}">
        <p class="help">Wrong flags on one challenge before the team is locked out of it. 0 = never.</p></div>
      <div class="field"><label>Lockout length (minutes)</label><input class="inp" type="number" min="1" max="1440" name="lockout_minutes" value="${ev.lockout_minutes}"></div>
      <div class="field"><label>Points lost per wrong flag</label><input class="inp" type="number" min="0" max="10000" name="wrong_penalty" value="${ev.wrong_penalty}">
        <p class="help">0 = no penalty. Changing it doesn't touch earlier attempts.</p></div>
    </div>
    <label class="check"><input type="checkbox" name="registration_open" ${ev.registration_open ? "checked" : ""}> Registration open (players can create and join teams)</label>
    <label class="check"><input type="checkbox" name="paused" ${ev.paused ? "checked" : ""}> Submissions paused</label>
    <p class="help">Times are in your browser's time zone. Leave Starts empty to open challenges as soon as the event is published. After the freeze time, players and the public see the board as it was; you keep seeing it live.</p>
    <div><button class="btn" type="submit">Save settings</button></div><div class="msg" role="status"></div></form></section>`;
  bindForm($("form", box), async (d, f) => {
    const out = await PATCH("/api/events/" + slug, {
      title: d.title.trim(), description: d.description, status: d.status,
      starts_at: fromLocalInput(d.starts_at), ends_at: fromLocalInput(d.ends_at), freeze_at: fromLocalInput(d.freeze_at),
      max_team_size: +d.max_team_size, first_blood_bonus: +d.first_blood_bonus || 0,
      lockout_threshold: +d.lockout_threshold || 0, lockout_minutes: +d.lockout_minutes || 5, wrong_penalty: +d.wrong_penalty || 0,
      registration_open: $("[name=registration_open]", f).checked, paused: $("[name=paused]", f).checked,
    });
    setEv(Object.assign(getEv(), out));
    return "Saved.";
  });
}

function tabLive(box, slug) {
  const base = `/api/events/${slug}/manage`;
  box.classList.add("stack");
  box.innerHTML = `<div class="stats4" id="st"></div>
    <section class="cols">
      <div class="panel stack"><div class="sec-h"><h2>Announce to everyone</h2><span>Pops up with a sound for every player watching the event</span></div>
        <form class="form" id="annForm" novalidate><textarea class="inp" name="text" maxlength="500" required placeholder="e.g. Web 2 had a bug and is fixed now. Try again!"></textarea>
          <div><button class="btn red" type="submit">Send announcement</button></div><div class="msg" role="status"></div></form>
        <div class="adm-list" id="anns"></div></div>
      <div class="panel stack"><div class="sec-h"><h2>Adjust points</h2><span>Add a bonus or deduct points. The team sees it with your reason.</span></div>
        <form class="form" id="awForm" novalidate><div class="two">
          <div class="field"><label for="awTeam">Team</label><select class="inp" name="team_id" id="awTeam" required></select></div>
          <div class="field"><label for="awPts">Points</label><input class="inp" id="awPts" type="number" name="points" min="-100000" max="100000" required placeholder="-50 deducts, 25 adds"></div></div>
          <div class="field"><label for="awWhy">Reason</label><input class="inp" id="awWhy" name="reason" maxlength="200" required placeholder="e.g. Flag sharing in public chat"></div>
          <div><button class="btn" type="submit">Apply</button></div><div class="msg" role="status"></div></form>
        <div class="adm-list" id="awards"></div></div>
    </section>
    <section class="panel stack"><div class="sec-h"><h2>Locked-out teams</h2><span>Teams waiting out a wrong-flag lockout. Lift one if it was a mistake.</span></div><div class="adm-list" id="locks"></div></section>
    <section class="panel"><div class="sec-h"><h2>Submissions</h2><span>Every attempt, newest first. Wrong attempts show what was typed.</span>
      <label class="check r"><input type="checkbox" id="onlyWrong"> Only wrong</label></div><div class="sub-list" id="subs"></div></section>`;

  let teams = [], teamSig = "";
  async function loadTeams() {
    teams = await GET(base + "/teams");
    const sig = JSON.stringify(teams.map((t) => [t.id, t.name]));
    if (sig === teamSig) return;
    teamSig = sig;
    const sel = $("#awTeam"), keep = sel.value;
    sel.innerHTML = teams.length ? teams.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join("") : '<option value="">No teams yet</option>';
    if (keep) sel.value = keep;
  }
  async function loadSide() {
    const [anns, awards] = await Promise.all([GET(`/api/events/${slug}/announcements`), GET(base + "/awards")]);
    $("#anns").innerHTML = anns.map((a) => `<div class="adm-item"><div class="grow"><div class="t1">${esc(a.text)}</div><div class="t2">${esc(fmtDate(a.at))}</div></div>
      <button class="btn ghost sm" data-rmann="${a.id}">Delete</button></div>`).join("") || '<p class="muted">No announcements yet.</p>';
    $("#awards").innerHTML = awards.map((a) => `<div class="adm-item"><span class="pill ${a.points > 0 ? "correct" : "wrong"}">${a.points > 0 ? "+" : ""}${a.points}</span>
      <div class="grow"><div class="t1">${esc(a.team)}</div><div class="t2">${esc(a.reason)} · ${esc(fmtDate(a.at))}</div></div>
      <button class="btn ghost sm" data-rmaw="${a.id}">Undo</button></div>`).join("") || '<p class="muted">No adjustments yet.</p>';
  }
  const load = async () => {
    const [st, subs, locks] = await Promise.all([GET(base + "/stats"), GET(`${base}/submissions?limit=150&only_wrong=${$("#onlyWrong").checked}`), GET(base + "/lockouts"), loadTeams()]);
    $("#st").innerHTML = [["Teams", st.teams], ["Submissions", st.submissions], ["Solves", st.solves], ["Wrong", st.wrong]].map(([k, v]) => `<div><small>${k}</small><b>${v}</b></div>`).join("");
    $("#locks").innerHTML = locks.map((l) => `<div class="adm-item"><div class="grow"><div class="t1">${esc(l.team)}</div><div class="t2">${esc(l.challenge)} · until ${esc(GH.hhmm(l.until))}</div></div>
      <button class="btn ghost sm" data-lift="${l.id}">Lift now</button></div>`).join("") || '<p class="muted">Nobody is locked out.</p>';
    $("#subs").innerHTML = subs.length ? subs.map((s) => `<div class="sub-item"><span class="muted num">${esc(GH.hhmm(s.at))}</span><span class="pill ${s.correct ? "correct" : "wrong"}">${s.correct ? "correct" : "wrong"}</span>
      <b>${esc(s.team)}</b><span class="muted">${esc(s.user)}</span><span>${esc(s.challenge)}</span><span class="grow attempt">${esc(s.provided)}</span>${s.penalty ? `<span class="red num">-${s.penalty}</span>` : ""}<span class="muted num">${esc(s.ip)}</span></div>`).join("")
      : '<div class="empty">No submissions yet.</div>';
  };

  bindForm($("#annForm"), async (d, f) => {
    if (!d.text.trim()) throw new Error("Write the announcement first.");
    await POST(base + "/announcements", { text: d.text.trim() });
    f.reset(); loadSide();
    return "Sent to everyone.";
  });
  bindForm($("#awForm"), async (d, f) => {
    const pts = Math.trunc(+d.points), t = teams.find((x) => x.id === +d.team_id);
    if (!t) throw new Error("Pick a team.");
    if (!pts) throw new Error("Use a negative number to deduct or a positive one to add.");
    if (!d.reason.trim()) throw new Error("Give a reason. The team will see it.");
    const what = pts < 0 ? `Deduct ${-pts} points from ${t.name}?` : `Give ${pts} points to ${t.name}?`;
    if (!(await confirmBox(what, `Reason shown to the team: ${d.reason.trim()}`, "Apply", pts < 0))) return;
    await POST(base + "/awards", { team_id: t.id, points: pts, reason: d.reason.trim() });
    $("[name=points]", f).value = ""; $("[name=reason]", f).value = "";
    loadSide();
    return pts < 0 ? "Deducted. The team has been told." : "Added. The team has been told.";
  });
  box.addEventListener("click", async (e) => {
    const t = e.target;
    try {
      const lift = t.closest("[data-lift]");
      if (lift) { await DEL(`${base}/lockouts/${lift.dataset.lift}`); toast("Lockout lifted.", "ok"); return load(); }
      const ra = t.closest("[data-rmaw]");
      if (ra && (await confirmBox("Undo adjustment?", "The team's score goes back to what it was before.", "Undo"))) { await DEL(`${base}/awards/${ra.dataset.rmaw}`); return loadSide(); }
      const rn = t.closest("[data-rmann]");
      if (rn && (await confirmBox("Delete announcement?", "It disappears from the event page. Players who already saw the pop-up keep their memory of it.", "Delete"))) { await DEL(`${base}/announcements/${rn.dataset.rmann}`); return loadSide(); }
    } catch (err) { toast(err.message, "err"); }
  });
  $("#onlyWrong").addEventListener("change", load);
  load().catch((e) => toast(e.message, "err"));
  loadSide().catch(() => {});
  const id = setInterval(() => load().catch(() => {}), 5000);
  return () => clearInterval(id);
}

/* ───────────── organiser: challenges (no-code editor) ───────────── */
const EVENT_ACTS = {
  event_created: "Created the event", event_settings: "Changed settings", challenge_created: "Added a challenge",
  challenge_updated: "Edited a challenge", challenge_deleted: "Deleted a challenge", flag_added: "Added a flag",
  flag_removed: "Removed a flag", hint_added: "Added a hint", hint_updated: "Edited a hint", hint_deleted: "Deleted a hint",
  file_uploaded: "Uploaded a file", file_deleted: "Deleted a file", points_adjusted: "Adjusted points",
  points_adjustment_undone: "Undid a points change", lockout_lifted: "Lifted a lockout",
  announcement: "Sent an announcement", announcement_deleted: "Deleted an announcement",
};

/* Who changed what, so organisers can check each other's changes. */
function tabActivity(box, slug) {
  box.innerHTML = `<section class="panel stack"><div class="sec-h"><h2>Organiser activity</h2><span>Every change to this event, newest first. Flags are never shown here.</span></div>
    <div class="adm-list act" id="audit"><div class="loading">Loading…</div></div></section>`;
  GET(`/api/events/${slug}/manage/audit`).then((rows) => {
    $("#audit").innerHTML = rows.length ? rows.map((a) => `<div class="adm-item"><div class="grow">
        <div class="t1">${esc(EVENT_ACTS[a.action] || a.action)}${a.detail ? ` <span class="muted">· ${esc(a.detail)}</span>` : ""}</div>
        <div class="t2">${esc(a.user)} · ${esc(fmtDate(a.at))} · IP ${esc(a.ip || "unknown")}</div></div></div>`).join("")
      : '<div class="empty">No changes yet.</div>';
  }).catch((e) => { $("#audit").innerHTML = `<p class="msg err">${esc(e.message)}</p>`; });
}

function tabChallenges(box, slug) {
  const base = `/api/events/${slug}/manage`;
  let all = [];

  async function list() {
    all = await GET(base + "/challenges");
    box.innerHTML = `<section class="stack">
      <div class="sec-h"><h2>Challenges</h2><span>${all.length} total · ${all.filter((c) => c.state === "visible").length} visible to players</span>
        <span class="r"><button class="btn red sm" id="newCh">New challenge</button></span></div>
      <div class="adm-list">${all.length ? all.map((c) => `<div class="adm-item">
          <div class="grow"><div class="t1">${esc(c.name)}</div>
            <div class="t2">${esc(c.category)} · ${c.scoring === "dynamic" ? `${c.current_value}/${c.value} pts (dynamic)` : c.value + " pts"} · ${c.solves} solve${c.solves === 1 ? "" : "s"} · ${c.flags.length} flag${c.flags.length === 1 ? "" : "s"} · ${c.hints.length} hint${c.hints.length === 1 ? "" : "s"} · ${c.files.length} file${c.files.length === 1 ? "" : "s"}${c.requires.length ? " · needs " + c.requires.map(esc).join(", ") : ""}</div></div>
          <span class="pill ${c.state}">${c.state}</span>
          <button class="btn ghost sm" data-tog="${c.id}" data-state="${c.state}">${c.state === "visible" ? "Hide" : "Show"}</button>
          <button class="btn sm" data-edit="${c.id}">Edit</button>
          <button class="btn ghost sm" data-del="${c.id}">Delete</button></div>`).join("")
        : '<div class="empty">No challenges yet. Add your first one with <b>New challenge</b>.</div>'}</div></section>`;
  }

  box.addEventListener("click", async (e) => {
    const t = e.target;
    try {
      if (t.closest("#newCh")) return editor(null);
      if (t.closest("[data-back]")) return list();
      const ed = t.closest("[data-edit]");
      if (ed) return editor(all.find((c) => c.id === +ed.dataset.edit));
      const tg = t.closest("[data-tog]");
      if (tg) { await PATCH(`${base}/challenges/${tg.dataset.tog}`, { state: tg.dataset.state === "visible" ? "hidden" : "visible" }); return list(); }
      const dl = t.closest("[data-del]");
      if (dl) {
        const c = all.find((x) => x.id === +dl.dataset.del);
        if (!(await GH.confirm({ title: "Delete challenge?", body: esc(`"${c.name}" and its ${c.solves} solves, hints and files are removed for good. Type the name to confirm.`), ok: "Delete", type: c.name }))) return;
        await DEL(`${base}/challenges/${c.id}`);
        toast("Deleted.", "ok");
        return list();
      }
    } catch (err) { toast(err.message, "err"); }
  });

  function flagRow() {
    return `<div class="row flag-row"><input class="inp grow" name="flag" placeholder="e.g. FLAG{...}" maxlength="256" autocomplete="off" spellcheck="false">
      <label class="check"><input type="checkbox" name="ci"> case-insensitive</label></div>`;
  }

  async function editor(ch) {
    const isNew = !ch;
    const others = all.filter((c) => !ch || c.id !== ch.id);
    const cats = [...new Set(all.map((c) => c.category))];
    const v = ch || { name: "", slug: "", category: "", description: "", value: 100, scoring: "static", minimum: 50, decay: 10, state: "hidden", max_attempts: 0, requires: [] };
    box.innerHTML = `<section class="stack">
      <div class="row"><button class="btn ghost sm" data-back>← All challenges</button><span class="grow"></span>${isNew ? "" : `<span class="pill ${v.state}">${v.state}</span>`}</div>
      <section class="panel"><div class="sec-h"><h2>${isNew ? "New challenge" : "Edit challenge"}</h2></div>
      <form class="form" id="chForm" novalidate>
        <div class="two">
          <div class="field"><label>Name</label><input class="inp" name="name" maxlength="80" required value="${esc(v.name)}"></div>
          <div class="field"><label>Category</label><input class="inp" name="category" maxlength="40" required list="catList" value="${esc(v.category)}" placeholder="web, crypto, forensics…">
            <datalist id="catList">${[...new Set([...cats, "web", "crypto", "forensics", "reversing", "pwn", "misc", "osint"])].map((c) => `<option value="${esc(c)}">`).join("")}</datalist></div>
        </div>
        ${isNew ? `<div class="field"><label>Short ID</label><input class="inp" name="slug" maxlength="40" required placeholder="sql-login"><p class="help">Used for unlock rules. Lowercase letters, digits and dashes. Can't be changed later.</p></div>` : ""}
        <div class="field"><label>Description</label>
          <textarea class="inp" name="description" maxlength="20000">${esc(v.description)}</textarea>
          <p class="help">Markdown works: **bold**, \`code\`, \`\`\` for code blocks, [link](https://…), "- " lists.</p>
          <div class="row"><button class="linkbtn" type="button" id="pv">Preview</button></div><div class="desc panel" id="pvBox" hidden></div></div>
        <div class="three">
          <div class="field"><label>Scoring</label><select class="inp" name="scoring"><option value="static" ${v.scoring === "static" ? "selected" : ""}>Static (fixed points)</option><option value="dynamic" ${v.scoring === "dynamic" ? "selected" : ""}>Dynamic (drops as teams solve)</option></select></div>
          <div class="field"><label id="valLbl">Points</label><input class="inp" type="number" name="value" min="1" max="100000" required value="${v.value}"></div>
          <div class="field"><label>Max wrong attempts per team</label><input class="inp" type="number" name="max_attempts" min="0" max="1000" value="${v.max_attempts}"><p class="help">0 = unlimited</p></div>
        </div>
        <div class="two" id="dyn">
          <div class="field"><label>Minimum points</label><input class="inp" type="number" name="minimum" min="0" max="100000" value="${v.minimum ?? 50}"></div>
          <div class="field"><label>Solves to reach the minimum</label><input class="inp" type="number" name="decay" min="1" max="100000" value="${v.decay ?? 10}"></div>
        </div>
        ${others.length ? `<div class="field"><label>Unlock only after solving</label><div class="row">${others.map((o) => `<label class="check"><input type="checkbox" name="req" value="${esc(o.slug)}" ${v.requires.includes(o.slug) ? "checked" : ""}> ${esc(o.name)}</label>`).join("")}</div></div>` : ""}
        <label class="check"><input type="checkbox" name="visible" ${v.state === "visible" ? "checked" : ""}> Visible to players</label>
        ${isNew ? `<div class="field"><label>Flag</label><div class="stack" id="flags">${flagRow()}</div>
          <div><button class="linkbtn" type="button" id="addFlag">+ Another accepted flag</button></div>
          <p class="help">Flags are stored hashed. After saving nobody, including you, can read them back, so keep your own copy.</p></div>` : ""}
        <div><button class="btn red" type="submit">${isNew ? "Create challenge" : "Save changes"}</button></div><div class="msg" role="status"></div>
      </form></section>
      ${isNew ? "" : `<div id="extras" class="stack"></div>`}
    </section>`;

    const form = $("#chForm");
    const dyn = () => { const d = $("[name=scoring]", form).value === "dynamic"; $("#dyn").hidden = !d; $("#valLbl").textContent = d ? "Starting points" : "Points"; };
    $("[name=scoring]", form).addEventListener("change", dyn);
    dyn();
    if (isNew) {
      autoSlug($("[name=name]", form), $("[name=slug]", form));
      $("#addFlag").addEventListener("click", () => $("#flags").insertAdjacentHTML("beforeend", flagRow()));
    }
    $("#pv").addEventListener("click", () => { const b = $("#pvBox"); b.hidden = !b.hidden; b.innerHTML = md($("[name=description]", form).value); });

    bindForm(form, async (d) => {
      const body = {
        name: d.name.trim(), category: d.category.trim(), description: d.description,
        scoring: d.scoring, value: +d.value, max_attempts: +d.max_attempts || 0,
        minimum: d.scoring === "dynamic" ? +d.minimum : null, decay: d.scoring === "dynamic" ? +d.decay : null,
        requires: $$("[name=req]:checked", form).map((x) => x.value),
        state: $("[name=visible]", form).checked ? "visible" : "hidden",
      };
      if (isNew) {
        body.slug = d.slug.trim();
        body.flags = $$(".flag-row", form).map((r) => ({ flag: $("[name=flag]", r).value.trim(), case_insensitive: $("[name=ci]", r).checked })).filter((f) => f.flag);
        if (!body.flags.length) throw new Error("Add at least one flag.");
        const made = await POST(base + "/challenges", body);
        all = await GET(base + "/challenges");
        toast("Challenge created. Add hints or files below.", "ok");
        return editor(all.find((c) => c.id === made.id));
      }
      await PATCH(`${base}/challenges/${ch.id}`, body);
      all = await GET(base + "/challenges");
      return "Saved.";
    });
    if (!isNew) extras(ch.id);
  }

  /* flags, hints and files of an existing challenge */
  async function extras(id) {
    const ch = (all = await GET(base + "/challenges")).find((c) => c.id === id);
    const host = $("#extras");
    if (!ch || !host) return;
    host.innerHTML = `
      <section class="panel stack"><div class="sec-h"><h2>Flags</h2><span>${ch.flags.length} accepted · stored hashed, can't be shown</span></div>
        <div class="adm-list">${ch.flags.map((f, i) => `<div class="adm-item"><span class="grow">Flag ${i + 1}${f.case_insensitive ? " · case-insensitive" : ""}</span>
          <button class="btn ghost sm" data-rmflag="${f.id}" ${ch.flags.length === 1 ? 'disabled title="A challenge needs at least one flag"' : ""}>Remove</button></div>`).join("")}</div>
        <form class="form" id="fAdd" novalidate><div class="row"><input class="inp grow" name="flag" placeholder="Add another accepted flag" maxlength="256" autocomplete="off" spellcheck="false">
          <label class="check"><input type="checkbox" name="ci"> case-insensitive</label><button class="btn sm" type="submit">Add flag</button></div>
          <p class="help">To change a flag, add the new one, then remove the old one.</p><div class="msg" role="status"></div></form></section>

      <section class="panel stack"><div class="sec-h"><h2>Hints</h2><span>Free hints show to everyone; paid ones cost the team points</span></div>
        <div class="stack">${ch.hints.map((h, i) => `<form class="form" data-hint="${h.id}" novalidate><div class="row">
          <b>Hint ${i + 1}</b><span class="grow"></span><label class="muted">Cost</label><input class="inp sm" type="number" name="cost" min="0" max="100000" value="${h.cost}" style="width:110px"></div>
          <textarea class="inp" name="content" maxlength="5000">${esc(h.content)}</textarea>
          <div class="row"><button class="btn sm" type="submit">Save hint</button><button class="btn ghost sm" type="button" data-rmhint="${h.id}">Delete</button></div><div class="msg" role="status"></div></form>`).join("") || '<p class="muted">No hints.</p>'}</div>
        <form class="form" id="hAdd" novalidate><textarea class="inp" name="content" maxlength="5000" placeholder="New hint" required></textarea>
          <div class="row"><label class="muted">Cost (points)</label><input class="inp sm" type="number" name="cost" min="0" max="100000" value="0" style="width:110px"><button class="btn sm" type="submit">Add hint</button></div><div class="msg" role="status"></div></form></section>

      <section class="panel stack"><div class="sec-h"><h2>Files</h2><span>Players download these from the challenge</span></div>
        <div class="adm-list">${ch.files.map((f) => `<div class="adm-item"><span class="grow">${esc(f.filename)} <span class="muted">· ${fmtSize(f.size)} · sha256 ${esc(f.sha256.slice(0, 12))}…</span></span>
          <a class="btn ghost sm" href="/api/events/${esc(slug)}/files/${f.id}" download>Download</a><button class="btn ghost sm" data-rmfile="${f.id}">Delete</button></div>`).join("") || '<p class="muted">No files.</p>'}</div>
        <form class="form" id="upl" novalidate><div class="row"><input class="inp grow" type="file" name="file" multiple><button class="btn sm" type="submit">Upload</button></div>
          <p class="help">Up to 50 MB per file.</p><div class="msg" role="status"></div></form></section>`;

    const again = () => extras(id);
    bindForm($("#fAdd", host), async (d, f) => {
      if (!d.flag.trim()) throw new Error("Type the flag first.");
      await POST(`${base}/challenges/${id}/flags`, { flag: d.flag.trim(), case_insensitive: $("[name=ci]", f).checked });
      toast("Flag added.", "ok"); again();
    });
    bindForm($("#hAdd", host), async (d) => { await POST(`${base}/challenges/${id}/hints`, { content: d.content.trim(), cost: +d.cost || 0 }); toast("Hint added.", "ok"); again(); });
    $$("form[data-hint]", host).forEach((f) => bindForm(f, async (d) => { await PATCH(`${base}/hints/${f.dataset.hint}`, { content: d.content.trim(), cost: +d.cost || 0 }); return "Saved."; }));
    bindForm($("#upl", host), async (d, f) => {
      const files = [...$("[name=file]", f).files];
      if (!files.length) throw new Error("Choose a file first.");
      for (const file of files) {
        const fd = new FormData();
        fd.append("file", file);
        await api("POST", `${base}/challenges/${id}/files`, undefined, fd);
      }
      toast(files.length === 1 ? "File uploaded." : files.length + " files uploaded.", "ok"); again();
    });
    host.onclick = async (e) => {
      const t = e.target;
      try {
        const rf = t.closest("[data-rmflag]");
        if (rf && !rf.disabled && (await confirmBox("Remove flag?", "Players will no longer be able to use it.", "Remove"))) { await DEL(`${base}/challenges/${id}/flags/${rf.dataset.rmflag}`); again(); }
        const rh = t.closest("[data-rmhint]");
        if (rh && (await confirmBox("Delete hint?", "Teams that bought it get their points back.", "Delete"))) { await DEL(`${base}/hints/${rh.dataset.rmhint}`); again(); }
        const rm = t.closest("[data-rmfile]");
        if (rm && (await confirmBox("Delete file?", "Players won't be able to download it any more.", "Delete"))) { await DEL(`${base}/files/${rm.dataset.rmfile}`); again(); }
      } catch (err) { toast(err.message, "err"); }
    };
  }

  list().catch((e) => { box.innerHTML = `<div class="empty">${esc(e.message)}</div>`; });
}
