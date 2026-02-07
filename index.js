const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const bodyParser = require('body-parser');

const app = express();
const http = require('http'); // HTTP Server
const server = http.createServer(app); // Wrap Express
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

// ... (DB Helper remains same)
const db = new sqlite3.Database('./relay.db', (err) => {
    if (err) console.error(err.message);
    else console.log('Connected to Relay DB.');
});

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        to_peer TEXT,
        data TEXT,
        timestamp INTEGER
    )`);
});

// ... (Cron cleanup remains same)
setInterval(() => {
    const cutoff = Date.now() - (24 * 60 * 60 * 1000);
    db.run(`DELETE FROM messages WHERE timestamp < ?`, [cutoff], (err) => {
        if (err) console.error("Cleanup Error:", err);
    });
}, 60 * 60 * 1000);

// SIGNALING LOGIC (Socket.io)
const onlinePeers = new Map(); // peerId -> socketId

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // Register User
    socket.on('join', (peerId) => {
        onlinePeers.set(peerId, socket.id);
        socket.peerId = peerId;
        console.log(`Registered ${peerId}`);
    });

    // Signaling (Forward Call Data)
    socket.on('signal', ({ to, data }) => {
        const targetSocketId = onlinePeers.get(to);
        if (targetSocketId) {
            io.to(targetSocketId).emit('signal', { from: socket.peerId, data });
            console.log(`Signaling from ${socket.peerId} to ${to}`);
        } else {
            console.log(`Signal failed: ${to} offline`);
            // Optional: Store missed call notification?
        }
    });

    socket.on('disconnect', () => {
        if (socket.peerId) {
            onlinePeers.delete(socket.peerId);
        }
    });
});

// ... (API Endpoints remain same)
// SEND: Store Encrypted Message
app.post('/send', (req, res) => {
    const { to, data, id } = req.body;
    if (!to || !data || !id) return res.status(400).send("Missing fields");

    // Check if Online (Live Delivery via Socket?) - Optional Optimization
    // For now, simple Store-and-Forward fallthrough is safer for reliability.

    const stmt = db.prepare("INSERT INTO messages (id, to_peer, data, timestamp) VALUES (?, ?, ?, ?)");
    stmt.run(id, to, data, Date.now(), function (err) {
        if (err) return res.status(500).send("Storage Fail");
        res.json({ success: true });
    });
    stmt.finalize();
});

// INBOX: Get Messages
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

// --- CLOUD IDENTITY BACKUP (Encrypted Blob Storage) ---
// Key = Username (Public), Value = AES Encrypted Bundle (Private)

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS identities (
        username TEXT PRIMARY KEY,
        encrypted_blob TEXT,
        timestamp INTEGER
    )`);
});

// --- CLOUD IDENTITY DIRECTORY (Mobile Number Recovery) ---
// Key = SHA256(Mobile)
// Value 1 = Encrypted Bundle (Private Backup)
// Value 2 = Peer ID (Public Directory)

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS identities (
        username TEXT PRIMARY KEY,
        encrypted_blob TEXT,
        peer_id TEXT,  -- ADDED: Public ID for Directory Lookup
        timestamp INTEGER
    )`);
    // Migration for existing tables (won't run if table exists, but that's fine for dev)
    // In production we'd do ALTER TABLE.
    try {
        db.run("ALTER TABLE identities ADD COLUMN peer_id TEXT");
    } catch (e) { }
});

// DIRECTORY LOOKUP: Get Public ID from Hash
app.get('/directory/:hashKey', (req, res) => {
    const hashKey = req.params.hashKey;
    db.get("SELECT peer_id FROM identities WHERE username = ?", [hashKey], (err, row) => {
        if (err) return res.status(500).send("DB Error");
        if (row && row.peer_id) {
            res.json({ found: true, peerId: row.peer_id });
        } else {
            res.json({ found: false });
        }
    });
});

app.post('/identity/recover', (req, res) => {
    const { hashKey } = req.body; // SHA256(Mobile)
    if (!hashKey) return res.status(400).send("Missing hashKey");

    db.get("SELECT encrypted_blob FROM identities WHERE username = ?", [hashKey], (err, row) => {
        if (err) return res.status(500).send("DB Error");
        if (row) {
            res.json({ found: true, blob: row.encrypted_blob });
        } else {
            res.json({ found: false });
        }
    });
});

// Register/Update Identity + Directory Entry
app.post('/identity', (req, res) => {
    const { username, blob, peerId } = req.body; // Added peerId
    if (!username || !blob) return res.status(400).send("Missing fields");

    const stmt = db.prepare("INSERT OR REPLACE INTO identities (username, encrypted_blob, peer_id, timestamp) VALUES (?, ?, ?, ?)");
    stmt.run(username, blob, peerId, Date.now(), function (err) {
        if (err) return res.status(500).send("Storage Fail: " + err.message);
        res.json({ success: true });
    });
    stmt.finalize();
});

app.get('/identity/:username', (req, res) => {
    // Legacy Endpoint support
    const username = req.params.username;
    db.get("SELECT encrypted_blob FROM identities WHERE username = ?", [username], (err, row) => {
        if (err) return res.status(500).send("DB Error");
        if (row) {
            res.json({ blob: row.encrypted_blob });
        } else {
            res.status(404).send("Not Found");
        }
    });
});


server.listen(PORT, () => { // LISTEN ON SERVER (not app)
    console.log(`Ghost Relay + Signaling running on port ${PORT}`);
});
