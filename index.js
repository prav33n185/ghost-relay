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

    db.run(`CREATE INDEX IF NOT EXISTS idx_messages_to_peer ON messages(to_peer)`);

    // Identities table — with peer_id AND display_name
    db.run(`CREATE TABLE IF NOT EXISTS identities (
        username TEXT PRIMARY KEY,
        encrypted_blob TEXT,
        peer_id TEXT,
        display_name TEXT,
        timestamp INTEGER
    )`);

    // Migrations for old schema
    db.run("ALTER TABLE identities ADD COLUMN peer_id TEXT", (err) => {
        if (err && !err.message.includes('duplicate column')) {
            console.error("Migration error:", err.message);
        }
    });
    db.run("ALTER TABLE identities ADD COLUMN display_name TEXT", (err) => {
        if (err && !err.message.includes('duplicate column')) {
            console.error("Migration error:", err.message);
        }
    });
});

// Cleanup old messages (>24h)
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
const onlinePeers = new Map();

io.on('connection', (socket) => {
    console.log('Socket connected:', socket.id);

    socket.on('join', (peerId) => {
        if (!peerId) return;
        onlinePeers.set(peerId, socket.id);
        socket.peerId = peerId;
        console.log(`Registered peer: ${peerId.substring(0, 16)}...`);

        // INSTANT DELIVERY: Push any queued messages
        db.all("SELECT * FROM messages WHERE to_peer = ?", [peerId], (err, rows) => {
            if (err || !rows || rows.length === 0) return;
            console.log(`Delivering ${rows.length} queued messages to ${peerId.substring(0, 16)}...`);
            for (const item of rows) {
                socket.emit('relay-message', { id: item.id, data: item.data });
            }
        });
    });

    socket.on('signal', ({ to, data }) => {
        const targetSocketId = onlinePeers.get(to);
        if (targetSocketId) {
            io.to(targetSocketId).emit('signal', { from: socket.peerId, data });
        }
    });

    socket.on('typing', ({ to, isTyping }) => {
        const targetSocketId = onlinePeers.get(to);
        if (targetSocketId) {
            io.to(targetSocketId).emit('typing', { from: socket.peerId, isTyping });
        }
    });

    socket.on('check-status', (targetPeerId, callback) => {
        const isOnline = onlinePeers.has(targetPeerId);
        if (typeof callback === 'function') callback({ isOnline });
    });

    socket.on('disconnect', () => {
        if (socket.peerId) {
            onlinePeers.delete(socket.peerId);
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

app.post('/send', (req, res) => {
    const { to, data, id } = req.body;
    if (!to || !data || !id) return res.status(400).json({ error: "Missing fields" });

    const stmt = db.prepare("INSERT OR IGNORE INTO messages (id, to_peer, data, timestamp) VALUES (?, ?, ?, ?)");
    stmt.run(id, to, data, Date.now(), function (err) {
        if (err) return res.status(500).json({ error: "Storage failed" });

        // Attempt LIVE delivery via Socket
        const targetSocketId = onlinePeers.get(to);
        if (targetSocketId) {
            io.to(targetSocketId).emit('relay-message', { id, data });
        }

        res.json({ success: true, liveDelivered: !!targetSocketId });
    });
    stmt.finalize();
});

app.get('/inbox/:peerId', (req, res) => {
    const peerId = req.params.peerId;
    db.all("SELECT * FROM messages WHERE to_peer = ? ORDER BY timestamp ASC", [peerId], (err, rows) => {
        if (err) return res.status(500).json({ error: "DB Error" });
        res.json(rows || []);
    });
});

app.delete('/inbox/:id', (req, res) => {
    const id = req.params.id;
    db.run("DELETE FROM messages WHERE id = ?", [id], function (err) {
        if (err) return res.status(500).json({ error: "DB Error" });
        res.json({ success: true });
    });
});

// =============================================
// API: Identity & Directory
// =============================================

// Register/Update Identity + Directory Entry
app.post('/identity', (req, res) => {
    const { username, blob, peerId, displayName } = req.body;
    if (!username || !blob) return res.status(400).json({ error: "Missing fields" });

    const stmt = db.prepare("INSERT OR REPLACE INTO identities (username, encrypted_blob, peer_id, display_name, timestamp) VALUES (?, ?, ?, ?, ?)");
    stmt.run(username, blob, peerId || null, displayName || null, Date.now(), function (err) {
        if (err) return res.status(500).json({ error: "Storage failed: " + err.message });
        console.log(`Identity registered: hash=${username.substring(0, 10)}... peer=${(peerId || 'none').substring(0, 16)}... name=${displayName || 'none'}`);
        res.json({ success: true });
    });
    stmt.finalize();
});

// Recover Identity by hash
app.post('/identity/recover', (req, res) => {
    const { hashKey } = req.body;
    if (!hashKey) return res.status(400).json({ error: "Missing hashKey" });

    db.get("SELECT encrypted_blob, peer_id, display_name FROM identities WHERE username = ?", [hashKey], (err, row) => {
        if (err) return res.status(500).json({ error: "DB Error" });
        if (row) {
            res.json({ found: true, blob: row.encrypted_blob, peerId: row.peer_id, displayName: row.display_name });
        } else {
            res.json({ found: false });
        }
    });
});

// Directory Lookup: Get PeerId + DisplayName from hash
app.get('/directory/:hashKey', (req, res) => {
    const hashKey = req.params.hashKey;
    db.get("SELECT peer_id, display_name FROM identities WHERE username = ?", [hashKey], (err, row) => {
        if (err) return res.status(500).json({ error: "DB Error" });
        if (row && row.peer_id) {
            res.json({ found: true, peerId: row.peer_id, displayName: row.display_name });
        } else {
            res.json({ found: false });
        }
    });
});

// Legacy endpoint
app.get('/identity/:username', (req, res) => {
    const username = req.params.username;
    db.get("SELECT encrypted_blob, peer_id, display_name FROM identities WHERE username = ?", [username], (err, row) => {
        if (err) return res.status(500).json({ error: "DB Error" });
        if (row) {
            res.json({ blob: row.encrypted_blob, peerId: row.peer_id, displayName: row.display_name });
        } else {
            res.status(404).json({ error: "Not Found" });
        }
    });
});

// =============================================
// DEBUG ENDPOINTS
// =============================================

app.get('/debug/identities', (req, res) => {
    db.all("SELECT username, peer_id, display_name, timestamp FROM identities", [], (err, rows) => {
        if (err) return res.status(500).json({ error: "DB Error" });
        res.json({
            count: rows.length,
            users: rows.map(r => ({
                mobileHash: r.username,
                peerId: r.peer_id,
                displayName: r.display_name,
                registeredAt: r.timestamp ? new Date(r.timestamp).toISOString() : null
            }))
        });
    });
});

app.get('/debug/online', (req, res) => {
    const peers = [];
    onlinePeers.forEach((socketId, peerId) => {
        peers.push({ peerId: peerId.substring(0, 20) + '...', socketId });
    });
    res.json({ count: peers.length, peers });
});

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

app.get('/debug/flush', (req, res) => {
    db.run("DELETE FROM identities", [], (err) => {
        if (err) return res.status(500).json({ error: "Flush Failed" });
        db.run("DELETE FROM messages", [], () => {
            res.json({ success: true, message: "Database flushed." });
        });
    });
});

// =============================================
// START SERVER
// =============================================
server.listen(PORT, () => {
    console.log(`Ghost Relay running on port ${PORT}`);
});
