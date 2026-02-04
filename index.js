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

server.listen(PORT, () => { // LISTEN ON SERVER (not app)
    console.log(`Ghost Relay + Signaling running on port ${PORT}`);
});
