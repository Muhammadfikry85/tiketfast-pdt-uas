const express = require("express");
const Redis = require("ioredis");
const { Pool } = require("pg");
const { v4: uuidv4 } = require("uuid");

const NODE_ID = process.env.NODE_ID || "app";
const REDIS_HOST = process.env.REDIS_HOST || "redis";
const LOCK_TTL_SECONDS = parseInt(process.env.LOCK_TTL_SECONDS || "600", 10);
const QUEUE_THRESHOLD = parseInt(process.env.QUEUE_THRESHOLD || "50000", 10);

const redis = new Redis({ host: REDIS_HOST, port: 6379 });

const pgMaster = new Pool({
  host: process.env.PG_MASTER_HOST || "postgres-master",
  user: "tiketfast",
  password: "tiketfast_pass",
  database: "tiketfast",
  port: 5432,
});

const pgReplica = new Pool({
  host: process.env.PG_REPLICA_HOST || "postgres-replica",
  user: "tiketfast",
  password: "tiketfast_pass",
  database: "tiketfast",
  port: 5432,
});

const app = express();
app.use(express.json());

let requestCounter = 0;
setInterval(() => {
  requestCounter = 0;
}, 1000);
app.use((req, res, next) => {
  requestCounter++;
  next();
});

const seatTable = (category) => {
  const map = {
    festival: "seats_festival",
    vip: "seats_vip",
    tribune: "seats_tribune",
  };
  return map[category.toLowerCase()];
};

app.get("/health", (req, res) => {
  res.json({ status: "ok", node: NODE_ID });
});

app.post("/queue/join", async (req, res) => {
  const token = uuidv4();
  const now = Date.now();
  const overThreshold = requestCounter > QUEUE_THRESHOLD;

  await redis.zadd("vwr:queue", now, token);
  await redis.set(`vwr:token:${token}`, "waiting", "EX", 3600);

  const position = await redis.zrank("vwr:queue", token);

  res.json({
    token,
    node: NODE_ID,
    position: position + 1,
    overThreshold,
    message: overThreshold
      ? "Trafik tinggi terdeteksi, Anda dimasukkan ke antrean virtual."
      : "Anda dapat langsung melanjutkan ke pemilihan kursi.",
  });
});

app.get("/queue/status/:token", async (req, res) => {
  const { token } = req.params;
  const state = await redis.get(`vwr:token:${token}`);
  if (!state) return res.status(404).json({ error: "Token tidak ditemukan atau kedaluwarsa" });

  const rank = await redis.zrank("vwr:queue", token);
  res.json({ token, state, position: rank === null ? null : rank + 1, node: NODE_ID });
});

app.post("/queue/admit", async (req, res) => {
  const batchSize = parseInt(req.body?.batchSize || "100", 10);
  const tokens = await redis.zrange("vwr:queue", 0, batchSize - 1);

  for (const t of tokens) {
    await redis.set(`vwr:token:${t}`, "admitted", "EX", 3600);
    await redis.zrem("vwr:queue", t);
  }
  res.json({ admitted: tokens.length, node: NODE_ID });
});

app.post("/seats/:seatId/lock", async (req, res) => {
  const { seatId } = req.params;
  const { userId, category } = req.body;

  if (!userId || !category) {
    return res.status(400).json({ error: "userId dan category wajib diisi" });
  }

  const lockKey = `seat:lock:${seatId}`;
  const acquired = await redis.set(lockKey, userId, "NX", "EX", LOCK_TTL_SECONDS);

  if (!acquired) {
    return res.status(409).json({
      seatId,
      status: "locked_by_other",
      message: "Kursi sedang dipesan orang lain",
      node: NODE_ID,
    });
  }

  const table = seatTable(category);
  if (table) {
    try {
      await pgMaster.query(
        `UPDATE ${table} SET status = 'locked', locked_by = $1, locked_at = now() WHERE seat_id = $2`,
        [userId, seatId]
      );
    } catch (e) {
      await redis.del(lockKey);
      return res.status(500).json({ error: "Gagal update database", detail: e.message });
    }
  }

  res.json({ seatId, status: "locked", ttlSeconds: LOCK_TTL_SECONDS, node: NODE_ID });
});

app.post("/seats/:seatId/release", async (req, res) => {
  const { seatId } = req.params;
  const { category } = req.body;
  await redis.del(`seat:lock:${seatId}`);

  const table = seatTable(category || "");
  if (table) {
    await pgMaster.query(
      `UPDATE ${table} SET status = 'available', locked_by = NULL, locked_at = NULL WHERE seat_id = $1`,
      [seatId]
    );
  }
  res.json({ seatId, status: "released", node: NODE_ID });
});

app.get("/seats/:category", async (req, res) => {
  const table = seatTable(req.params.category);
  if (!table) return res.status(400).json({ error: "Kategori tidak valid" });

  try {
    const { rows } = await pgReplica.query(
      `SELECT seat_id, status FROM ${table} ORDER BY seat_id`
    );
    res.json({ category: req.params.category, seats: rows, servedBy: "replica", node: NODE_ID });
  } catch (e) {
    const { rows } = await pgMaster.query(
      `SELECT seat_id, status FROM ${table} ORDER BY seat_id`
    );
    res.json({ category: req.params.category, seats: rows, servedBy: "master-fallback", node: NODE_ID });
  }
});

app.post("/checkout", async (req, res) => {
  const { seatId, category, userId } = req.body;
  const lockKey = `seat:lock:${seatId}`;
  const owner = await redis.get(lockKey);

  if (owner !== userId) {
    return res.status(403).json({ error: "Anda tidak memegang kunci kursi ini atau sudah kedaluwarsa" });
  }

  const table = seatTable(category);
  const client = await pgMaster.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE ${table} SET status = 'sold' WHERE seat_id = $1`,
      [seatId]
    );
    await client.query(
      `INSERT INTO bookings (seat_id, category, user_id, node_id) VALUES ($1, $2, $3, $4)`,
      [seatId, category, userId, NODE_ID]
    );
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    return res.status(500).json({ error: "Checkout gagal", detail: e.message });
  } finally {
    client.release();
  }

  await redis.del(lockKey);
  res.json({ seatId, status: "sold", userId, node: NODE_ID });
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`[${NODE_ID}] TiketFast berjalan di port ${PORT}`);
});
