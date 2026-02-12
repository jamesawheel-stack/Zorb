import express from "express";
import fetch from "node-fetch";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 10000;

// ---------------- ENV ----------------
const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim();
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

const ADMIN_KEY = (process.env.ADMIN_KEY || "").trim();
const GAME_ORIGIN = (process.env.GAME_ORIGIN || "").trim(); // e.g. https://username.github.io

// IG (optional)
const IG_ACCESS_TOKEN = (process.env.IG_ACCESS_TOKEN || "").trim();
const REQUIRE_KEYWORD = (process.env.REQUIRE_KEYWORD || "").trim().toLowerCase();

// Counts
const PLAYER_COUNT_MAX = Number(process.env.PLAYER_COUNT_MAX || 100); // hard cap
const FINALE_COUNT_DEFAULT = Number(process.env.FINALE_COUNT_DEFAULT || 50); // finale target
const MIN_PLAYERS = 2;

// ---------------- SUPABASE ----------------
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.warn("⚠️ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
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
    // If you want to test from anywhere temporarily, uncomment:
    // res.setHeader("Access-Control-Allow-Origin", "*");
  }

  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, x-admin-key"
  );

  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

// ---------------- UTILS ----------------
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function todayIdUTC() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

function randSeed() {
  return Date.now() * 1000 + Math.floor(Math.random() * 1000);
}

function clampInt(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return min;
  return Math.max(min, Math.min(max, Math.floor(x)));
}

function qualifies(text = "") {
  if (!REQUIRE_KEYWORD) return true;
  return String(text).toLowerCase().includes(REQUIRE_KEYWORD);
}

function requireAdmin(req) {
  if (!ADMIN_KEY) return true; // allow if unset
  return req.headers["x-admin-key"] === ADMIN_KEY;
}

function safeStr(s, maxLen = 80) {
  return (s ?? "").toString().slice(0, maxLen);
}

// Deterministic winner from seed
function pickWinnerSlot(seed, playerCount) {
  // simple deterministic pseudo-random based on seed
  const x = Math.sin(seed) * 10000;
  const frac = x - Math.floor(x);
  return Math.floor(frac * playerCount) + 1;
}

// ---------------- IG HELPERS (optional) ----------------
async function igFetchJson(url) {
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.error) {
    const msg = data?.error?.message || JSON.stringify(data);
    throw new Error(msg);
  }
  return data;
}

async function getLatestMedia() {
  const url =
    `https://graph.instagram.com/me/media` +
    `?fields=id,permalink,timestamp,caption` +
    `&limit=10` +
    `&access_token=${IG_ACCESS_TOKEN}`;

  const data = await igFetchJson(url);
  if (!Array.isArray(data.data) || data.data.length === 0) return null;

  data.data.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  return data.data[0] || null;
}

async function getComments(mediaId) {
  let url =
    `https://graph.instagram.com/${mediaId}/comments` +
    `?fields=id,username,text,timestamp` +
    `&limit=50` +
    `&access_token=${IG_ACCESS_TOKEN}`;

  const all = [];
  while (url) {
    const data = await igFetchJson(url);
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

function buildLivePlayersFromComments(comments, cap) {
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
      username,
      text: c.text || "",
      comment_id: c.id || null,
      timestamp: c.timestamp || null,
    });
  }

  const picked = shuffle(uniq).slice(0, cap);
  return picked.map((c, i) => ({
    slot: i + 1,
    handle: c.username,
    img: null, // profile pics are not reliably available via Basic Display
    source: "comment",
    comment_id: c.comment_id,
    comment_text: c.text,
    comment_ts: c.timestamp,
  }));
}

// ---------------- DB HELPERS ----------------
async function upsertRound(row) {
  const { error } = await supabase
    .from("rounds")
    .upsert(row, { onConflict: "round_date" });

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
async function generateRound() {
  const round_date = todayId();
  const seed = randSeed();

  let mode = "training";
  let post = null;
  let players = [];
  let claimed_total = 0;

  // -------- TRY LIVE MODE --------
  if (IG_ACCESS_TOKEN) {
    try {
      const latest = await getLatestMedia();

      if (latest?.id) {
        post = latest;

        const comments = await getComments(latest.id);

        // Deduplicate by username
        const seen = new Set();
        const unique = [];

        for (const c of comments) {
          const username = (c.username || "").trim();
          if (!username) continue;

          const key = username.toLowerCase();
          if (seen.has(key)) continue;
          if (!qualifies(c.text)) continue;

          seen.add(key);
          unique.push({
            handle: username,
            source: "comment"
          });
        }

        claimed_total = unique.length;

        if (claimed_total >= MIN_PLAYERS) {
          mode = "live";

          // Deterministic shuffle
          const shuffled = shuffle(unique);

          const finale_count = Math.max(
            MIN_PLAYERS,
            Math.min(claimed_total, PLAYER_COUNT_MAX)
          );

          players = shuffled.slice(0, finale_count);

        } else {
          mode = "training";
        }
      }
    } catch (err) {
      // Fail gracefully into training mode
      mode = "training";
    }
  }

  // -------- TRAINING FALLBACK --------
  if (mode === "training") {
    claimed_total = Math.max(MIN_PLAYERS, FINALE_COUNT_DEFAULT);

    players = [];
    for (let i = 0; i < claimed_total; i++) {
      players.push({
        handle: `#${i + 1}`,
        source: "training"
      });
    }
  }

  // -------- FINALIZE FINALE COUNT --------
  const finale_count = Math.max(
    MIN_PLAYERS,
    Math.min(claimed_total, PLAYER_COUNT_MAX)
  );

  players = players.slice(0, finale_count);

const winner_slot = pickWinnerSlot(seed, players.length);
const winner_player = players.find(p => p.slot === winner_slot);

const row = {
  round_date,
  mode,
  status: "pending",
  claimed_total,
  finale_count,
  seed,
  post,     // jsonb
  players,  // jsonb
  winner_slot,
  winner: winner_player?.handle || null,
  winner_set_at: null,
};
  
  // Add slot numbering
  players = players.map((p, i) => ({
    slot: i + 1,
    handle: p.handle,
    img: null,
    source: p.source
  }));

  const row = {
    round_date,
    mode,
    status: "ready",
    claimed_total,
    finale_count,
    seed,
    post,
    players,
    winner,
    winner_slot: winnerIndex + 1,
    winner_set_at: null
  };

  const { error } = await supabase
    .from("rounds")
    .upsert(row, { onConflict: "round_date" });

  if (error) {
    throw new Error(`Supabase upsert failed: ${error.message}`);
  }

  return row;
}

// ---------------- ROUTES ----------------
app.get("/", (req, res) => {
  res.json({ ok: true, service: "zorbblez-backend" });
});

// Quick sanity check (no secrets)
app.get("/api/envcheck", (req, res) => {
  res.json({
    ok: true,
    hasSupabaseUrl: !!SUPABASE_URL,
    hasSupabaseServiceKey: !!SUPABASE_KEY,
    hasAdminKey: !!ADMIN_KEY,
    hasIgAccessToken: !!IG_ACCESS_TOKEN,
    requireKeyword: REQUIRE_KEYWORD || null,
    playerCountMax: PLAYER_COUNT_MAX,
    finaleDefault: FINALE_COUNT_DEFAULT,
    gameOrigin: GAME_ORIGIN || null,
  });
});

// Admin page
app.get("/admin", (req, res) => {
  res.send(`
    <h2>Zorbblez Admin</h2>
    <p>Generate today’s round (live if possible, else training).</p>
    <input id="key" placeholder="Admin Key" style="width:340px;padding:6px;" />
    <button onclick="gen()" style="padding:6px 10px;">Generate</button>
    <pre id="out" style="white-space:pre-wrap;"></pre>
    <script>
      async function gen(){
        const key = document.getElementById('key').value;
        const res = await fetch('/admin/generate', {
          method:'POST',
          headers:{'x-admin-key':key}
        });
        document.getElementById('out').textContent = JSON.stringify(await res.json(), null, 2);
      }
    </script>
  `);
});

app.post("/admin/generate", async (req, res) => {
  if (!requireAdmin(req)) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  // optional override: /admin/generate?max=72
  const requestedMaxPlayers = req.query?.max;

  try {
    const round = await generateRound({ requestedMaxPlayers });
    res.json({ ok: true, ...round });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// Game reads today’s round (name kept for compatibility)
app.get("/top50.json", async (req, res) => {
  try {
    let round = await getTodayRound();
    if (!round) {
      // auto-generate if not created yet
      round = await generateRound();
    }
    res.json(round);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// Winner reporting (called by the game)
app.post("/round/today/winner", async (req, res) => {
  try {
    const round_date = todayIdUTC();
    const winner = safeStr(req.body?.winner, 64);
    const winnerSlotRaw = req.body?.winnerSlot;

    const winner_slot = Number.isFinite(Number(winnerSlotRaw))
      ? Number(winnerSlotRaw)
      : null;

    const { error } = await supabase
      .from("rounds") // ✅ FIXED: rounds table only
      .update({
        status: "complete",
        winner: winner || null,
        winner_slot,
        winner_set_at: new Date().toISOString(),
      })
      .eq("round_date", round_date);

    if (error) {
      return res.status(500).json({ ok: false, error: error.message });
    }

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// Leaderboard JSON
app.get("/leaderboard.json", async (req, res) => {
  const { data, error } = await supabase
    .from("rounds")
    .select("winner")
    .not("winner", "is", null);

  if (error) return res.status(500).json({ ok: false, error: error.message });

  const counts = {};
  for (const r of data || []) {
    const w = r.winner;
    if (!w) continue;
    counts[w] = (counts[w] || 0) + 1;
  }

  const sorted = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([handle, wins]) => ({ handle, wins }));

  res.json(sorted);
});

// IG bio helper
app.get("/bio.txt", async (req, res) => {
  const { data, error } = await supabase
    .from("rounds")
    .select("winner")
    .not("winner", "is", null);

  if (error) return res.status(500).send("Error");

  const counts = {};
  for (const r of data || []) {
    const w = r.winner;
    if (!w) continue;
    counts[w] = (counts[w] || 0) + 1;
  }

  const top = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([h, c]) => `@${h}(${c})`)
    .join(" • ");

  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.send(`🏆 Top: ${top || "TBD"}`);
});

app.listen(PORT, () => console.log("Listening on", PORT));
