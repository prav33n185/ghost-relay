const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const bodyParser = require('body-parser');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json({ limit: '10mb' })); // Support large encrypted blobs

// 1. Database Setup (Memory or File)
const db = new sqlite3.Database('./relay.db', (err) => {
    if (err) console.error(err.message);
    else console.log('Connected to Relay DB.');
});

db.serialize(() => {
    // Table: Messages (Blind Store)
    // id: UUID
    // to_peer: Target Peer ID
    // data: Encrypted Blob (Base64)
    // timestamp: Created At
    db.run(`CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        to_peer TEXT,
        data TEXT,
        timestamp INTEGER
    )`);
});

// 2. Cron Job: Cleanup Old Messages (> 24h)
setInterval(() => {
    const cutoff = Date.now() - (24 * 60 * 60 * 1000);
    db.run(`DELETE FROM messages WHERE timestamp < ?`, [cutoff], (err) => {
        if (err) console.error("Cleanup Error:", err);
        else console.log("Cleaned up old messages.");
    });
}, 60 * 60 * 1000); // Every hour

// 3. API Endpoints

// SEND: Store Encrypted Message
// Body: { to: "peerId", data: "encrypted_string", id: "uuid" }
app.post('/send', (req, res) => {
    const { to, data, id } = req.body;
    if (!to || !data || !id) return res.status(400).send("Missing fields");

    const stmt = db.prepare("INSERT INTO messages (id, to_peer, data, timestamp) VALUES (?, ?, ?, ?)");
    stmt.run(id, to, data, Date.now(), function (err) {
        if (err) {
            console.error("Insert Error:", err);
            return res.status(500).send("Storage Fail");
        }
        res.json({ success: true });
    });
    stmt.finalize();
});

// INBOX: Get Messages for Peer
app.get('/inbox/:peerId', (req, res) => {
    const peerId = req.params.peerId;
    db.all("SELECT * FROM messages WHERE to_peer = ?", [peerId], (err, rows) => {
        if (err) return res.status(500).send("DB Error");
        res.json(rows);
    });
});

// DELETE: Confirm Receipt
app.delete('/inbox/:id', (req, res) => {
    const id = req.params.id;
    db.run("DELETE FROM messages WHERE id = ?", [id], (err) => {
        if (err) return res.status(500).send("DB Error");
        res.json({ success: true });
    });
});

app.listen(PORT, () => {
    console.log(`Ghost Relay Server running on port ${PORT}`);
});
