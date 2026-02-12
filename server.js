import express from "express";
import fetch from "node-fetch";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;

// ENV VARIABLES
const ACCESS_TOKEN = process.env.IG_ACCESS_TOKEN;
const IG_USER_ID = process.env.IG_USER_ID;
const PLAYER_COUNT = Number(process.env.PLAYER_COUNT || 50);
const REQUIRE_KEYWORD = (process.env.REQUIRE_KEYWORD || "in").toLowerCase();
const ADMIN_KEY = process.env.ADMIN_KEY || "";
const GAME_ORIGIN = process.env.GAME_ORIGIN || "";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false }
});

// CORS for game winner reporting
app.use((req, res, next) => {
  if (GAME_ORIGIN) {
    res.setHeader("Access-Control-Allow-Origin", GAME_ORIGIN);
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-admin-key");
  }
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

// Utility
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function todayId() {
  return new Date().toISOString().slice(0, 10);
}

function qualifies(text = "") {
  if (!REQUIRE_KEYWORD) return true;
  return text.toLowerCase().includes(REQUIRE_KEYWORD);
}

// Get latest IG post
async function getLatestMedia() {
  const url = `https://graph.facebook.com/v20.0/${IG_USER_ID}/media?fields=id,permalink,timestamp&limit=5&access_token=${ACCESS_TOKEN}`;
  const res = await fetch(url);
  const data = await res.json();
  return data.data[0];
}

// Get comments
async function getComments(mediaId) {
  let url = `https://graph.facebook.com/v20.0/${mediaId}/comments?fields=username,text&limit=100&access_token=${ACCESS_TOKEN}`;
  let all = [];
  while (url) {
    const res = await fetch(url);
    const data = await res.json();
    all.push(...(data.data || []));
    url = data.paging?.next || null;
  }
  return all;
}

// Generate round
async function generateRound() {
  const post = await getLatestMedia();
  const comments = await getComments(post.id);

  let entrants = comments.filter(c => qualifies(c.text));
  const seen = new Set();
  entrants = entrants.filter(c => {
    const u = c.username.toLowerCase();
    if (seen.has(u)) return false;
    seen.add(u);
    return true;
  });

  shuffle(entrants);
  const picked = entrants.slice(0, PLAYER_COUNT);

  const players = picked.map((c, i) => ({
    slot: i + 1,
    handle: c.username,
    img: null
  }));

  const round = {
    round_id: todayId(),
    media_id: post.id,
    permalink: post.permalink,
    players
  };

  await supabase
    .from("zorbblez_rounds")
    .upsert(round, { onConflict: "round_id" });

  return round;
}

// Root
app.get("/", (req, res) => {
  res.json({ ok: true, service: "zorbblez-backend" });
});

// Admin page
app.get("/admin", (req, res) => {
  res.send(`
    <h2>Zorbblez Admin</h2>
    <input id="key" placeholder="Admin Key"/>
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

// Generate endpoint
app.post("/admin/generate", async (req, res) => {
  if (ADMIN_KEY && req.headers["x-admin-key"] !== ADMIN_KEY)
    return res.status(401).json({ error: "Unauthorized" });

  try {
    const round = await generateRound();
    res.json(round);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Game feed
app.get("/top50.json", async (req, res) => {
  const { data } = await supabase
    .from("zorbblez_rounds")
    .select("*")
    .eq("round_id", todayId())
    .single();

  res.json(data);
});

// Winner reporting
app.post("/round/today/winner", async (req, res) => {
  const { winner, winnerSlot } = req.body;
  await supabase
    .from("zorbblez_rounds")
    .update({
      winner,
      winner_slot: winnerSlot,
      winner_set_at: new Date().toISOString()
    })
    .eq("round_id", todayId());

  res.json({ ok: true });
});

// Leaderboard
app.get("/leaderboard.json", async (req, res) => {
  const { data } = await supabase
    .from("zorbblez_rounds")
    .select("winner")
    .not("winner", "is", null);

  const counts = {};
  data.forEach(r => {
    const w = r.winner;
    counts[w] = (counts[w] || 0) + 1;
  });

  const sorted = Object.entries(counts)
    .sort((a,b)=>b[1]-a[1])
    .map(([handle,wins])=>({handle,wins}));

  res.json(sorted);
});

// Bio output
app.get("/bio.txt", async (req, res) => {
  const { data } = await supabase
    .from("zorbblez_rounds")
    .select("winner")
    .not("winner", "is", null);

  const counts = {};
  data.forEach(r => {
    const w = r.winner;
    counts[w] = (counts[w] || 0) + 1;
  });

  const top = Object.entries(counts)
    .sort((a,b)=>b[1]-a[1])
    .slice(0,3)
    .map(([h,c])=>`@${h}(${c})`)
    .join(" • ");

  res.send(`🏆 Top: ${top || "TBD"}`);
});

app.listen(PORT, () => console.log("Listening on", PORT));
