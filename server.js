import express from "express";
import fetch from "node-fetch";
import multer from "multer";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 10000;

// ---------------- ENV ----------------
const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim();
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

const ADMIN_KEY = (process.env.ADMIN_KEY || "").trim();
const GAME_ORIGIN = (process.env.GAME_ORIGIN || "").trim(); // https://jamesawheel-stack.github.io

// IG (optional)
const IG_ACCESS_TOKEN = (process.env.IG_ACCESS_TOKEN || "").trim();
const REQUIRE_KEYWORD = (process.env.REQUIRE_KEYWORD || "").trim().toLowerCase();

// Counts (ONLY these)
const PLAYER_COUNT_MAX = Number(process.env.PLAYER_COUNT_MAX || 100); // hard cap (2..100)
const MIN_PLAYERS = 2;

// VIDEO STORAGE
const VIDEO_BUCKET = (process.env.VIDEO_BUCKET || "zorbi-videos").trim();
// If your bucket is PUBLIC, this can be "true". If it's private, we’ll generate a signed URL.
const VIDEO_BUCKET_PUBLIC = String(process.env.VIDEO_BUCKET_PUBLIC || "true").toLowerCase() === "true";
// Signed URL TTL seconds (only used if private)
const VIDEO_SIGNED_TTL = Number(process.env.VIDEO_SIGNED_TTL || 60 * 60 * 24 * 7); // 7 days

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
  }
  // NOTE: multipart/form-data uploads still use Content-Type header
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-admin-key");

  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

// ---------------- HELPERS ----------------
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
  if (!ADMIN_KEY) return true; // allow if unset
  return req.headers["x-admin-key"] === ADMIN_KEY;
}

function safeStr(s, maxLen = 80) {
  return (s ?? "").toString().slice(0, maxLen);
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

// Dedupes multiple comments from same account
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
      handle: username,
      source: "comment",
      comment_id: c.id || null,
      comment_text: c.text || "",
      comment_ts: c.timestamp || null,
    });
  }

  const picked = shuffle(uniq).slice(0, cap);

  // add slots + consistent schema
  return picked.map((p, i) => ({
    slot: i + 1,
    handle: p.handle,
    img: null,
    source: p.source,
    comment_id: p.comment_id,
    comment_text: p.comment_text,
    comment_ts: p.comment_ts,
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
async function generateRound({ requestedMaxPlayers } = {}) {
  const round_date = todayIdUTC();
  const seed = randSeed();

  let mode = "training";
  let post = null;
  let players = [];
  let claimed_total = 0;

  // If caller passes ?max=72, use it as the training size and as a *cap*
  const cap = clampInt(
    requestedMaxPlayers ?? PLAYER_COUNT_MAX,
    MIN_PLAYERS,
    PLAYER_COUNT_MAX
  );

  // -------- TRY LIVE MODE --------
  if (IG_ACCESS_TOKEN) {
    try {
      const latest = await getLatestMedia();
      if (latest?.id) {
        post = latest;

        const comments = await getComments(latest.id);
        const livePlayers = buildLivePlayersFromComments(comments, PLAYER_COUNT_MAX);

        claimed_total = livePlayers.length;

        if (claimed_total >= MIN_PLAYERS) {
          mode = "live";

          // dynamic 2..PLAYER_COUNT_MAX, respect ?max=
          const finale_count = clampInt(Math.min(claimed_total, cap), MIN_PLAYERS, PLAYER_COUNT_MAX);
          players = livePlayers.slice(0, finale_count);
        }
      }
    } catch (err) {
      mode = "training";
    }
  }

  // -------- TRAINING FALLBACK --------
  if (mode !== "live") {
    mode = "training";
    claimed_total = cap;
    const finale_count = clampInt(claimed_total, MIN_PLAYERS, PLAYER_COUNT_MAX);
    players = buildTrainingPlayers(finale_count);
  }

  const finale_count = clampInt(players.length, MIN_PLAYERS, PLAYER_COUNT_MAX);

  const row = {
    round_date,
    mode,
    status: "pending",
    claimed_total,
    finale_count,
    seed,
    post,
    players,
    winner: null,
    winner_slot: null,
    winner_set_at: null,

    // optional columns you mentioned:
    video_url: null,
    video_storage_path: null,
    error_message: null,
  };

  await upsertRound(row);
  return row;
}

// ---------------- VIDEO UPLOAD (AUTO-RECORD) ----------------
// Memory upload (no disk). Limit to ~80MB.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 80 * 1024 * 1024 },
});

async function storeVideoAndUpdateRound({ round_date, buffer, contentType }) {
  const safeDate = round_date || todayIdUTC();
  const path = `${safeDate}/zorbi-${safeDate}.webm`;

  const up = await supabase.storage
    .from(VIDEO_BUCKET)
    .upload(path, buffer, {
      contentType: contentType || "video/webm",
      upsert: true,
    });

  if (up.error) throw new Error(`Storage upload failed: ${up.error.message}`);

  let video_url = null;

  if (VIDEO_BUCKET_PUBLIC) {
    const pub = supabase.storage.from(VIDEO_BUCKET).getPublicUrl(path);
    video_url = pub?.data?.publicUrl || null;
  } else {
    const signed = await supabase.storage
      .from(VIDEO_BUCKET)
      .createSignedUrl(path, VIDEO_SIGNED_TTL);

    if (signed.error) throw new Error(`Signed URL failed: ${signed.error.message}`);
    video_url = signed?.data?.signedUrl || null;
  }

  const { error } = await supabase
    .from("rounds")
    .update({
      video_storage_path: path,
      video_url,
      error_message: null,
    })
    .eq("round_date", safeDate);

  if (error) throw new Error(`Round update failed: ${error.message}`);

  return { video_storage_path: path, video_url };
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
    minPlayers: MIN_PLAYERS,
    gameOrigin: GAME_ORIGIN || null,

    videoBucket: VIDEO_BUCKET,
    videoBucketPublic: VIDEO_BUCKET_PUBLIC,
    videoSignedTTL: VIDEO_SIGNED_TTL,
  });
});

// Admin page
app.get("/admin", (req, res) => {
  res.send(`
    <h2>Zorbblez Admin</h2>
    <p>Generate today’s round (live if possible, else training).</p>
    <p>Optional test size: <code>/admin/generate?max=72</code></p>
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

  const requestedMaxPlayers = req.query?.max;

  try {
    const round = await generateRound({ requestedMaxPlayers });
    res.json({ ok: true, ...round });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// Game reads today’s round
app.get("/top50.json", async (req, res) => {
  try {
    let round = await getTodayRound();
    if (!round) round = await generateRound();
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
      .from("rounds")
      .update({
        status: "complete",
        winner: winner || null,
        winner_slot,
        winner_set_at: new Date().toISOString(),
      })
      .eq("round_date", round_date);

    if (error) return res.status(500).json({ ok: false, error: error.message });

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ✅ VIDEO UPLOAD: frontend posts recorded video here
app.post("/round/today/video", upload.single("video"), async (req, res) => {
  try {
    const round_date = safeStr(req.body?.round_date, 32) || todayIdUTC();

    if (!req.file?.buffer || !req.file?.size) {
      return res.status(400).json({ ok: false, error: "No video file uploaded (field name must be 'video')" });
    }

    const contentType = req.file.mimetype || "video/webm";
    const out = await storeVideoAndUpdateRound({
      round_date,
      buffer: req.file.buffer,
      contentType,
    });

    res.json({ ok: true, round_date, ...out });
  } catch (e) {
    // try to persist error into rounds table
    try {
      await supabase
        .from("rounds")
        .update({ error_message: String(e?.message || e) })
        .eq("round_date", todayIdUTC());
    } catch (_) {}

    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ✅ QUICK CHECK: returns stored video url for today (if present)
app.get("/round/today/video", async (req, res) => {
  try {
    const round = await getTodayRound();
    if (!round) return res.status(404).json({ ok: false, error: "No round for today" });

    res.json({
      ok: true,
      round_date: round.round_date,
      video_url: round.video_url || null,
      video_storage_path: round.video_storage_path || null,
      error_message: round.error_message || null,
      status: round.status || null,
    });
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

// IG bio helper (full 5-line bio + reigning leader w/ win count)
app.get("/bio.txt", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("rounds")
      .select("winner")
      .not("winner", "is", null);

    if (error) return res.status(500).send("Error");

    // Count wins per winner
    const counts = {};
    for (const r of data || []) {
      const w = (r.winner || "").trim();
      if (!w) continue;
      counts[w] = (counts[w] || 0) + 1;
    }

    // Top 1 winner (reigning leader)
    let leader = null;
    let leaderWins = 0;

    const entries = Object.entries(counts);
    if (entries.length) {
      entries.sort((a, b) => b[1] - a[1]);
      leader = entries[0][0] || null;
      leaderWins = Number(entries[0][1] || 0);
    }

    // Ensure exactly one @ prefix
    const leaderTag = leader
      ? "@" + String(leader).replace(/^@+/, "")
      : "TBD";

    const winsText = leader ? ` (${leaderWins})` : "";

    const bio =
`🫧 Only 1 bubble survives
🤖 Arcade elimination game
⚡ New round daily
👇 Comment “IN” to enter
🏆 Reigning Leader: ${leaderTag}${winsText}`;

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.send(bio);
  } catch (e) {
    res.status(500).send("Error");
  }
});

app.listen(PORT, () => console.log("Listening on", PORT));
