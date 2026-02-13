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
// DATABASE SETUP
// =============================================
const db = new sqlite3.Database('./relay.db', (err) => {
    if (err) console.error(err.message);
    else console.log('Connected to Relay DB.');
});

db.serialize(() => {
    // Messages table — DUAL KEYED: by hash (primary) AND legacy peerId
    db.run(`CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        to_hash TEXT,
        to_peer TEXT,
        data TEXT NOT NULL,
        timestamp INTEGER NOT NULL
    )`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_messages_to_hash ON messages(to_hash)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_messages_to_peer ON messages(to_peer)`);

    // Add to_hash column to existing messages table (migration)
    db.run("ALTER TABLE messages ADD COLUMN to_hash TEXT", (err) => {
        if (err && !err.message.includes('duplicate column')) {
            console.error("Migration error:", err.message);
        }
    });

    // Identities table
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

    // PeerID change history — tracks every PeerId mutation for debugging
    db.run(`CREATE TABLE IF NOT EXISTS peerid_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username_hash TEXT NOT NULL,
        display_name TEXT,
        old_peer_id TEXT,
        new_peer_id TEXT,
        source TEXT,
        timestamp INTEGER NOT NULL
    )`);
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
// DUAL MAP: Both peerId and hash map to the same socket
const onlinePeers = new Map();  // peerId -> socketId
const onlineHashes = new Map(); // mobileHash -> socketId

io.on('connection', (socket) => {
    console.log('Socket connected:', socket.id);

    // NEW: Join accepts { peerId, mobileHash } object OR legacy string
    socket.on('join', (payload) => {
        let peerId, mobileHash;

        if (typeof payload === 'string') {
            // Legacy: just peerId string
            peerId = payload;
        } else if (payload && typeof payload === 'object') {
            peerId = payload.peerId;
            mobileHash = payload.mobileHash;
        }

        if (peerId) {
            onlinePeers.set(peerId, socket.id);
            socket.peerId = peerId;
            console.log(`Registered peerId: ${peerId.substring(0, 16)}...`);
        }

        if (mobileHash) {
            onlineHashes.set(mobileHash, socket.id);
            socket.mobileHash = mobileHash;
            console.log(`Registered hash: ${mobileHash.substring(0, 10)}...`);

            // INSTANT DELIVERY: Push any queued messages for this HASH
            db.all("SELECT * FROM messages WHERE to_hash = ?", [mobileHash], (err, rows) => {
                if (err || !rows || rows.length === 0) return;
                console.log(`Delivering ${rows.length} queued msgs to hash ${mobileHash.substring(0, 10)}...`);
                for (const item of rows) {
                    socket.emit('relay-message', { id: item.id, data: item.data });
                }
            });
        }

        // Also deliver legacy peerId-addressed messages
        if (peerId) {
            db.all("SELECT * FROM messages WHERE to_peer = ? AND to_hash IS NULL", [peerId], (err, rows) => {
                if (err || !rows || rows.length === 0) return;
                console.log(`Delivering ${rows.length} legacy msgs to peerId...`);
                for (const item of rows) {
                    socket.emit('relay-message', { id: item.id, data: item.data });
                }
            });
        }
    });

    socket.on('signal', ({ to, data }) => {
        const targetSocketId = onlinePeers.get(to) || onlineHashes.get(to);
        if (targetSocketId) {
            io.to(targetSocketId).emit('signal', { from: socket.peerId || socket.mobileHash, data });
        }
    });

    socket.on('typing', ({ to, isTyping }) => {
        const targetSocketId = onlinePeers.get(to) || onlineHashes.get(to);
        if (targetSocketId) {
            io.to(targetSocketId).emit('typing', { from: socket.peerId || socket.mobileHash, isTyping });
        }
    });

    socket.on('check-status', (target, callback) => {
        const isOnline = onlinePeers.has(target) || onlineHashes.has(target);
        if (typeof callback === 'function') callback({ isOnline });
    });

    socket.on('disconnect', () => {
        if (socket.peerId) onlinePeers.delete(socket.peerId);
        if (socket.mobileHash) onlineHashes.delete(socket.mobileHash);
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
        onlineHashes: onlineHashes.size,
        timestamp: Date.now()
    });
});

// =============================================
// API: Store-and-Forward Messaging
// =============================================

// NEW: Send by HASH (primary) — also accepts legacy peerId via 'to'
app.post('/send', (req, res) => {
    const { toHash, to, data, id } = req.body;
    if (!data || !id) return res.status(400).json({ error: "Missing data or id" });
    if (!toHash && !to) return res.status(400).json({ error: "Missing toHash or to" });

    const targetHash = toHash || null;
    const targetPeer = to || null;

    const stmt = db.prepare("INSERT OR IGNORE INTO messages (id, to_hash, to_peer, data, timestamp) VALUES (?, ?, ?, ?, ?)");
    stmt.run(id, targetHash, targetPeer, data, Date.now(), function (err) {
        if (err) return res.status(500).json({ error: "Storage failed" });

        // Attempt LIVE delivery via Socket
        let delivered = false;

        // Try hash-based delivery first (preferred)
        if (targetHash) {
            const socketId = onlineHashes.get(targetHash);
            if (socketId) {
                io.to(socketId).emit('relay-message', { id, data });
                delivered = true;
            }
        }

        // Fallback: try peerId-based delivery
        if (!delivered && targetPeer) {
            const socketId = onlinePeers.get(targetPeer);
            if (socketId) {
                io.to(socketId).emit('relay-message', { id, data });
                delivered = true;
            }
        }

        console.log(`Message ${id.substring(0, 8)}... -> hash=${(targetHash || 'none').substring(0, 10)} peer=${(targetPeer || 'none').substring(0, 16)} live=${delivered}`);
        res.json({ success: true, liveDelivered: delivered });
    });
    stmt.finalize();
});

// NEW: Inbox by HASH (primary endpoint)
app.get('/inbox/hash/:hash', (req, res) => {
    const hash = req.params.hash;
    db.all("SELECT * FROM messages WHERE to_hash = ? ORDER BY timestamp ASC", [hash], (err, rows) => {
        if (err) return res.status(500).json({ error: "DB Error" });
        res.json(rows || []);
    });
});

// Legacy: Inbox by peerId
app.get('/inbox/:peerId', (req, res) => {
    const peerId = req.params.peerId;
    db.all("SELECT * FROM messages WHERE to_peer = ? ORDER BY timestamp ASC", [peerId], (err, rows) => {
        if (err) return res.status(500).json({ error: "DB Error" });
        res.json(rows || []);
    });
});

// Delete message by ID (works for both hash and peerId addressed messages)
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

// Register/Update Identity + Directory Entry (with PeerID change logging)
app.post('/identity', (req, res) => {
    const { username, blob, peerId, displayName } = req.body;
    if (!username || !blob) return res.status(400).json({ error: "Missing fields" });

    // Check existing entry for PeerId change logging
    db.get("SELECT peer_id, display_name FROM identities WHERE username = ?", [username], (err, existing) => {
        if (err) return res.status(500).json({ error: "DB Error" });

        const oldPeerId = existing ? existing.peer_id : null;
        const newPeerId = peerId || null;

        // LOG PeerID change
        if (oldPeerId && newPeerId && oldPeerId !== newPeerId) {
            console.warn(`⚠️ PEERID CHANGED for ${(displayName || username.substring(0, 10))}! Old=${oldPeerId.substring(0, 16)}... New=${newPeerId.substring(0, 16)}...`);
            db.run(
                "INSERT INTO peerid_history (username_hash, display_name, old_peer_id, new_peer_id, source, timestamp) VALUES (?, ?, ?, ?, ?, ?)",
                [username, displayName || null, oldPeerId, newPeerId, 'POST /identity', Date.now()]
            );
        } else if (!oldPeerId && newPeerId) {
            console.log(`✅ First registration: ${(displayName || username.substring(0, 10))} -> ${newPeerId.substring(0, 16)}...`);
            db.run(
                "INSERT INTO peerid_history (username_hash, display_name, old_peer_id, new_peer_id, source, timestamp) VALUES (?, ?, ?, ?, ?, ?)",
                [username, displayName || null, null, newPeerId, 'FIRST_REGISTRATION', Date.now()]
            );
        }

        // Save identity
        const stmt = db.prepare("INSERT OR REPLACE INTO identities (username, encrypted_blob, peer_id, display_name, timestamp) VALUES (?, ?, ?, ?, ?)");
        stmt.run(username, blob, newPeerId, displayName || (existing ? existing.display_name : null), Date.now(), function (err2) {
            if (err2) return res.status(500).json({ error: "Storage failed: " + err2.message });
            console.log(`Identity saved: hash=${username.substring(0, 10)}... peer=${(newPeerId || 'none').substring(0, 16)}... name=${displayName || 'none'}`);
            res.json({ success: true, peerIdChanged: !!(oldPeerId && newPeerId && oldPeerId !== newPeerId) });
        });
        stmt.finalize();
    });
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
        if (row) {
            // Return found=true even if peer_id is null — user IS registered
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
        peers.push({ type: 'peerId', key: peerId.substring(0, 20) + '...', socketId });
    });
    onlineHashes.forEach((socketId, hash) => {
        peers.push({ type: 'hash', key: hash.substring(0, 16) + '...', socketId });
    });
    res.json({ count: peers.length, peers });
});

app.get('/debug/messages', (req, res) => {
    db.all("SELECT id, to_hash, to_peer, timestamp FROM messages ORDER BY timestamp DESC LIMIT 50", [], (err, rows) => {
        if (err) return res.status(500).json({ error: "DB Error" });
        res.json({
            count: rows.length,
            messages: rows.map(r => ({
                id: r.id,
                toHash: r.to_hash ? r.to_hash.substring(0, 16) + '...' : null,
                toPeer: r.to_peer ? r.to_peer.substring(0, 20) + '...' : null,
                age: Math.round((Date.now() - r.timestamp) / 1000) + 's ago'
            }))
        });
    });
});

app.get('/debug/history', (req, res) => {
    db.all("SELECT * FROM peerid_history ORDER BY timestamp DESC LIMIT 100", [], (err, rows) => {
        if (err) return res.status(500).json({ error: "DB Error" });
        res.json({
            count: rows.length,
            changes: rows.map(r => ({
                user: r.display_name || r.username_hash.substring(0, 10) + '...',
                oldPeerId: r.old_peer_id ? r.old_peer_id.substring(0, 20) + '...' : null,
                newPeerId: r.new_peer_id ? r.new_peer_id.substring(0, 20) + '...' : null,
                source: r.source,
                when: new Date(r.timestamp).toISOString()
            }))
        });
    });
});

app.get('/debug/flush', (req, res) => {
    db.run("DELETE FROM identities", [], (err) => {
        if (err) return res.status(500).json({ error: "Flush Failed" });
        db.run("DELETE FROM messages", [], () => {
            db.run("DELETE FROM peerid_history", [], () => {
                res.json({ success: true, message: "Database flushed (identities, messages, history)." });
            });
        });
    });
});

// =============================================
// START SERVER
// =============================================
server.listen(PORT, () => {
    console.log(`Ghost Relay running on port ${PORT}`);
});
