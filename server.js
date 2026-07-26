
// server.js
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(cors());
app.use(express.json());

// Инициализация базы данных
const db = new sqlite3.Database('./logs.db');

// Создание таблиц
db.serialize(() => {
    // Основная таблица логов
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

    // Индексы для быстрого поиска
    db.run(`CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON logs(timestamp)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_logs_type ON logs(type)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_logs_player ON logs(player)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_logs_level ON logs(level)`);

    // Таблица для хранения активных сессий
    db.run(`
        CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            server_id TEXT,
            start_time INTEGER,
            end_time INTEGER,
            log_count INTEGER DEFAULT 0
        )
    `);
});

// Middleware для логирования запросов
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
    next();
});

// Эндпоинт для получения логов
app.post('/api/logs', async (req, res) => {
    try {
        const { logs, server_id = 'unknown', game_id = 'unknown' } = req.body;

        if (!logs || !Array.isArray(logs) || logs.length === 0) {
            return res.status(400).json({ error: 'Invalid logs data' });
        }

        const stmt = db.prepare(`
            INSERT INTO logs (id, timestamp, message, type, level, player, server_id, game_id, place_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const insertPromises = logs.map(log => {
            return new Promise((resolve, reject) => {
                const id = uuidv4();
                stmt.run(
                    id,
                    log.timestamp || Date.now(),
                    log.message || '',
                    log.type || 'Info',
                    log.level || 'info',
                    log.player || 'Server',
                    server_id,
                    game_id,
                    log.place_id || ''
                ), (err) => {
                    if (err) reject(err);
                    else resolve();
                };
            });
        });

        await Promise.all(insertPromises);
        stmt.finalize();

        // Обновление статистики сессии
        db.run(`
            INSERT INTO sessions (id, server_id, start_time, log_count)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET 
                log_count = log_count + ?,
                end_time = ?
        `, [server_id, server_id, Date.now(), logs.length, logs.length, Date.now()]);

        res.status(200).json({ 
            success: true, 
            count: logs.length,
            message: 'Logs saved successfully'
        });

    } catch (error) {
        console.error('Error saving logs:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Эндпоинт для получения логов с фильтрацией
app.get('/api/logs', (req, res) => {
    try {
        const { 
            limit = 100, 
            offset = 0, 
            type, 
            level, 
            player, 
            from, 
            to,
            search 
        } = req.query;

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

        if (from) {
            query += ' AND timestamp >= ?';
            params.push(parseInt(from));
        }

        if (to) {
            query += ' AND timestamp <= ?';
            params.push(parseInt(to));
        }

        query += ' ORDER BY timestamp DESC LIMIT ? OFFSET ?';
        params.push(parseInt(limit), parseInt(offset));

        db.all(query, params, (err, rows) => {
            if (err) {
                console.error('Error fetching logs:', err);
                return res.status(500).json({ error: 'Database error' });
            }

            // Получение общего количества
            let countQuery = 'SELECT COUNT(*) as total FROM logs WHERE 1=1';
            const countParams = [];

            if (type) {
                countQuery += ' AND type = ?';
                countParams.push(type);
            }
            // ... аналогичные условия

            db.get(countQuery, countParams, (err, countResult) => {
                if (err) {
                    console.error('Error counting logs:', err);
                    return res.status(500).json({ error: 'Database error' });
                }

                res.json({
                    logs: rows,
                    total: countResult.total,
                    limit: parseInt(limit),
                    offset: parseInt(offset)
                });
            });
        });

    } catch (error) {
        console.error('Error fetching logs:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Эндпоинт для статистики
app.get('/api/stats', (req, res) => {
    db.get(`
        SELECT 
            COUNT(*) as total_logs,
            COUNT(DISTINCT server_id) as total_servers,
            SUM(CASE WHEN level = 'error' THEN 1 ELSE 0 END) as error_count,
            SUM(CASE WHEN level = 'warning' THEN 1 ELSE 0 END) as warning_count,
            SUM(CASE WHEN level = 'info' THEN 1 ELSE 0 END) as info_count,
            MAX(timestamp) as last_log
        FROM logs
    `, (err, stats) => {
        if (err) {
            console.error('Error getting stats:', err);
            return res.status(500).json({ error: 'Database error' });
        }

        // Статистика по типам
        db.all(`
            SELECT type, COUNT(*) as count 
            FROM logs 
            GROUP BY type 
            ORDER BY count DESC
        `, (err, types) => {
            if (err) {
                console.error('Error getting type stats:', err);
                return res.status(500).json({ error: 'Database error' });
            }

            // Статистика по игрокам
            db.all(`
                SELECT player, COUNT(*) as count 
                FROM logs 
                WHERE player != 'Server'
                GROUP BY player 
                ORDER BY count DESC 
                LIMIT 10
            `, (err, players) => {
                if (err) {
                    console.error('Error getting player stats:', err);
                    return res.status(500).json({ error: 'Database error' });
                }

                res.json({
                    ...stats,
                    by_type: types,
                    top_players: players
                });
            });
        });
    });
});

// Эндпоинт для удаления старых логов
app.delete('/api/logs/cleanup', (req, res) => {
    const { days = 30 } = req.query;
    const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);

    db.run('DELETE FROM logs WHERE timestamp < ?', [cutoff], function(err) {
        if (err) {
            console.error('Error cleaning up logs:', err);
            return res.status(500).json({ error: 'Database error' });
        }

        res.json({ 
            success: true, 
            deleted: this.changes,
            message: `Deleted ${this.changes} logs older than ${days} days`
        });
    });
});

// Health check
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        timestamp: Date.now(),
        uptime: process.uptime()
    });
});

// Статическая файловая доска для веб-интерфейса
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Log server running on port ${PORT}`);
    console.log(`📊 Dashboard: http://localhost:${PORT}`);
});

// Graceful shutdown
process.on('SIGINT', () => {
    db.close(() => {
        console.log('Database closed');
        process.exit(0);
    });
});
