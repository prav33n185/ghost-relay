const express = require('express');
const { Pool } = require('pg');
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
// DATABASE SETUP — PostgreSQL (Supabase)
// =============================================
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }  // Required for Supabase/Render managed PG
});

// Auto-create tables on startup
async function initDB() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS messages (
                id TEXT PRIMARY KEY,
                to_hash TEXT,
                to_peer TEXT,
                data TEXT NOT NULL,
                timestamp BIGINT NOT NULL
            )
        `);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_messages_to_hash ON messages(to_hash)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_messages_to_peer ON messages(to_peer)`);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS identities (
                username TEXT PRIMARY KEY,
                encrypted_blob TEXT,
                peer_id TEXT,
                display_name TEXT,
                timestamp BIGINT
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS peerid_history (
                id SERIAL PRIMARY KEY,
                username_hash TEXT NOT NULL,
                display_name TEXT,
                old_peer_id TEXT,
                new_peer_id TEXT,
                source TEXT,
                timestamp BIGINT NOT NULL
            )
        `);

        console.log('✅ PostgreSQL tables initialized');
    } catch (err) {
        console.error('❌ DB Init Error:', err.message);
        process.exit(1);
    }
}

// Cleanup old messages (>24h)
setInterval(async () => {
    try {
        const cutoff = Date.now() - (24 * 60 * 60 * 1000);
        const result = await pool.query('DELETE FROM messages WHERE timestamp < $1', [cutoff]);
        if (result.rowCount > 0) console.log(`Cleaned up ${result.rowCount} old messages`);
    } catch (err) {
        console.error("Cleanup Error:", err.message);
    }
}, 60 * 60 * 1000);

// =============================================
// SOCKET.IO: Signaling & Presence
// =============================================
const onlinePeers = new Map();
const onlineHashes = new Map();

io.on('connection', (socket) => {
    console.log('Socket connected:', socket.id);

    socket.on('join', async (payload) => {
        let peerId, mobileHash;

        if (typeof payload === 'string') {
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

            // INSTANT DELIVERY: Push queued messages for this HASH
            try {
                const { rows } = await pool.query(
                    'SELECT * FROM messages WHERE to_hash = $1', [mobileHash]
                );
                if (rows.length > 0) {
                    console.log(`Delivering ${rows.length} queued msgs to hash ${mobileHash.substring(0, 10)}...`);
                    for (const item of rows) {
                        socket.emit('relay-message', { id: item.id, data: item.data });
                    }
                }
            } catch (err) {
                console.error("Queue delivery error:", err.message);
            }
        }

        // Also deliver legacy peerId-addressed messages
        if (peerId) {
            try {
                const { rows } = await pool.query(
                    'SELECT * FROM messages WHERE to_peer = $1 AND to_hash IS NULL', [peerId]
                );
                if (rows.length > 0) {
                    console.log(`Delivering ${rows.length} legacy msgs to peerId...`);
                    for (const item of rows) {
                        socket.emit('relay-message', { id: item.id, data: item.data });
                    }
                }
            } catch (err) {
                console.error("Legacy delivery error:", err.message);
            }
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
app.get('/health', async (req, res) => {
    try {
        // Quick DB health check
        await pool.query('SELECT 1');
        res.json({
            status: 'ok',
            db: 'postgresql',
            uptime: process.uptime(),
            onlinePeers: onlinePeers.size,
            onlineHashes: onlineHashes.size,
            timestamp: Date.now()
        });
    } catch (err) {
        res.json({
            status: 'degraded',
            db: 'postgresql-error',
            error: err.message,
            uptime: process.uptime(),
            timestamp: Date.now()
        });
    }
});

// =============================================
// API: Store-and-Forward Messaging
// =============================================

app.post('/send', async (req, res) => {
    const { toHash, to, data, id } = req.body;
    if (!data || !id) return res.status(400).json({ error: "Missing data or id" });
    if (!toHash && !to) return res.status(400).json({ error: "Missing toHash or to" });

    const targetHash = toHash || null;
    const targetPeer = to || null;

    try {
        await pool.query(
            'INSERT INTO messages (id, to_hash, to_peer, data, timestamp) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING',
            [id, targetHash, targetPeer, data, Date.now()]
        );

        // Attempt LIVE delivery via Socket
        let delivered = false;

        if (targetHash) {
            const socketId = onlineHashes.get(targetHash);
            if (socketId) {
                io.to(socketId).emit('relay-message', { id, data });
                delivered = true;
            }
        }

        if (!delivered && targetPeer) {
            const socketId = onlinePeers.get(targetPeer);
            if (socketId) {
                io.to(socketId).emit('relay-message', { id, data });
                delivered = true;
            }
        }

        console.log(`Message ${id.substring(0, 8)}... -> hash=${(targetHash || 'none').substring(0, 10)} peer=${(targetPeer || 'none').substring(0, 16)} live=${delivered}`);
        res.json({ success: true, liveDelivered: delivered });
    } catch (err) {
        console.error("Send Error:", err.message);
        res.status(500).json({ error: "Storage failed" });
    }
});

// Inbox by HASH (primary)
app.get('/inbox/hash/:hash', async (req, res) => {
    try {
        const { rows } = await pool.query(
            'SELECT * FROM messages WHERE to_hash = $1 ORDER BY timestamp ASC', [req.params.hash]
        );
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: "DB Error" });
    }
});

// Legacy: Inbox by peerId
app.get('/inbox/:peerId', async (req, res) => {
    try {
        const { rows } = await pool.query(
            'SELECT * FROM messages WHERE to_peer = $1 ORDER BY timestamp ASC', [req.params.peerId]
        );
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: "DB Error" });
    }
});

// Delete message by ID
app.delete('/inbox/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM messages WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: "DB Error" });
    }
});

// =============================================
// API: Identity & Directory
// =============================================

app.post('/identity', async (req, res) => {
    const { username, blob, peerId, displayName } = req.body;
    if (!username || !blob) return res.status(400).json({ error: "Missing fields" });

    try {
        // Check existing entry
        const { rows } = await pool.query(
            'SELECT peer_id, display_name FROM identities WHERE username = $1', [username]
        );
        const existing = rows[0] || null;

        const oldPeerId = existing ? existing.peer_id : null;
        const newPeerId = peerId || null;

        // Log PeerId changes
        if (newPeerId) {
            if (oldPeerId && oldPeerId !== newPeerId) {
                console.warn(`⚠️ PEERID CHANGED for ${(displayName || username.substring(0, 10))}! Old=${oldPeerId.substring(0, 16)}... New=${newPeerId.substring(0, 16)}...`);
                await pool.query(
                    'INSERT INTO peerid_history (username_hash, display_name, old_peer_id, new_peer_id, source, timestamp) VALUES ($1, $2, $3, $4, $5, $6)',
                    [username, displayName || null, oldPeerId, newPeerId, 'PEERID_CHANGE', Date.now()]
                );
            } else if (!oldPeerId) {
                console.log(`✅ First registration: ${(displayName || username.substring(0, 10))} -> Hash: ${username.substring(0, 10)}...`);
                await pool.query(
                    'INSERT INTO peerid_history (username_hash, display_name, old_peer_id, new_peer_id, source, timestamp) VALUES ($1, $2, $3, $4, $5, $6)',
                    [username, displayName || null, null, newPeerId, 'FIRST_REGISTRATION', Date.now()]
                );
            }
        }

        // Save identity — keep existing peerId if none sent
        const finalPeerId = newPeerId || oldPeerId || null;
        const finalDisplayName = displayName || (existing ? existing.display_name : null);

        await pool.query(
            `INSERT INTO identities (username, encrypted_blob, peer_id, display_name, timestamp) 
             VALUES ($1, $2, $3, $4, $5) 
             ON CONFLICT (username) DO UPDATE SET 
                encrypted_blob = EXCLUDED.encrypted_blob,
                peer_id = EXCLUDED.peer_id,
                display_name = EXCLUDED.display_name,
                timestamp = EXCLUDED.timestamp`,
            [username, blob, finalPeerId, finalDisplayName, Date.now()]
        );

        console.log(`Identity saved: hash=${username.substring(0, 10)}... name=${displayName || 'none'}`);
        res.json({ success: true });
    } catch (err) {
        console.error("Identity Save Error:", err.message);
        res.status(500).json({ error: "Storage failed: " + err.message });
    }
});

// Recover Identity by hash
app.post('/identity/recover', async (req, res) => {
    const { hashKey } = req.body;
    if (!hashKey) return res.status(400).json({ error: "Missing hashKey" });

    try {
        const { rows } = await pool.query(
            'SELECT encrypted_blob, peer_id, display_name FROM identities WHERE username = $1', [hashKey]
        );
        if (rows[0]) {
            res.json({ found: true, blob: rows[0].encrypted_blob, peerId: rows[0].peer_id, displayName: rows[0].display_name });
        } else {
            res.json({ found: false });
        }
    } catch (err) {
        res.status(500).json({ error: "DB Error" });
    }
});

// Directory Lookup
app.get('/directory/:hashKey', async (req, res) => {
    try {
        const { rows } = await pool.query(
            'SELECT peer_id, display_name FROM identities WHERE username = $1', [req.params.hashKey]
        );
        if (rows[0]) {
            res.json({ found: true, peerId: rows[0].peer_id, displayName: rows[0].display_name });
        } else {
            res.json({ found: false });
        }
    } catch (err) {
        res.status(500).json({ error: "DB Error" });
    }
});

// Legacy endpoint
app.get('/identity/:username', async (req, res) => {
    try {
        const { rows } = await pool.query(
            'SELECT encrypted_blob, peer_id, display_name FROM identities WHERE username = $1', [req.params.username]
        );
        if (rows[0]) {
            res.json({ blob: rows[0].encrypted_blob, peerId: rows[0].peer_id, displayName: rows[0].display_name });
        } else {
            res.status(404).json({ error: "Not Found" });
        }
    } catch (err) {
        res.status(500).json({ error: "DB Error" });
    }
});

// =============================================
// DEBUG ENDPOINTS
// =============================================

app.get('/debug/identities', async (req, res) => {
    try {
        const { rows } = await pool.query(
            'SELECT username, peer_id, display_name, timestamp FROM identities'
        );
        res.json({
            count: rows.length,
            users: rows.map(r => ({
                mobileHash: r.username,
                peerId: r.peer_id,
                displayName: r.display_name,
                registeredAt: r.timestamp ? new Date(Number(r.timestamp)).toISOString() : null
            }))
        });
    } catch (err) {
        res.status(500).json({ error: "DB Error" });
    }
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

app.get('/debug/messages', async (req, res) => {
    try {
        const { rows } = await pool.query(
            'SELECT id, to_hash, to_peer, timestamp FROM messages ORDER BY timestamp DESC LIMIT 50'
        );
        res.json({
            count: rows.length,
            messages: rows.map(r => ({
                id: r.id,
                toHash: r.to_hash ? r.to_hash.substring(0, 16) + '...' : null,
                toPeer: r.to_peer ? r.to_peer.substring(0, 20) + '...' : null,
                age: Math.round((Date.now() - Number(r.timestamp)) / 1000) + 's ago'
            }))
        });
    } catch (err) {
        res.status(500).json({ error: "DB Error" });
    }
});

app.get('/debug/history', async (req, res) => {
    try {
        const { rows } = await pool.query(
            'SELECT * FROM peerid_history ORDER BY timestamp DESC LIMIT 100'
        );
        res.json({
            count: rows.length,
            changes: rows.map(r => ({
                user: r.display_name || r.username_hash.substring(0, 10) + '...',
                oldPeerId: r.old_peer_id ? r.old_peer_id.substring(0, 20) + '...' : null,
                newPeerId: r.new_peer_id ? r.new_peer_id.substring(0, 20) + '...' : null,
                source: r.source,
                when: new Date(Number(r.timestamp)).toISOString()
            }))
        });
    } catch (err) {
        res.status(500).json({ error: "DB Error" });
    }
});

app.get('/debug/flush', async (req, res) => {
    try {
        await pool.query('DELETE FROM identities');
        await pool.query('DELETE FROM messages');
        await pool.query('DELETE FROM peerid_history');
        res.json({ success: true, message: "Database flushed (identities, messages, history)." });
    } catch (err) {
        res.status(500).json({ error: "Flush Failed" });
    }
});

// =============================================
// START SERVER
// =============================================
initDB().then(() => {
    server.listen(PORT, () => {
        console.log(`Ghost Relay running on port ${PORT} (PostgreSQL)`);
    });
}).catch(err => {
    console.error("Failed to initialize database:", err);
    process.exit(1);
});
