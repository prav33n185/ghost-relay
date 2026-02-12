const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const bodyParser = require('body-parser');

const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));

// =============================================
// DATABASE SETUP (SINGLE, CORRECT SCHEMA)
// =============================================
const db = new sqlite3.Database('./relay.db', (err) => {
    if (err) console.error(err.message);
    else console.log('Connected to Relay DB.');
});

db.serialize(() => {
    // Messages table (Store-and-Forward)
    db.run(`CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        to_peer TEXT NOT NULL,
        data TEXT NOT NULL,
        timestamp INTEGER NOT NULL
    )`);

    // Index for fast inbox lookup
    db.run(`CREATE INDEX IF NOT EXISTS idx_messages_to_peer ON messages(to_peer)`);

    // Identities table — SINGLE DEFINITION with peer_id column
    db.run(`CREATE TABLE IF NOT EXISTS identities (
        username TEXT PRIMARY KEY,
        encrypted_blob TEXT,
        peer_id TEXT,
        timestamp INTEGER
    )`);

    // Migration: Add peer_id column if table was created by old schema
    db.run("ALTER TABLE identities ADD COLUMN peer_id TEXT", (err) => {
        // Ignore "duplicate column" error — means it already exists
        if (err && !err.message.includes('duplicate column')) {
            console.error("Migration error:", err.message);
        }
    });
});

// =============================================
// CRON: Cleanup old messages (>24h)
// =============================================
setInterval(() => {
    const cutoff = Date.now() - (24 * 60 * 60 * 1000);
    db.run(`DELETE FROM messages WHERE timestamp < ?`, [cutoff], function (err) {
        if (err) console.error("Cleanup Error:", err);
        else if (this.changes > 0) console.log(`Cleaned up ${this.changes} old messages`);
    });
}, 60 * 60 * 1000);

// =============================================
// SOCKET.IO: Signaling & Presence
// =============================================
const onlinePeers = new Map(); // peerId -> socketId

io.on('connection', (socket) => {
    console.log('Socket connected:', socket.id);

    // Register User
    socket.on('join', (peerId) => {
        if (!peerId) return;
        onlinePeers.set(peerId, socket.id);
        socket.peerId = peerId;
        console.log(`Registered peer: ${peerId.substring(0, 12)}...`);

        // INSTANT DELIVERY: Check if there are queued messages for this user
        db.all("SELECT * FROM messages WHERE to_peer = ?", [peerId], (err, rows) => {
            if (err || !rows || rows.length === 0) return;
            console.log(`Delivering ${rows.length} queued messages to ${peerId.substring(0, 12)}...`);
            for (const item of rows) {
                socket.emit('relay-message', { id: item.id, data: item.data });
            }
        });
    });

    // Signaling (Forward WebRTC Call Data)
    socket.on('signal', ({ to, data }) => {
        const targetSocketId = onlinePeers.get(to);
        if (targetSocketId) {
            io.to(targetSocketId).emit('signal', { from: socket.peerId, data });
        } else {
            console.log(`Signal target offline: ${to.substring(0, 12)}...`);
        }
    });

    // Typing Indicator
    socket.on('typing', ({ to, isTyping }) => {
        const targetSocketId = onlinePeers.get(to);
        if (targetSocketId) {
            io.to(targetSocketId).emit('typing', { from: socket.peerId, isTyping });
        }
    });

    // Check Online Status
    socket.on('check-status', (targetPeerId, callback) => {
        const isOnline = onlinePeers.has(targetPeerId);
        if (typeof callback === 'function') callback({ isOnline });
    });

    socket.on('disconnect', () => {
        if (socket.peerId) {
            onlinePeers.delete(socket.peerId);
            console.log(`Peer disconnected: ${socket.peerId.substring(0, 12)}...`);
        }
    });
});

// =============================================
// API: Health Check
// =============================================
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        uptime: process.uptime(),
        onlinePeers: onlinePeers.size,
        timestamp: Date.now()
    });
});

// =============================================
// API: Store-and-Forward Messaging
// =============================================

// SEND: Store message + attempt live delivery
app.post('/send', (req, res) => {
    const { to, data, id } = req.body;
    if (!to || !data || !id) return res.status(400).json({ error: "Missing fields: to, data, id required" });

    // 1. Always store (reliable delivery guarantee)
    const stmt = db.prepare("INSERT OR IGNORE INTO messages (id, to_peer, data, timestamp) VALUES (?, ?, ?, ?)");
    stmt.run(id, to, data, Date.now(), function (err) {
        if (err) return res.status(500).json({ error: "Storage failed" });

        // 2. Attempt LIVE delivery via Socket.io (instant push)
        const targetSocketId = onlinePeers.get(to);
        if (targetSocketId) {
            io.to(targetSocketId).emit('relay-message', { id, data });
            console.log(`Live-delivered message to ${to.substring(0, 12)}...`);
        }

        res.json({ success: true, liveDelivered: !!targetSocketId });
    });
    stmt.finalize();
});

// INBOX: Get queued messages
app.get('/inbox/:peerId', (req, res) => {
    const peerId = req.params.peerId;
    if (!peerId) return res.status(400).json({ error: "peerId required" });

    db.all("SELECT * FROM messages WHERE to_peer = ? ORDER BY timestamp ASC", [peerId], (err, rows) => {
        if (err) return res.status(500).json({ error: "DB Error" });
        res.json(rows || []);
    });
});

// DELETE: Confirm receipt (remove from queue)
app.delete('/inbox/:id', (req, res) => {
    const id = req.params.id;
    db.run("DELETE FROM messages WHERE id = ?", [id], function (err) {
        if (err) return res.status(500).json({ error: "DB Error" });
        res.json({ success: true, deleted: this.changes > 0 });
    });
});

// =============================================
// API: Identity & Directory
// =============================================

// Register/Update Identity + Directory Entry
app.post('/identity', (req, res) => {
    const { username, blob, peerId } = req.body;
    if (!username || !blob) return res.status(400).json({ error: "Missing fields: username, blob required" });

    const stmt = db.prepare("INSERT OR REPLACE INTO identities (username, encrypted_blob, peer_id, timestamp) VALUES (?, ?, ?, ?)");
    stmt.run(username, blob, peerId || null, Date.now(), function (err) {
        if (err) return res.status(500).json({ error: "Storage failed: " + err.message });
        console.log(`Identity registered: hash=${username.substring(0, 10)}... peerId=${(peerId || 'none').substring(0, 12)}...`);
        res.json({ success: true });
    });
    stmt.finalize();
});

// Recover Identity (get encrypted blob by hash)
app.post('/identity/recover', (req, res) => {
    const { hashKey } = req.body;
    if (!hashKey) return res.status(400).json({ error: "Missing hashKey" });

    db.get("SELECT encrypted_blob, peer_id FROM identities WHERE username = ?", [hashKey], (err, row) => {
        if (err) return res.status(500).json({ error: "DB Error" });
        if (row) {
            res.json({ found: true, blob: row.encrypted_blob, peerId: row.peer_id });
        } else {
            res.json({ found: false });
        }
    });
});

// Directory Lookup: Get PeerId from hash
app.get('/directory/:hashKey', (req, res) => {
    const hashKey = req.params.hashKey;
    db.get("SELECT peer_id FROM identities WHERE username = ?", [hashKey], (err, row) => {
        if (err) return res.status(500).json({ error: "DB Error" });
        if (row && row.peer_id) {
            res.json({ found: true, peerId: row.peer_id });
        } else {
            res.json({ found: false });
        }
    });
});

// Legacy: Get blob by username
app.get('/identity/:username', (req, res) => {
    const username = req.params.username;
    db.get("SELECT encrypted_blob, peer_id FROM identities WHERE username = ?", [username], (err, row) => {
        if (err) return res.status(500).json({ error: "DB Error" });
        if (row) {
            res.json({ blob: row.encrypted_blob, peerId: row.peer_id });
        } else {
            res.status(404).json({ error: "Not Found" });
        }
    });
});

// =============================================
// DEBUG ENDPOINTS
// =============================================

// List all identities (for manual verification)
app.get('/debug/identities', (req, res) => {
    db.all("SELECT username, peer_id, timestamp FROM identities", [], (err, rows) => {
        if (err) return res.status(500).json({ error: "DB Error" });
        res.json({
            count: rows.length,
            users: rows.map(r => ({
                mobileHash: r.username,
                peerId: r.peer_id,
                registeredAt: r.timestamp ? new Date(r.timestamp).toISOString() : null
            }))
        });
    });
});

// List online peers
app.get('/debug/online', (req, res) => {
    const peers = [];
    onlinePeers.forEach((socketId, peerId) => {
        peers.push({ peerId: peerId.substring(0, 20) + '...', socketId });
    });
    res.json({ count: peers.length, peers });
});

// List queued messages
app.get('/debug/messages', (req, res) => {
    db.all("SELECT id, to_peer, timestamp FROM messages ORDER BY timestamp DESC LIMIT 50", [], (err, rows) => {
        if (err) return res.status(500).json({ error: "DB Error" });
        res.json({
            count: rows.length,
            messages: rows.map(r => ({
                id: r.id,
                to: r.to_peer.substring(0, 20) + '...',
                age: Math.round((Date.now() - r.timestamp) / 1000) + 's ago'
            }))
        });
    });
});

// Flush all identities (reset)
app.get('/debug/flush', (req, res) => {
    db.run("DELETE FROM identities", [], (err) => {
        if (err) return res.status(500).json({ error: "Flush Failed" });
        db.run("DELETE FROM messages", [], (err2) => {
            res.json({ success: true, message: "Database flushed. All users and messages removed." });
        });
    });
});

// =============================================
// START SERVER
// =============================================
server.listen(PORT, () => {
    console.log(`Ghost Relay running on port ${PORT}`);
    console.log(`Health: http://localhost:${PORT}/health`);
    console.log(`Debug:  http://localhost:${PORT}/debug/identities`);
});
