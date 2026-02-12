import express from "express";
import fetch from "node-fetch";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;

// ---------------- ENV ----------------
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

const ADMIN_KEY = process.env.ADMIN_KEY || "";
const GAME_ORIGIN = process.env.GAME_ORIGIN || ""; // e.g. https://yourgame.com or https://username.github.io

// IG (optional for hybrid)
const IG_ACCESS_TOKEN = (process.env.IG_ACCESS_TOKEN || "").trim();
const REQUIRE_KEYWORD = (process.env.REQUIRE_KEYWORD || "").trim().toLowerCase();

// counts
const PLAYER_COUNT_MAX = Number(process.env.PLAYER_COUNT_MAX || 100); // hard cap
const FINALE_COUNT_DEFAULT = Number(process.env.FINALE_COUNT_DEFAULT || 50); // game finale size target
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
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-admin-key");
  }
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

function todayId() {
  // local “date id” in ISO UTC; good enough for daily round tracking
  return new Date().toISOString().slice(0, 10);
}

function randSeed() {
  // bigint-safe-ish as JS number; stored as text/bigint in DB if desired
  return Date.now() * 1000 + Math.floor(Math.random() * 1000);
}

function qualifies(text = "") {
  if (!REQUIRE_KEYWORD) return true;
  return String(text).toLowerCase().includes(REQUIRE_KEYWORD);
}

function clampInt(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return min;
  return Math.max(min, Math.min(max, Math.floor(x)));
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
  // Requires IG Basic Display / graph.instagram.com
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

// ---------------- ROUND GENERATION (HYBRID) ----------------
function buildTrainingPlayers(count) {
  const players = [];
  for (let i = 0; i < count; i++) {
    players.push({
      slot: i + 1,
      handle: `#${i + 1}`,
      img: null,
      source: "training",
    });
  }
  return players;
}

function buildLivePlayersFromComments(comments, desiredCount) {
  // unique usernames, first qualifying comment counts
  const seen = new Set();
  const uniq = [];
  for (const c of comments) {
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

  const picked = shuffle(uniq).slice(0, desiredCount);
  return picked.map((c, i) => ({
    slot: i + 1,
    handle: c.username,
    img: null, // (we can add profile pic pulling later; not reliable via Basic Display)
    source: "comment",
    comment_id: c.comment_id,
    comment_text: c.text,
    comment_ts: c.timestamp,
  }));
}

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
    .eq("round_date", todayId())
    .single();

  if (error) return null;
  return data;
}

async function generateRound({ requestedMaxPlayers } = {}) {
  const round_date = todayId();
  const seed = randSeed();

  // You want “max followers up to 100” eventually; for now:
  // - if live mode: use up to PLAYER_COUNT_MAX from qualifying commenters
  // - if training: default to FINALE_COUNT_DEFAULT (or requested)
  const desired = clampInt(
    requestedMaxPlayers ?? FINALE_COUNT_DEFAULT,
    MIN_PLAYERS,
    PLAYER_COUNT_MAX
  );

  let mode = "training";
  let post = null;
  let players = buildTrainingPlayers(desired);
  let claimed_total = desired;

  // Try live only if token exists
  if (IG_ACCESS_TOKEN) {
    try {
      const latest = await getLatestMedia();
      if (latest?.id) {
        post = latest;
        const comments = await getComments(latest.id);
        const livePlayers = buildLivePlayersFromComments(comments, PLAYER_COUNT_MAX);

        if (livePlayers.length >= MIN_PLAYERS) {
          mode = "live";
          // If you want “max available up to 100”, do it here:
          const liveCount = clampInt(livePlayers.length, MIN_PLAYERS, PLAYER_COUNT_MAX);
          players = livePlayers.slice(0, liveCount);
          claimed_total = liveCount;
        } else {
          // keep training, but still attach post metadata
          mode = "training";
        }
      }
    } catch (e) {
      // Any IG failure -> training fallback (but don’t crash the service)
      mode = "training";
    }
  }

  // finale_count should be <= claimed_total, and at least 2
  const finale_count = clampInt(
    Math.min(FINALE_COUNT_DEFAULT, claimed_total),
    MIN_PLAYERS,
    claimed_total
  );

  const row = {
    round_date,
    mode,
    status: "pending",
    claimed_total,
    finale_count,
    seed,
    post,    // jsonb (nullable)
    players, // jsonb
    winner: null,
    winner_slot: null,
    winner_set_at: null,
  };

  await upsertRound(row);
  return row;
}

// ---------------- ROUTES ----------------
app.get("/", (req, res) => {
  res.json({ ok: true, service: "zorbblez-backend" });
});

// Quick sanity check (no secrets leaked)
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

// Admin UI (simple)
app.get("/admin", (req, res) => {
  res.send(`
    <h2>Zorbblez Admin</h2>
    <p>Hybrid mode: uses IG if possible, else training.</p>
    <input id="key" placeholder="Admin Key" style="width:320px; padding:6px;" />
    <button onclick="gen()" style="padding:6px 10px;">Generate Today’s Round</button>
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
  if (ADMIN_KEY && req.headers["x-admin-key"] !== ADMIN_KEY) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  try {
    const round = await generateRound();
    res.json({ ok: true, ...round });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// Game reads today’s round
app.get("/top50.json", async (req, res) => {
  let round = await getTodayRound();
  if (!round) {
    // If nobody generated yet today, auto-generate a training/live hybrid
    round = await generateRound();
  }
  res.json(round);
});

// Winner reporting (called by the game)
app.post("/round/today/winner", async (req, res) => {
  const { winner, winnerSlot } = req.body || {};
  const round_date = todayId();

  const safeWinner = (winner || "").toString().slice(0, 64);
  const safeSlot = Number.isFinite(Number(winnerSlot)) ? Number(winnerSlot) : null;

  const { error } = await supabase
    .from("zorbblez_rounds")
    .update({
      status: "complete",
      winner: safeWinner || null,
      winner_slot: safeSlot,
      winner_set_at: new Date().toISOString(),
    })
    .eq("round_date", round_date);

  if (error) return res.status(500).json({ ok: false, error: error.message });
  res.json({ ok: true });
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

// “Bio line” helper
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
