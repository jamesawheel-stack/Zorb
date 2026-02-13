import express from "express";
import fetch from "node-fetch";
import { createClient } from "@supabase/supabase-js";
import multer from "multer";
import os from "os";
import fs from "fs";
import crypto from "crypto";

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 10000;

// ---------------- ENV ----------------
const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim();
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

const ADMIN_KEY = (process.env.ADMIN_KEY || "").trim();
const GAME_ORIGIN = (process.env.GAME_ORIGIN || "").trim(); // e.g. https://jamesawheel-stack.github.io

// IG (optional)
const IG_ACCESS_TOKEN = (process.env.IG_ACCESS_TOKEN || "").trim();
const REQUIRE_KEYWORD = (process.env.REQUIRE_KEYWORD || "").trim().toLowerCase();

// Counts
const PLAYER_COUNT_MAX = Number(process.env.PLAYER_COUNT_MAX || 100); // hard cap (2..100)
const MIN_PLAYERS = 2;

// Video upload (Supabase Storage)
const VIDEO_BUCKET = (process.env.VIDEO_BUCKET || "zorbi-video").trim();
const VIDEO_BUCKET_PUBLIC = String(process.env.VIDEO_BUCKET_PUBLIC || "").trim().toLowerCase() === "true";
const VIDEO_UPLOAD_TOKEN = (process.env.VIDEO_UPLOAD_TOKEN || "").trim();
const VIDEO_SIGNED_URL_TTL_SEC = Number(process.env.VIDEO_SIGNED_URL_TTL_SEC || 60 * 60 * 24); // 24h

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
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-admin-key");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

// ---------------- HELPERS ----------------
function todayIdUTC() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
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
  if (!ADMIN_KEY) return true; // allow if unset
  return req.headers["x-admin-key"] === ADMIN_KEY;
}

function safeStr(s, maxLen = 80) {
  return (s ?? "").toString().slice(0, maxLen);
}

function hasValidVideoToken(token) {
  if (!VIDEO_UPLOAD_TOKEN) return true; // allow if unset
  return token === VIDEO_UPLOAD_TOKEN;
}

function randId(len = 8) {
  return crypto.randomBytes(Math.ceil(len / 2)).toString("hex").slice(0, len);
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
    `https://graph.facebook.com/v24.0/me/media` +
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
      handle: username,
      source: "comment",
      comment_id: c.id || null,
      comment_text: c.text || "",
      comment_ts: c.timestamp || null,
    });
  }

  const picked = shuffle(uniq).slice(0, cap);
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
  const { error } = await supabase.from("rounds").upsert(row, { onConflict: "round_date" });
  if (error) throw new Error(`Supabase upsert failed: ${error.message}`);
}

async function getRoundByDate(round_date) {
  const { data, error } = await supabase.from("rounds").select("*").eq("round_date", round_date).single();
  if (error) return null;
  return data;
}

async function getTodayRound() {
  return getRoundByDate(todayIdUTC());
}

// ---------------- ROUND GENERATION ----------------
async function generateRound({ requestedMaxPlayers } = {}) {
  const round_date = todayIdUTC();
  const seed = randSeed();

  let mode = "training";
  let post = null;
  let players = [];
  let claimed_total = 0;

  const cap = clampInt(requestedMaxPlayers ?? PLAYER_COUNT_MAX, MIN_PLAYERS, PLAYER_COUNT_MAX);

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

    // video fields
    upload_token: VIDEO_UPLOAD_TOKEN || null,
    video_url: null,
    video_storage_path: null,
    video_uploaded_at: null,
    error_message: null,
  };

  await upsertRound(row);
  return row;
}

// ---------------- ROUTES ----------------
app.get("/", (req, res) => {
  res.json({ ok: true, service: "zorbi-backend" });
});

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

    // video
    hasVideoBucket: !!VIDEO_BUCKET,
    videoBucket: VIDEO_BUCKET || null,
    videoBucketPublic: VIDEO_BUCKET_PUBLIC,
    uploadTokenEnabled: !!VIDEO_UPLOAD_TOKEN,
    signedUrlTtlSec: VIDEO_SIGNED_URL_TTL_SEC,
  });
});

app.get("/admin", (req, res) => {
  res.send(`
    <h2>Zorbi Admin</h2>
    <p>Generate todays round (live if possible, else training).</p>
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
    console.error(e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get("/top50.json", async (req, res) => {
  try {
    let round = await getTodayRound();
    if (!round) round = await generateRound();
    res.json(round);
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post("/round/today/winner", async (req, res) => {
  try {
    const round_date = todayIdUTC();
    const winner = safeStr(req.body?.winner, 64);
    const winnerSlotRaw = req.body?.winnerSlot;

    const winner_slot = Number.isFinite(Number(winnerSlotRaw)) ? Number(winnerSlotRaw) : null;

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
    console.error(e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// Leaderboard JSON
app.get("/leaderboard.json", async (req, res) => {
  const { data, error } = await supabase.from("rounds").select("winner").not("winner", "is", null);
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

// IG bio helper (5 lines, yesterday winner)
app.get("/bio.txt", async (req, res) => {
  try {
    const y = yesterdayIdUTC();
    const yd = await getRoundByDate(y);
    const yWinner = yd?.winner ? `@${yd.winner}` : "TBD";

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.send(
      `ð«§ Only 1 bubble survives.\n` +
        `ð¤ Arcade elimination arena\n` +
        `â¡ New round daily\n` +
        `ð Yesterday: ${yWinner}\n` +
        `ð Follow + comment âINâ to enter`
    );
  } catch (e) {
    res.status(500).send("Error");
  }
});

// ---------------- VIDEO UPLOAD ----------------
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, os.tmpdir()),
    filename: (_req, file, cb) => {
      const ext = (file.originalname || "video.webm").split(".").pop() || "webm";
      cb(null, `zorbi_tmp_${Date.now()}_${randId(6)}.${ext}`);
    },
  }),
  limits: { fileSize: 200 * 1024 * 1024 }, // 200MB
});

async function buildVideoUrl(storagePath) {
  if (VIDEO_BUCKET_PUBLIC) {
    const { data } = supabase.storage.from(VIDEO_BUCKET).getPublicUrl(storagePath);
    return data?.publicUrl || null;
  }
  const { data, error } = await supabase.storage.from(VIDEO_BUCKET).createSignedUrl(storagePath, VIDEO_SIGNED_URL_TTL_SEC);
  if (error) throw new Error(error.message);
  return data?.signedUrl || null;
}

app.post("/api/round/today/video", upload.single("video"), async (req, res) => {
  try {
    const token = safeStr(req.body?.token, 200);
    if (!hasValidVideoToken(token)) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    const round_date = safeStr(req.body?.round_date, 12) || todayIdUTC();

    if (!req.file?.path) return res.status(400).json({ ok: false, error: "Missing video file" });

    const mime = req.file.mimetype || "video/webm";
    const ext = (req.file.originalname || "video.webm").split(".").pop() || (mime.includes("mp4") ? "mp4" : "webm");

    // UNIQUE path so you never collide with an existing same-day video
    const storagePath = `${round_date}/zorbi_${round_date.replaceAll("-", "")}_${Date.now()}_${randId(6)}.${ext}`;

    const buf = fs.readFileSync(req.file.path);

    const { error: upErr } = await supabase.storage.from(VIDEO_BUCKET).upload(storagePath, buf, {
      contentType: mime,
      upsert: true,
      cacheControl: "3600",
    });

    // cleanup tmp
    try { fs.unlinkSync(req.file.path); } catch (_) {}

    if (upErr) throw new Error(upErr.message);

    const video_url = await buildVideoUrl(storagePath);

    const { error: dbErr } = await supabase
      .from("rounds")
      .update({
        video_url: video_url || null,
        video_storage_path: storagePath,
        video_uploaded_at: new Date().toISOString(),
      })
      .eq("round_date", round_date);

    if (dbErr) throw new Error(dbErr.message);

    res.json({ ok: true, video_url, video_storage_path: storagePath, public: VIDEO_BUCKET_PUBLIC });
  } catch (e) {
    console.error("video upload error:", e);
    console.error(e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// Fetch a fresh URL for today's (or a specific date's) video
app.get("/api/round/today/video", async (req, res) => {
  try {
    const round_date = safeStr(req.query?.date, 12) || todayIdUTC();
    const r = await getRoundByDate(round_date);
    if (!r?.video_storage_path) {
      return res.status(404).json({ ok: false, error: "No video yet" });
    }

    const freshUrl = await buildVideoUrl(r.video_storage_path);

    // keep DB's video_url updated so your index can show a link
    await supabase
      .from("rounds")
      .update({ video_url: freshUrl || r.video_url || null })
      .eq("round_date", round_date);

    res.json({ ok: true, round_date, video_url: freshUrl, video_storage_path: r.video_storage_path, public: VIDEO_BUCKET_PUBLIC });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.listen(PORT, () => console.log("Listening on", PORT));
