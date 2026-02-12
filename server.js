import express from "express";
import fetch from "node-fetch";
import { createClient } from "@supabase/supabase-js";

app.get("/api/envcheck", (req, res) => {
  res.json({
    ok: true,
    hasSupabaseUrl: !!process.env.SUPABASE_URL,
    hasServiceRoleKey: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
    serviceRoleKeyStartsWith: (process.env.SUPABASE_SERVICE_ROLE_KEY || "").slice(0, 6),
  });
});

const app = express();
app.use(express.json());

/**
 * =========================
 * ENV / CONFIG
 * =========================
 */
const PORT = process.env.PORT || 10000;

// Admin auth for /admin/generate
const ADMIN_KEY = process.env.ADMIN_KEY || "";

// CORS: allow your game site to POST winner back to backend
// Example: https://yourgame.github.io or https://zorbblez.com
const GAME_ORIGIN = process.env.GAME_ORIGIN || "";

// IG (optional until you start posting)
// Your existing setup uses graph.instagram.com endpoints.
// If you later move to Meta Graph endpoints, we can upgrade this cleanly.
const ACCESS_TOKEN = process.env.IG_ACCESS_TOKEN || "";
const IG_USER_ID = process.env.IG_USER_ID || ""; // currently unused by graph.instagram.com calls below
const REQUIRE_KEYWORD = (process.env.REQUIRE_KEYWORD || "in").toLowerCase();

// Defaults
const DEFAULT_TRAINING_COUNT = Number(process.env.PLAYER_COUNT || 50); // used when <2 entrants
const MAX_FINALISTS = 100;
const MAX_TRAINING = 50;

// Supabase
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  // Fail fast so Render logs show the issue
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars.");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

/**
 * =========================
 * CORS
 * =========================
 */
app.use((req, res, next) => {
  if (GAME_ORIGIN) {
    res.setHeader("Access-Control-Allow-Origin", GAME_ORIGIN);
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-admin-key");
  }
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

/**
 * =========================
 * UTIL
 * =========================
 */
function todayISODate() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Keep it deterministic-ish per request but unique enough
function makeSeedString() {
  // string is easiest for Postgres bigint safety across JS
  return String(Date.now()) + String(Math.floor(Math.random() * 1000)).padStart(3, "0");
}

function qualifies(text = "") {
  if (!REQUIRE_KEYWORD) return true;
  return String(text).toLowerCase().includes(REQUIRE_KEYWORD);
}

/**
 * =========================
 * INSTAGRAM HELPERS (OPTIONAL)
 * =========================
 * NOTE:
 * - These endpoints require you to have at least 1 post before they work.
 * - If you have 0 posts, we fall back to Training Round automatically.
 */
async function igGetLatestMedia() {
  if (!ACCESS_TOKEN) throw new Error("Missing IG_ACCESS_TOKEN");

  const url =
    `https://graph.instagram.com/me/media` +
    `?fields=id,permalink,timestamp,caption` +
    `&limit=10` +
    `&access_token=${ACCESS_TOKEN}`;

  const res = await fetch(url);
  const data = await res.json();

  if (!res.ok || data?.error) {
    const msg = data?.error?.message || JSON.stringify(data);
    throw new Error(`IG media fetch failed: ${msg}`);
  }

  if (!Array.isArray(data.data) || data.data.length === 0) {
    throw new Error("IG media fetch returned no posts.");
  }

  data.data.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  return data.data[0];
}

async function igGetAllComments(mediaId) {
  if (!ACCESS_TOKEN) throw new Error("Missing IG_ACCESS_TOKEN");

  // Basic Display supports:
  // https://graph.instagram.com/{media-id}/comments?fields=id,username,text,timestamp
  let url =
    `https://graph.instagram.com/${mediaId}/comments` +
    `?fields=id,username,text,timestamp` +
    `&limit=50` +
    `&access_token=${ACCESS_TOKEN}`;

  const all = [];

  while (url) {
    const res = await fetch(url);
    const data = await res.json();

    if (!res.ok || data?.error) {
      const msg = data?.error?.message || JSON.stringify(data);
      throw new Error(`IG comments fetch failed: ${msg}`);
    }

    all.push(...(data.data || []));
    url = data.paging?.next || null;
  }

  return all;
}

/**
 * =========================
 * SUPABASE: ROUND GENERATION (Training Mode A)
 * =========================
 */
async function createOrReplaceTodaysRound() {
  const roundDate = todayISODate();
  const seed = makeSeedString();

  // Try to get comments; if IG has no posts, we fall back to training.
  let post = null;
  let uniqueEntrants = []; // { username }
  try {
    post = await igGetLatestMedia();
    const comments = await igGetAllComments(post.id);

    // filter by keyword, de-dupe by username
    const seen = new Set();
    uniqueEntrants = comments
      .filter((c) => qualifies(c.text))
      .filter((c) => {
        const u = (c.username || "").toLowerCase();
        if (!u) return false;
        if (seen.has(u)) return false;
        seen.add(u);
        return true;
      })
      .map((c) => ({ username: c.username }));
  } catch (e) {
    // No posts / token issues / etc -> training round
    post = null;
    uniqueEntrants = [];
  }

  const hasEntrants = uniqueEntrants.length >= 2;

  // Finale count logic:
  const finaleCount = hasEntrants
    ? clamp(uniqueEntrants.length, 2, MAX_FINALISTS)
    : clamp(DEFAULT_TRAINING_COUNT, 2, MAX_TRAINING);

  // "Claimed total" headline:
  // For now, easiest reliable number is:
  // - if entrants exist: total unique entrants found
  // - if training: use finaleCount (until you have followers)
  // When you’re ready, we can swap this to real follower_count.
  const claimedTotal = hasEntrants ? uniqueEntrants.length : finaleCount;

  const mode = hasEntrants ? "entrants" : "training";

  // Upsert round row
  const { data: round, error: roundErr } = await supabase
    .from("rounds")
    .upsert(
      {
        round_date: roundDate,
        mode,
        status: "pending",
        claimed_total: claimedTotal,
        finale_count: finaleCount,
        seed,
        error_message: null,
      },
      { onConflict: "round_date" }
    )
    .select("id, round_date, mode, status, claimed_total, finale_count, seed")
    .single();

  if (roundErr) throw new Error(`Supabase rounds upsert failed: ${roundErr.message}`);

  // Delete existing entrants for today (regen safe)
  const { error: delErr } = await supabase.from("entrants").delete().eq("round_id", round.id);
  if (delErr) throw new Error(`Supabase entrants delete failed: ${delErr.message}`);

  // Insert entrants
  const entrantRows = [];
  if (mode === "entrants") {
    shuffleInPlace(uniqueEntrants);
    const picked = uniqueEntrants.slice(0, finaleCount);

    for (let i = 0; i < picked.length; i++) {
      entrantRows.push({
        round_id: round.id,
        entrant_number: i + 1,
        username: picked[i].username,
        profile_pic_url: null, // add later when we implement pic fetch
        ig_user_id: null,
        source: "comment",
      });
    }
  } else {
    // training = numbered bubbles only
    for (let i = 0; i < finaleCount; i++) {
      entrantRows.push({
        round_id: round.id,
        entrant_number: i + 1,
        username: null,
        profile_pic_url: null,
        ig_user_id: null,
        source: "training",
      });
    }
  }

  const { error: insErr } = await supabase.from("entrants").insert(entrantRows);
  if (insErr) throw new Error(`Supabase entrants insert failed: ${insErr.message}`);

  return {
    round_date: round.round_date,
    mode: round.mode,
    status: round.status,
    claimed_total: round.claimed_total,
    finale_count: round.finale_count,
    seed: round.seed,
    post: post ? { id: post.id, permalink: post.permalink } : null,
  };
}

/**
 * =========================
 * ROUTES
 * =========================
 */

// Root
app.get("/", (req, res) => {
  res.json({ ok: true, service: "zorbblez-backend" });
});

// Health check (Supabase connectivity)
app.get("/api/health", async (req, res) => {
  try {
    const { data, error } = await supabase.from("rounds").select("id").limit(1);
    if (error) throw error;
    res.json({ ok: true, supabase: "connected", roundsRows: data.length });
  } catch (e) {
    res.status(500).json({ ok: false, supabase: "error", error: String(e?.message || e) });
  }
});

// Admin page
app.get("/admin", (req, res) => {
  res.send(`
    <h2>Zorbblez Admin</h2>
    <p>Generate today's round (creates Training Round if <2 eligible entrants).</p>
    <input id="key" placeholder="Admin Key" />
    <button onclick="gen()">Generate Today’s Round</button>
    <pre id="out"></pre>
    <script>
      async function gen(){
        const key=document.getElementById('key').value;
        const res=await fetch('/admin/generate',{method:'POST',headers:{'x-admin-key':key}});
        document.getElementById('out').textContent=JSON.stringify(await res.json(),null,2);
      }
    </script>
  `);
});

// Generate today’s round
app.post("/admin/generate", async (req, res) => {
  if (ADMIN_KEY && req.headers["x-admin-key"] !== ADMIN_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const round = await createOrReplaceTodaysRound();
    res.json({ ok: true, ...round });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/**
 * Game feed (backward compatible name)
 * Your game can fetch /top50.json to get today’s config + entrants
 */
app.get("/top50.json", async (req, res) => {
  try {
    const roundDate = todayISODate();

    const { data: round, error: rErr } = await supabase
      .from("rounds")
      .select("id, round_date, mode, claimed_total, finale_count, seed, winner_entrant_id, status")
      .eq("round_date", roundDate)
      .single();

    if (rErr) {
      // If round doesn't exist yet, return a helpful response
      return res.status(404).json({
        error: "No round for today yet. Use /admin/generate first.",
        round_date: roundDate,
      });
    }

    const { data: entrants, error: eErr } = await supabase
      .from("entrants")
      .select("id, entrant_number, username, profile_pic_url")
      .eq("round_id", round.id)
      .order("entrant_number", { ascending: true });

    if (eErr) throw eErr;

    res.json({
      round_date: round.round_date,
      mode: round.mode,
      status: round.status,
      claimed_total: round.claimed_total,
      finale_count: round.finale_count,
      seed: round.seed,
      entrants,
    });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// Alias (nicer name)
app.get("/round/today.json", (req, res) => {
  // same output as /top50.json
  req.url = "/top50.json";
  app._router.handle(req, res);
});

// Winner reporting (from game)
app.post("/round/today/winner", async (req, res) => {
  try {
    const { winnerSlot } = req.body;

    if (!winnerSlot || typeof winnerSlot !== "number") {
      return res.status(400).json({ error: "winnerSlot (number) required" });
    }

    const roundDate = todayISODate();

    const { data: round, error: rErr } = await supabase
      .from("rounds")
      .select("id, round_date")
      .eq("round_date", roundDate)
      .single();

    if (rErr) throw rErr;

    const { data: winnerEntrant, error: wErr } = await supabase
      .from("entrants")
      .select("id, username, profile_pic_url, entrant_number")
      .eq("round_id", round.id)
      .eq("entrant_number", winnerSlot)
      .single();

    if (wErr) throw wErr;

    // Update round winner
    const { error: uErr } = await supabase
      .from("rounds")
      .update({ winner_entrant_id: winnerEntrant.id, status: "rendered" })
      .eq("id", round.id);

    if (uErr) throw uErr;

    // Insert/Upsert winners history
    const { error: insErr } = await supabase
      .from("winners")
      .upsert(
        {
          round_id: round.id,
          entrant_id: winnerEntrant.id,
          round_date: roundDate,
          username: winnerEntrant.username,
          profile_pic_url: winnerEntrant.profile_pic_url,
        },
        { onConflict: "round_id" }
      );

    if (insErr) throw insErr;

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// Leaderboard JSON
app.get("/leaderboard.json", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("winners")
      .select("username")
      .not("username", "is", null);

    if (error) throw error;

    const counts = {};
    for (const row of data) {
      const u = row.username;
      if (!u) continue;
      counts[u] = (counts[u] || 0) + 1;
    }

    const sorted = Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .map(([handle, wins]) => ({ handle, wins }));

    res.json(sorted);
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// Bio text (top 3)
app.get("/bio.txt", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("winners")
      .select("username")
      .not("username", "is", null);

    if (error) throw error;

    const counts = {};
    for (const row of data) {
      const u = row.username;
      if (!u) continue;
      counts[u] = (counts[u] || 0) + 1;
    }

    const top = Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([h, c]) => `@${h}(${c})`)
      .join(" • ");

    res.type("text/plain").send(`🏆 Top: ${top || "TBD"}`);
  } catch (e) {
    res.status(500).type("text/plain").send("Error generating bio");
  }
});

/**
 * =========================
 * START
 * =========================
 */
app.listen(PORT, () => console.log("Listening on", PORT));
