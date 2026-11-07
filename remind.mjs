// remind.mjs
// Sends push reminders through ntfy.sh for your class tracker.
// Runs from GitHub Actions every 15 minutes (see .github/workflows/remind.yml).
// It reads your tracker data from your private Gist, so it needs the GIST_ID secret.
import fs from "node:fs";

const { GIST_ID, GH_TOKEN, GITHUB_REPOSITORY = "" } = process.env;
const DRY = !!process.env.DRY;
const [owner = "", repoName = ""] = GITHUB_REPOSITORY.split("/");
const SITE = owner ? `https://${owner}.github.io/${repoName}/` : "";
const STATE_FILE = "reminder-state.json";
const TYPES = { R: "Regular holiday", S: "Special non-working day", W: "Special working day", D: "Davao City special non-working day" };
const HOL = {"2026-01-01": ["New Year’s Day", "R"], "2026-02-17": ["Chinese New Year", "S"], "2026-02-25": ["EDSA People Power Anniversary", "W"], "2026-03-16": ["Araw ng Dabaw (Davao City)", "D"], "2026-03-20": ["Eid’l Fitr", "R"], "2026-04-02": ["Maundy Thursday", "R"], "2026-04-03": ["Good Friday", "R"], "2026-04-04": ["Black Saturday", "S"], "2026-04-09": ["Araw ng Kagitingan", "R"], "2026-05-01": ["Labor Day", "R"], "2026-05-27": ["Eid’l Adha", "R"], "2026-06-12": ["Independence Day", "R"], "2026-08-14": ["Kadayawan (Davao City)", "D"], "2026-08-21": ["Ninoy Aquino Day", "S"], "2026-08-31": ["National Heroes Day", "R"], "2026-11-01": ["All Saints’ Day", "S"], "2026-11-02": ["All Souls’ Day", "S"], "2026-11-30": ["Bonifacio Day", "R"], "2026-12-08": ["Immaculate Conception", "S"], "2026-12-24": ["Christmas Eve", "S"], "2026-12-25": ["Christmas Day", "R"], "2026-12-30": ["Rizal Day", "R"], "2026-12-31": ["Last Day of the Year", "S"], "2027-01-01": ["New Year’s Day", "R"], "2027-02-06": ["Chinese New Year", "S"], "2027-02-25": ["EDSA People Power Anniversary", "W"], "2027-03-25": ["Maundy Thursday", "R"], "2027-03-26": ["Good Friday", "R"], "2027-03-27": ["Black Saturday", "S"], "2027-04-09": ["Araw ng Kagitingan", "R"], "2027-05-01": ["Labor Day", "R"], "2027-06-12": ["Independence Day", "R"], "2027-08-21": ["Ninoy Aquino Day", "S"], "2027-08-30": ["National Heroes Day", "R"], "2027-11-01": ["All Saints’ Day", "S"], "2027-11-02": ["All Souls’ Day", "S"], "2027-11-30": ["Bonifacio Day", "R"], "2027-12-08": ["Immaculate Conception", "S"], "2027-12-24": ["Christmas Eve", "S"], "2027-12-25": ["Christmas Day", "R"], "2027-12-30": ["Rizal Day", "R"], "2027-12-31": ["Last Day of the Year", "S"]};

if (!GIST_ID) { console.log("The GIST_ID secret is missing. Nothing to do."); process.exit(0); }

// ---- time in the Philippines (UTC+8, no daylight saving) ----
const nowMs = process.env.NOW ? Date.parse(process.env.NOW) : Date.now();
const ph = new Date(nowMs + 8 * 3600e3);
const pad = n => String(n).padStart(2, "0");
const ymd = d => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const today = ymd(ph), tomorrow = ymd(new Date(ph.getTime() + 864e5));
const nowMin = ph.getUTCHours() * 60 + ph.getUTCMinutes();
const dnum = s => Date.parse(s + "T00:00:00Z") / 864e5;
const diff = s => Math.round(dnum(s) - dnum(today));
const toMin = h => { const [a, b] = h.split(":").map(Number); return a * 60 + b; };
const t12 = h => { let [a, m] = h.split(":").map(Number); const p = a >= 12 ? "PM" : "AM"; a = a % 12 || 12; return a + ":" + pad(m) + " " + p; };

// ---- read the tracker data ----
async function getData() {
  for (const auth of [GH_TOKEN, ""]) {
    const headers = { Accept: "application/vnd.github+json", "User-Agent": "class-tracker-reminders" };
    if (auth) headers.Authorization = "Bearer " + auth;
    const r = await fetch("https://api.github.com/gists/" + GIST_ID, { headers });
    if (!r.ok) { console.log("Gist request failed:", r.status, auth ? "(with token)" : "(without token)"); continue; }
    const g = await r.json(), f = g.files && g.files["gwa.json"];
    if (!f) throw new Error("gwa.json not found in the gist");
    if (f.truncated && f.raw_url) return JSON.parse(await (await fetch(f.raw_url)).text());
    return JSON.parse(f.content);
  }
  throw new Error("Could not read the gist. Check the GIST_ID secret.");
}

const S = await getData();
const topic = S.ntfy;
if (!topic) { console.log("No notification topic yet. Create one in the app (Tasks tab, Push notifications)."); process.exit(0); }

// ---- sent-state (so each reminder is sent once) ----
let state = { sent: {} };
try { state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch {}
state.sent = state.sent || {};
const before = JSON.stringify(state);
for (const [k, v] of Object.entries(state.sent)) if (dnum(v) < dnum(today) - 3) delete state.sent[k];
const done = k => !!state.sent[k];
const mark = k => { state.sent[k] = today; };

async function send(title, message, priority = 3, tags = []) {
  if (DRY) { console.log("[DRY] " + title + "\n" + message + "\n"); return; }
  const r = await fetch("https://ntfy.sh", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ topic, title, message, priority, tags, ...(SITE ? { click: SITE } : {}) })
  });
  if (!r.ok) throw new Error("ntfy answered " + r.status);
}

// ---- collect what is due ----
const items = [];
(S.exams || []).forEach(e => { if (!e.done) items.push({ id: "d:" + e.id, kind: "d", date: e.date, time: e.time || "", label: (e.type || "Deadline") + (e.code ? " · " + e.code : "") + (e.title ? " · " + e.title : ""), note: e.pass || "" }); });
Object.entries(S.pri || {}).forEach(([d, L]) => (L || []).forEach(x => { if (!x.d) items.push({ id: "p:" + d + ":" + x.id, kind: "p", date: d, time: x.tm || "", label: "Priority · " + x.t, note: x.n || "" }); }));
// Thesis tasks and defense dates (same rules as the app: open dated tasks, Thesis 2 only after BCE 415 is completed, defenses are never overdue)
const T = S.th;
if (T && T.t) {
  const g415 = (S.g || {})["BCE 415"], n415 = (g415 === undefined || g415 === null || g415 === "") ? null : Number(g415);
  const st415 = (S.st || {})["BCE 415"];
  const thesis2 = (n415 === 7.1 || n415 === 7.2 || n415 === 1) ? false : (st415 ? st415 === "done" : n415 !== null);
  const who = w => (w === undefined || w === null || w === "all") ? "" : " (" + (((T.au || [])[+w] || "").trim() || "Member " + (+w + 1)) + ")";
  [1, 2].forEach(p => {
    if (p === 2 && !thesis2) return;
    ((T.t || {})[p] || []).forEach(x => { if (!x.done && x.d) items.push({ id: "th:" + x.id, kind: "th", date: x.d, time: "", label: "Thesis " + p + " · " + x.t + who(x.w), note: x.n || "" }); });
  });
  ((T.x && T.x.def) || []).forEach(x => { if (x.d) items.push({ id: "thd:" + x.id, kind: "def", date: x.d, time: x.tm || "", label: "🎤 " + x.ty + (x.th ? " · T" + x.th : ""), note: x.v ? "Venue: " + x.v : "" }); });
}
const byTime = (a, b) => (a.time || "99:99").localeCompare(b.time || "99:99");
const line = o => "• " + (o.time ? t12(o.time) + " · " : "") + o.label + (o.note ? " (" + o.note + ")" : "");
const dayItems = d => items.filter(o => o.date === d).sort(byTime);
const hol = d => HOL[d] ? HOL[d] : null;
const holLine = (d, word) => { const h = hol(d); if (!h) return ""; return "🇵🇭 " + word + ": " + h[0] + " (" + TYPES[h[1]] + ")" + (h[1] === "W" ? ", classes still hold" : ", usually no classes"); };

let sentCount = 0;
try {
  // 1) Morning summary, 7:00 to 11:59 AM
  if (nowMin >= 420 && nowMin < 720 && !done("dg|" + today)) {
    const parts = [];
    const hl = holLine(today, "Today"); if (hl) parts.push(hl);
    const od = items.filter(o => (o.kind === "d" || o.kind === "th") && diff(o.date) < 0 && diff(o.date) >= -7);
    if (od.length) parts.push("Overdue:\n" + od.map(line).join("\n"));
    const t = dayItems(today); if (t.length) parts.push("Today:\n" + t.map(line).join("\n"));
    const m = dayItems(tomorrow); if (m.length) parts.push("Tomorrow:\n" + m.map(line).join("\n"));
    if (parts.length) { await send("📚 Your day", parts.join("\n\n"), 3, ["books"]); sentCount++; }
    mark("dg|" + today);
  }
  // 2) Evening heads-up for tomorrow, 8:00 to 10:59 PM
  if (nowMin >= 1200 && nowMin < 1380 && !done("ev|" + today)) {
    const parts = [];
    const hl = holLine(tomorrow, "Tomorrow"); if (hl) parts.push(hl);
    const m = dayItems(tomorrow); if (m.length) parts.push(m.map(line).join("\n"));
    if (parts.length) { await send("🌙 Due tomorrow", parts.join("\n\n"), 3, ["crescent_moon"]); sentCount++; }
    mark("ev|" + today);
  }
  // 3) One hour before anything with a time today
  for (const o of dayItems(today)) {
    if (!o.time) continue;
    const k = "t|" + o.id + "|" + today, left = toMin(o.time) - nowMin;
    if (left <= 60 && left > -15 && !done(k)) {
      await send(left > 0 ? "⏰ In " + left + " min" : "⏰ Starting now", o.label + " at " + t12(o.time) + (o.note ? "\n" + o.note : ""), 4, ["alarm_clock"]);
      mark(k); sentCount++;
    }
  }
} finally {
  const after = JSON.stringify(state);
  if (after !== before && !DRY) fs.writeFileSync(STATE_FILE, after + "\n");
}
console.log("Done. Notifications sent:", sentCount, "| Manila time:", today, pad(ph.getUTCHours()) + ":" + pad(ph.getUTCMinutes()));
