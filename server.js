const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Порт от Render или 8080 для локальных тестов
const PORT = process.env.PORT || 8080;

// Раздаем файл royale.html при заходе на сайт
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'royale.html'));
});

let waitingPlayer = null;
let games = [];

// Данные юнитов (копия для расчетов на сервере)
const UNITS_STATS = {
    0: { hp: 500, dmg: 50, speed: 0.005, range: 0.05 }, // Рыцарь
    1: { hp: 200, dmg: 40, speed: 0.007, range: 0.2 },  // Лучник
    2: { hp: 1200, dmg: 80, speed: 0.003, range: 0.04 } // Гигант
};

wss.on('connection', (ws) => {
    console.log('--- Новое подключение ---');

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);

            if (data.type === 'join') {
                handleJoin(ws, data);
            }

            if (data.type === 'place_unit') {
                handlePlaceUnit(ws, data);
            }

            if (data.type === 'emoji') {
                handleEmoji(ws, data);
            }
        } catch (e) {
            console.error("Ошибка обработки сообщения:", e);
        }
    });

    ws.on('close', () => {
        if (waitingPlayer && waitingPlayer.ws === ws) waitingPlayer = null;
        console.log('Клиент отключился');
    });
});

function handleJoin(ws, data) {
    if (!waitingPlayer) {
        waitingPlayer = { ws, name: data.name, trophies: data.trophies };
        console.log(`Игрок ${data.name} в очереди...`);
    } else {
        const p1 = waitingPlayer;
        const p2 = { ws, name: data.name, trophies: data.trophies };
        waitingPlayer = null;

        const game = {
            id: Date.now(),
            players: { p1, p2 },
            units: [],
            towers: [
                { id: 't1_m', owner: 'p1', x: 0.5, y: 0.9, hp: 2000 },
                { id: 't2_m', owner: 'p2', x: 0.5, y: 0.1, hp: 2000 }
            ],
            timer: 120,
            lastTick: Date.now()
        };

        games.push(game);

        // Отправляем старт обоим
        p1.ws.send(JSON.stringify({ type: 'match_start', role: 'p1', oppName: p2.name, oppTrophies: p2.trophies }));
        p2.ws.send(JSON.stringify({ type: 'match_start', role: 'p2', oppName: p1.name, oppTrophies: p1.trophies }));

        console.log(`Матч начался: ${p1.name} vs ${p2.name}`);
        runGameLogic(game);
    }
}

function handlePlaceUnit(ws, data) {
    const game = games.find(g => g.players.p1.ws === ws || g.players.p2.ws === ws);
    if (!game) return;

    const role = (game.players.p1.ws === ws) ? 'p1' : 'p2';
    const stats = UNITS_STATS[data.unitId] || UNITS_STATS[0];

    game.units.push({
        id: Math.random(),
        unitId: data.unitId,
        owner: role,
        x: data.x,
        y: data.y,
        hp: stats.hp,
        target: null
    });
}

function handleEmoji(ws, data) {
    const game = games.find(g => g.players.p1.ws === ws || g.players.p2.ws === ws);
    if (!game) return;
    
    const isP1 = game.players.p1.ws === ws;
    game.players.p1.ws.send(JSON.stringify({ type: 'emoji', emoji: data.emoji, isOpponent: !isP1 }));
    game.players.p2.ws.send(JSON.stringify({ type: 'emoji', emoji: data.emoji, isOpponent: isP1 }));
}

function runGameLogic(game) {
    const loop = setInterval(() => {
        const now = Date.now();
        game.timer -= 1;

        // Логика движения юнитов к башням
        game.units.forEach(u => {
            const enemyTower = game.towers.find(t => t.owner !== u.owner);
            if (enemyTower) {
                const dx = enemyTower.x - u.x;
                const dy = enemyTower.y - u.y;
                const dist = Math.sqrt(dx * dx + dy * dy);
                
                const stats = UNITS_STATS[u.unitId] || UNITS_STATS[0];

                if (dist > stats.range) {
                    u.x += (dx / dist) * stats.speed;
                    u.y += (dy / dist) * stats.speed;
                } else {
                    enemyTower.hp -= stats.dmg / 10; // Урон в секунду
                }
            }
        });

        // Синхронизация
        const state = JSON.stringify({
            type: 'sync',
            units: game.units,
            towers: game.towers,
            timer: game.timer
        });

        if (game.players.p1.ws.readyState === WebSocket.OPEN) game.players.p1.ws.send(state);
        if (game.players.p2.ws.readyState === WebSocket.OPEN) game.players.p2.ws.send(state);

        // Условие завершения
        const deadTower = game.towers.find(t => t.hp <= 0);
        if (game.timer <= 0 || deadTower) {
            clearInterval(loop);
            const winner = deadTower ? (deadTower.owner === 'p1' ? 'p2' : 'p1') : 'draw';
            const endMsg = JSON.stringify({ type: 'game_over', winner });
            game.players.p1.ws.send(endMsg);
            game.players.p2.ws.send(endMsg);
            games = games.filter(g => g.id !== game.id);
        }
    }, 1000);
}

server.listen(PORT, '0.0.0.0', () => {
    console.log(`--- SERVER LIVE ON PORT ${PORT} ---`);
});
