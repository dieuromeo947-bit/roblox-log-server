const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// Используем /data для постоянного хранения на Railway
const dbPath = process.env.DATABASE_PATH || './logs.db';
const db = new sqlite3.Database(dbPath);

// Создание таблиц
db.serialize(() => {
    db.run(`
        CREATE TABLE IF NOT EXISTS logs (
            id TEXT PRIMARY KEY,
            timestamp INTEGER,
            message TEXT,
            type TEXT,
            level TEXT,
            player TEXT,
            server_id TEXT,
            game_id TEXT,
            place_id TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    db.run(`CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON logs(timestamp)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_logs_type ON logs(type)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_logs_player ON logs(player)`);
});

// Эндпоинты
app.post('/api/logs', (req, res) => {
    try {
        const { logs, server_id = 'unknown', game_id = 'unknown' } = req.body;

        if (!logs || !Array.isArray(logs) || logs.length === 0) {
            return res.status(400).json({ error: 'Invalid logs data' });
        }

        const stmt = db.prepare(`
            INSERT INTO logs (id, timestamp, message, type, level, player, server_id, game_id, place_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        logs.forEach(log => {
            stmt.run(
                uuidv4(),
                log.timestamp || Date.now(),
                log.message || '',
                log.type || 'Info',
                log.level || 'info',
                log.player || 'Server',
                server_id,
                game_id,
                log.place_id || ''
            );
        });

        stmt.finalize();
        res.json({ success: true, count: logs.length });

    } catch (error) {
        console.error('Error saving logs:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/api/logs', (req, res) => {
    try {
        const { limit = 100, offset = 0, type, level, player, search } = req.query;

        let query = 'SELECT * FROM logs WHERE 1=1';
        const params = [];

        if (type) {
            query += ' AND type = ?';
            params.push(type);
        }
        if (level) {
            query += ' AND level = ?';
            params.push(level);
        }
        if (player) {
            query += ' AND player LIKE ?';
            params.push(`%${player}%`);
        }
        if (search) {
            query += ' AND message LIKE ?';
            params.push(`%${search}%`);
        }

        query += ' ORDER BY timestamp DESC LIMIT ? OFFSET ?';
        params.push(parseInt(limit), parseInt(offset));

        db.all(query, params, (err, rows) => {
            if (err) {
                return res.status(500).json({ error: 'Database error' });
            }

            db.get('SELECT COUNT(*) as total FROM logs', (err, count) => {
                res.json({
                    logs: rows,
                    total: count.total,
                    limit: parseInt(limit),
                    offset: parseInt(offset)
                });
            });
        });

    } catch (error) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/api/stats', (req, res) => {
    db.get(`
        SELECT 
            COUNT(*) as total_logs,
            SUM(CASE WHEN level = 'error' THEN 1 ELSE 0 END) as error_count,
            SUM(CASE WHEN level = 'warning' THEN 1 ELSE 0 END) as warning_count,
            SUM(CASE WHEN level = 'info' THEN 1 ELSE 0 END) as info_count
        FROM logs
    `, (err, stats) => {
        if (err) {
            return res.status(500).json({ error: 'Database error' });
        }
        res.json(stats);
    });
});

app.use(express.static('public'));

app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: Date.now() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
