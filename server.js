import express from "express";
import fetch from "node-fetch";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 10000;

// ---------------- ENV ----------------
const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim();
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

const ADMIN_KEY = (process.env.ADMIN_KEY || "").trim();
const GAME_ORIGIN = (process.env.GAME_ORIGIN || "").trim(); // e.g. https://<user>.github.io

// Instagram Graph API (EAAY token)
const IG_ACCESS_TOKEN = (process.env.IG_ACCESS_TOKEN || "").trim(); // EAAY...
const IG_USER_ID = (process.env.IG_USER_ID || "").trim(); // IG Business Account ID

const REQUIRE_KEYWORD = (process.env.REQUIRE_KEYWORD || "").trim().toLowerCase();

const PLAYER_COUNT_MAX = Number(process.env.PLAYER_COUNT_MAX || 100);
const MIN_PLAYERS = 2;

/**
 * IMPORTANT: These MUST match your Supabase ENUM values exactly.
 * Set these as Render env vars so you never have to edit code again.
 */
const ROUND_STATUS_PENDING = (process.env.ROUND_STATUS_PENDING || "pending").trim();
const ROUND_STATUS_DONE = (process.env.ROUND_STATUS_DONE || "rendered").trim();

const ROUND_MODE_TRAINING = (process.env.ROUND_MODE_TRAINING || "training").trim();
const ROUND_MODE_LIVE = (process.env.ROUND_MODE_LIVE || "live").trim();

// ---------------- SUPABASE ----------------
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.warn("â ï¸ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
});

// ---------------- CORS ----------------
app.use((req, res, next) => {
  if (GAME_ORIGIN) {
    res.setHeader("Access-Control-Allow-Origin", GAME_ORIGIN);
    res.setHeader("Vary", "Origin");
  } else {
    // safer fallback if GAME_ORIGIN is not set
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-admin-key");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

// ---------------- HELPERS ----------------
function todayIdUTC() {
  return new Date().toISOString().slice(0, 10);
}
function yesterdayIdUTC() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
function randSeed() {
  return Date.now() * 1000 + Math.floor(Math.random() * 1000);
}
function clampInt(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return min;
  return Math.max(min, Math.min(max, Math.floor(x)));
}
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function qualifies(text = "") {
  if (!REQUIRE_KEYWORD) return true;
  return String(text).toLowerCase().includes(REQUIRE_KEYWORD);
}
function requireAdmin(req) {
  if (!ADMIN_KEY) return true;
  return req.headers["x-admin-key"] === ADMIN_KEY;
}
function safeStr(s, maxLen = 80) {
  return (s ?? "").toString().slice(0, maxLen);
}

// ---------------- IG GRAPH HELPERS ----------------
async function graphFetchJson(url) {
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.error) {
    const msg = data?.error?.message || JSON.stringify(data);
    throw new Error(msg);
  }
  return data;
}

async function getLatestMedia() {
  if (!IG_ACCESS_TOKEN || !IG_USER_ID) return null;

  const url =
    `https://graph.facebook.com/v19.0/${IG_USER_ID}/media` +
    `?fields=id,permalink,timestamp,caption` +
    `&limit=10` +
    `&access_token=${encodeURIComponent(IG_ACCESS_TOKEN)}`;

  const data = await graphFetchJson(url);
  if (!Array.isArray(data.data) || data.data.length === 0) return null;

  data.data.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  return data.data[0] || null;
}

async function getComments(mediaId) {
  if (!IG_ACCESS_TOKEN || !mediaId) return [];
  let url =
    `https://graph.facebook.com/v19.0/${mediaId}/comments` +
    `?fields=id,username,text,timestamp` +
    `&limit=50` +
    `&access_token=${encodeURIComponent(IG_ACCESS_TOKEN)}`;

  const all = [];
  while (url) {
    const data = await graphFetchJson(url);
    all.push(...(data.data || []));
    url = data.paging?.next || null;
  }
  return all;
}

// ---------------- PLAYER BUILDERS ----------------
function buildTrainingPlayers(count) {
  return Array.from({ length: count }, (_, i) => ({
    slot: i + 1,
    handle: `#${i + 1}`,
    img: null,
    source: "training",
  }));
}

function buildLivePlayersFromComments(comments, pickCap) {
  const seen = new Set();
  const uniq = [];

  for (const c of comments || []) {
    const username = (c.username || "").trim();
    if (!username) continue;

    const key = username.toLowerCase();
    if (seen.has(key)) continue;
    if (!qualifies(c.text)) continue;

    seen.add(key);
    uniq.push({
      handle: username,
      source: "comment",
      comment_id: c.id || null,
      comment_text: c.text || "",
      comment_ts: c.timestamp || null,
    });
  }

  const claimed_total = uniq.length;
  const picked = shuffle(uniq).slice(0, pickCap);

  const players = picked.map((p, i) => ({
    slot: i + 1,
    handle: p.handle,
    img: null,
    source: p.source,
    comment_id: p.comment_id,
    comment_text: p.comment_text,
    comment_ts: p.comment_ts,
  }));

  return { claimed_total, players };
}


// ---------------- DB HELPERS ----------------
async function upsertRound(row) {
  const { error } = await supabase.from("rounds").upsert(row, { onConflict: "round_date" });
  if (error) throw new Error(`Supabase upsert failed: ${error.message}`);
}
async function getTodayRound() {
  const { data, error } = await supabase
    .from("rounds")
    .select("*")
    .eq("round_date", todayIdUTC())
    .single();
  if (error) return null;
  return data;
}

// ---------------- ROUND GENERATION ----------------
async function generateRound({ requestedMaxPlayers } = {}) {
  const round_date = todayIdUTC();
  const seed = randSeed();

  const cap = clampInt(
    requestedMaxPlayers ?? PLAYER_COUNT_MAX,
    MIN_PLAYERS,
    PLAYER_COUNT_MAX
  );

  let mode = ROUND_MODE_TRAINING;
  let post = null;
  let players = [];
  let claimed_total = 0;

  // Try live mode (IG Graph)
  if (IG_ACCESS_TOKEN && IG_USER_ID) {
    try {
      const latest = await getLatestMedia();
      if (latest?.id) {
        post = latest;

        const comments = await getComments(latest.id);
        const live = buildLivePlayersFromComments(comments, PLAYER_COUNT_MAX);

        claimed_total = live.claimed_total;
        const livePlayers = live.players;

        if (claimed_total >= MIN_PLAYERS) {
          mode = ROUND_MODE_LIVE; // <-- enum-safe via env
          const finale_count = clampInt(Math.min(claimed_total, cap), MIN_PLAYERS, PLAYER_COUNT_MAX);
          players = livePlayers.slice(0, finale_count);
        }
      }
    } catch (err) {
      console.warn("Live mode failed; falling back to training:", err?.message || err);
      mode = ROUND_MODE_TRAINING;
    }
  }

  // Training fallback
  if (mode !== ROUND_MODE_LIVE) {
    mode = ROUND_MODE_TRAINING;
    claimed_total = cap;
    players = buildTrainingPlayers(cap);
  }

  const finale_count = clampInt(players.length, MIN_PLAYERS, PLAYER_COUNT_MAX);

  const row = {
    round_date,
    mode, // must match your Supabase enum values
    status: ROUND_STATUS_PENDING, // must match enum
    claimed_total,
    finale_count,
    seed,
    post, // jsonb
    players, // jsonb array
    winner: null,
    winner_slot: null,
    winner_set_at: null,
  };

  await upsertRound(row);
  return row;
}

// ---------------- ROUTES ----------------
app.get("/", (req, res) => res.json({ ok: true, service: "zorbi-backend" }));

app.get("/api/envcheck", (req, res) => {
  res.json({
    ok: true,
    hasSupabaseUrl: !!SUPABASE_URL,
    hasSupabaseServiceKey: !!SUPABASE_KEY,
    hasAdminKey: !!ADMIN_KEY,
    hasIgAccessToken: !!IG_ACCESS_TOKEN,
    igUserId: IG_USER_ID || null,
    requireKeyword: REQUIRE_KEYWORD || null,
    playerCountMax: PLAYER_COUNT_MAX,
    minPlayers: MIN_PLAYERS,
    gameOrigin: GAME_ORIGIN || null,

    // show these so you can confirm enum strings at runtime
    roundStatusPending: ROUND_STATUS_PENDING,
    roundStatusDone: ROUND_STATUS_DONE,
    roundModeTraining: ROUND_MODE_TRAINING,
    roundModeLive: ROUND_MODE_LIVE,
  });
});

app.get("/admin", (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`
    <h2>Zorbi Admin</h2>
    <p>Generate todayâs round (live if possible, else training).</p>
    <p>Optional test size: <code>/admin/generate?max=72</code></p>
    <input id="key" placeholder="Admin Key" style="width:340px;padding:6px;" />
    <button onclick="gen()" style="padding:6px 10px;">Generate</button>
    <pre id="out" style="white-space:pre-wrap;"></pre>
    <script>
      async function gen(){
        const key = document.getElementById('key').value;
        const res = await fetch('/admin/generate', { method:'POST', headers:{'x-admin-key':key} });
        document.getElementById('out').textContent = JSON.stringify(await res.json(), null, 2);
      }
    </script>
  `);
});

app.post("/admin/generate", async (req, res) => {
  if (!requireAdmin(req)) return res.status(401).json({ ok: false, error: "Unauthorized" });

  const requestedMaxPlayers = req.query?.max;
  try {
    const round = await generateRound({ requestedMaxPlayers });
    res.json({ ok: true, ...round });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get("/top50.json", async (req, res) => {
  try {
    let round = await getTodayRound();
    if (!round) round = await generateRound();
    res.json(round);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post("/round/today/winner", async (req, res) => {
  try {
    const round_date = todayIdUTC();
    const winner = safeStr(req.body?.winner, 64);
    const winnerSlotRaw = req.body?.winnerSlot;
    const winner_slot = Number.isFinite(Number(winnerSlotRaw)) ? Math.trunc(Number(winnerSlotRaw)) : null;

    const { error } = await supabase
      .from("rounds")
      .update({
        status: ROUND_STATUS_DONE, // enum-safe via env
        winner: winner || null,
        winner_slot,
        winner_set_at: new Date().toISOString(), // timestamptz
      })
      .eq("round_date", round_date);

    if (error) return res.status(500).json({ ok: false, error: error.message });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get("/round/today/winner", async (req, res) => {
  try {
    const round_date = todayIdUTC();

    const { data, error } = await supabase
      .from("rounds")
      .select("round_date,status,mode,winner,winner_slot,winner_set_at")
      .eq("round_date", round_date)
      .single();

    if (error) return res.status(404).json({ ok: false, error: error.message });

    res.json({ ok: true, ...data });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// 5-line IG bio text (latest winner)
app.get("/bio.txt", async (req, res) => {
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  // prevent iOS / proxies caching stale bio
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Surrogate-Control", "no-store");

  try {
    // Find most recent round that actually has a winner
    const { data, error } = await supabase
      .from("rounds")
      .select("round_date,winner")
      .not("winner", "is", null)
      .order("round_date", { ascending: false })
      .limit(1);

    const latest = (!error && Array.isArray(data) && data[0]) ? data[0] : null;
    const latestWinner = latest?.winner ? `@${String(latest.winner).trim()}` : "TBD";

    res.send(
`🫧 Only 1 bubble survives.
🤖 Daily arcade elimination arena
🏆 Latest winner: ${latestWinner}
👇 Follow + comment “IN” to enter`
    );
  } catch (e) {
    res.send(
`🫧 Only 1 bubble survives.
🤖 Daily Arcade elimination arena
🏆 Latest winner: TBD
👇 Follow + comment “IN” to enter`
    );
  }
});

app.listen(PORT, () => console.log("Listening on", PORT));
