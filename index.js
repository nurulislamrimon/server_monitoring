import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

dotenv.config();
const app = express();
app.use(express.json());

const port = process.env.PORT || 5000;

// 🔹 Cloudflare Config
const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";
const ZONE_ID = process.env.CF_ZONE_ID;
const CF_TOKEN = process.env.CF_API_TOKEN;
const headers = {
  Authorization: `Bearer ${CF_TOKEN}`,
  "Content-Type": "application/json",
};

const dbPath = path.resolve("./data/sqlite/ssl_records.db");

// Ensure directory exists
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

// Now safely create database
const db = new Database(dbPath);

// Create table if not exists
db.prepare(
  `
  CREATE TABLE IF NOT EXISTS ssl_records (
    id TEXT PRIMARY KEY,
    hostname TEXT UNIQUE,
    status TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  )
`
).run();

// 🧠 Middleware: tenant detection
app.use((req, res, next) => {
  const host = req.headers.host;
  req.tenant = host;
  next();
});

// 🟢 CREATE new custom hostname + SSL
// 🟢 CREATE new custom hostname + SSL (with background processing)
app.post("/ssl", async (req, res) => {
  try {
    const { hostname } = req.body;
    if (!hostname)
      return res
        .status(400)
        .json({ success: false, message: "hostname required" });

    // Step 1: Add hostname to Cloudflare
    const createRes = await axios.post(
      `${CLOUDFLARE_API}/zones/${ZONE_ID}/custom_hostnames`,
      {
        hostname,
        ssl: { method: "http", type: "dv", settings: { http2: "on" } },
      },
      { headers }
    );

    const ssl = createRes.data.result;

    // Step 2: Save immediately in DB with "pending" status
    db.prepare(
      `INSERT OR REPLACE INTO ssl_records (id, hostname, status, updated_at) 
       VALUES (?, ?, ?, CURRENT_TIMESTAMP)`
    ).run(ssl.id, ssl.hostname, "pending");

    // Step 3: Respond immediately to client
    res.json({ success: true, data: { ...ssl, status: "pending" } });

    // Step 4: Background process to fetch real status
    (async () => {
      try {
        const updated = await fetchCloudflareStatus(ssl.id, 3);

        db.prepare(
          `UPDATE ssl_records 
           SET status = ?, updated_at = CURRENT_TIMESTAMP 
           WHERE id = ?`
        ).run(updated.status, ssl.id);

        console.log(`SSL status updated for ${hostname}: ${updated.status}`);
      } catch (err) {
        console.error(`Background fetch failed for ${hostname}:`, err.message);
      }
    })();
  } catch (err) {
    res
      .status(500)
      .json({ success: false, error: err.response?.data || err.message });
  }
});

// 🔵 READ SSL by hostname
app.get("/ssl/:hostname", async (req, res) => {
  try {
    const { hostname } = req.params;

    // Check local DB first
    const local = db
      .prepare("SELECT * FROM ssl_records WHERE hostname = ?")
      .get(hostname);
    if (local) return res.json({ success: true, data: local });

    // If not found locally, check Cloudflare
    const response = await axios.get(
      `${CLOUDFLARE_API}/zones/${ZONE_ID}/custom_hostnames?hostname=${hostname}`,
      { headers }
    );

    const result = response.data.result?.[0];
    if (!result)
      return res.status(404).json({ success: false, message: "Not found" });

    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.response?.data || error.message,
    });
  }
});

// Recheck the domain status
app.get("/ssl/:hostname/recheck", async (req, res) => {
  try {
    const { hostname } = req.params;

    const record = db
      .prepare("SELECT * FROM ssl_records WHERE hostname = ?")
      .get(hostname);
    if (!record)
      return res
        .status(404)
        .json({ success: false, message: "Not found in DB" });

    const updated = await fetchCloudflareStatus(record.id, 3);

    db.prepare(
      `
      UPDATE ssl_records 
      SET status = ?, updated_at = CURRENT_TIMESTAMP 
      WHERE id = ?
    `
    ).run(updated.status, record.id);

    res.json({ success: true, data: updated });
  } catch (err) {
    res
      .status(500)
      .json({ success: false, error: err.response?.data || err.message });
  }
});

// 🟣 UPDATE SSL settings
app.put("/ssl/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { sslSettings } = req.body; // Example: { http2: "off" }

    const response = await axios.patch(
      `${CLOUDFLARE_API}/zones/${ZONE_ID}/custom_hostnames/${id}`,
      { ssl: { settings: sslSettings } },
      { headers }
    );

    const updated = response.data.result;

    // Update DB
    db.prepare("UPDATE ssl_records SET status = ? WHERE id = ?").run(
      updated.status,
      id
    );

    res.json({ success: true, data: updated });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.response?.data || error.message,
    });
  }
});

// 🔴 DELETE SSL
app.delete("/ssl/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const response = await axios.delete(
      `${CLOUDFLARE_API}/zones/${ZONE_ID}/custom_hostnames/${id}`,
      { headers }
    );

    // Remove from DB
    db.prepare("DELETE FROM ssl_records WHERE id = ?").run(id);

    res.json({ success: true, data: response.data.result });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.response?.data || error.message,
    });
  }
});

// 🟡 LIST all SSL records (local cache)
app.get("/ssl", (req, res) => {
  try {
    const rows = db
      .prepare("SELECT * FROM ssl_records ORDER BY created_at DESC")
      .all();
    res.json({ success: true, data: rows });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 🏠 Default route
app.get("/", (req, res) => {
  res.send({
    success: true,
    message: `Hello World! From ${process.env.APP_NAME}`,
    tenant: req.tenant,
  });
});

// 🚀 Start Server
app.listen(port, () => {
  console.log(`${process.env.APP_NAME} running on port ${port}`);
});

// helpers ===================
async function fetchCloudflareStatus(hostnameOrId, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await axios.get(
        `${CLOUDFLARE_API}/zones/${ZONE_ID}/custom_hostnames/${hostnameOrId}`,
        { headers }
      );
      return response.data.result;
    } catch (err) {
      console.warn(
        `Attempt ${i + 1} failed for ${hostnameOrId}:`,
        err.response?.data || err.message
      );
      if (i === retries - 1) throw err;
      await new Promise((r) => setTimeout(r, 60 * 1000));
    }
  }
}
