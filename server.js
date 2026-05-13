const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

// 1. Настройка порта для Render
const PORT = process.env.PORT || 8080;

// 2. Создание HTTP-сервера для раздачи HTML
const server = http.createServer((req, res) => {
    let filePath = './royale.html';
    if (req.url === '/') filePath = './royale.html';

    fs.readFile(filePath, (err, content) => {
        if (err) {
            res.writeHead(500);
            res.end('Error loading royale.html');
        } else {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(content, 'utf-8');
        }
    });
});

// 3. Создание WebSocket сервера
const wss = new WebSocket.Server({ server });

let waitingPlayer = null;
let games = [];

wss.on('connection', (ws) => {
    console.log('Новое подключение');

    ws.on('message', (message) => {
        const data = JSON.parse(message);

        // Логика подбора игроков
        if (data.type === 'join') {
            handleJoin(ws, data);
        }

        // Логика выставления юнитов
        if (data.type === 'place_unit') {
            handleMove(ws, data);
        }

        // Логика эмодзи
        if (data.type === 'emoji') {
            handleEmoji(ws, data);
        }
    });

    ws.on('close', () => {
        if (waitingPlayer && waitingPlayer.ws === ws) {
            waitingPlayer = null;
        }
    });
});

function handleJoin(ws, data) {
    if (!waitingPlayer) {
        waitingPlayer = { ws, name: data.name, trophies: data.trophies };
        console.log(`${data.name} ожидает противника...`);
    } else {
        const p1 = waitingPlayer;
        const p2 = { ws, name: data.name, trophies: data.trophies };
        waitingPlayer = null;

        const gameId = Date.now();
        const newGame = {
            id: gameId,
            p1: p1,
            p2: p2,
            units: [],
            towers: [
                { id: 't1_main', owner: 'p1', x: 0.5, y: 0.9, hp: 2000, maxHp: 2000 },
                { id: 't1_l', owner: 'p1', x: 0.2, y: 0.8, hp: 1200, maxHp: 1200 },
                { id: 't1_r', owner: 'p1', x: 0.8, y: 0.8, hp: 1200, maxHp: 1200 },
                { id: 't2_main', owner: 'p2', x: 0.5, y: 0.1, hp: 2000, maxHp: 2000 },
                { id: 't2_l', owner: 'p2', x: 0.2, y: 0.2, hp: 1200, maxHp: 1200 },
                { id: 't2_r', owner: 'p2', x: 0.8, y: 0.2, hp: 1200, maxHp: 1200 }
            ],
            timer: 120,
            status: 'active'
        };

        games.push(newGame);

        // Уведомляем игроков о начале
        p1.ws.send(JSON.stringify({ type: 'match_start', role: 'p1', oppName: p2.name, oppTrophies: p2.trophies }));
        p2.ws.send(JSON.stringify({ type: 'match_start', role: 'p2', oppName: p1.name, oppTrophies: p1.trophies }));

        startGameLoop(newGame);
    }
}

function handleMove(ws, data) {
    const game = games.find(g => g.p1.ws === ws || g.p2.ws === ws);
    if (!game) return;

    const role = (game.p1.ws === ws) ? 'p1' : 'p2';
    
    // Добавляем юнита в массив игры
    game.units.push({
        unitId: data.unitId,
        owner: role,
        x: data.x,
        y: data.y,
        hp: 100 // Упрощенно
    });
}

function handleEmoji(ws, data) {
    const game = games.find(g => g.p1.ws === ws || g.p2.ws === ws);
    if (!game) return;

    const sender = (game.p1.ws === ws) ? game.p1 : game.p2;
    const receiver = (game.p1.ws === ws) ? game.p2 : game.p1;

    // Отправляем эмодзи обоим (с пометкой кто отправил)
    sender.ws.send(JSON.stringify({ type: 'emoji', emoji: data.emoji, isOpponent: false }));
    receiver.ws.send(JSON.stringify({ type: 'emoji', emoji: data.emoji, isOpponent: true }));
}

function startGameLoop(game) {
    const interval = setInterval(() => {
        if (game.status === 'finished') {
            clearInterval(interval);
            return;
        }

        // Уменьшаем таймер
        game.timer--;
        if (game.timer <= 0) {
            game.status = 'finished';
            // Логика завершения по времени...
        }

        // Простая синхронизация данных
        const payload = JSON.stringify({
            type: 'sync',
            units: game.units,
            towers: game.towers,
            timer: game.timer
        });

        game.p1.ws.send(payload);
        game.p2.ws.send(payload);

    }, 1000);
}

server.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
});
