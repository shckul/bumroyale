const WebSocket = require('ws');
const http = require('http');

const server = http.createServer();
const wss = new WebSocket.Server({ server });

// Константы игры для синхронизации
const TICK_RATE = 20; // 20 обновлений в секунду (каждые 50мс)
const GAME_DURATION = 120; // 2 минуты
const TOWER_MAX_HP = 1000;

let waitingPlayer = null;
let rooms = new Map();

wss.on('connection', (ws) => {
    console.log('Новое подключение');

    ws.on('message', (message) => {
        const data = JSON.parse(message);

        switch (data.type) {
            case 'MATCHMAKING':
                handleMatchmaking(ws, data);
                break;
            case 'SPAWN':
                handleSpawn(ws, data);
                break;
            case 'EMOJI':
                handleEmoji(ws, data);
                break;
        }
    });

    ws.on('close', () => {
        if (waitingPlayer && waitingPlayer.ws === ws) {
            waitingPlayer = null;
        }
        // Логика завершения комнаты при дисконнекте
        rooms.forEach((room, roomId) => {
            if (room.p1.ws === ws || room.p2.ws === ws) {
                const winner = room.p1.ws === ws ? room.p2 : room.p1;
                winner.ws.send(JSON.stringify({ type: 'GAME_END', won: true }));
                rooms.delete(roomId);
            }
        });
    });
});

function handleMatchmaking(ws, data) {
    if (!waitingPlayer) {
        waitingPlayer = { ws, user: data.user, deck: data.deck, trophies: 1000 };
    } else {
        const roomId = `room_${Date.now()}`;
        const room = {
            id: roomId,
            p1: waitingPlayer,
            p2: { ws, user: data.user, deck: data.deck, trophies: 1000 },
            state: {
                timer: GAME_DURATION,
                isOvertime: false,
                units: [],
                towers: {
                    p1: [TOWER_MAX_HP, TOWER_MAX_HP, TOWER_MAX_HP],
                    p2: [TOWER_MAX_HP, TOWER_MAX_HP, TOWER_MAX_HP]
                }
            }
        };

        rooms.set(roomId, room);
        ws.roomId = roomId;
        room.p1.ws.roomId = roomId;

        // Уведомляем обоих о начале
        const startMsg = (player, opponent) => JSON.stringify({
            type: 'START_BATTLE',
            opponent: { name: opponent.user, trophies: opponent.trophies }
        });

        room.p1.ws.send(startMsg(room.p1, room.p2));
        room.p2.ws.send(startMsg(room.p2, room.p1));

        waitingPlayer = null;
        startGameLoop(roomId);
    }
}

function handleSpawn(ws, data) {
    const room = rooms.get(ws.roomId);
    if (!room) return;

    // Серверная валидация: инвертируем Y для оппонента
    const isP1 = room.p1.ws === ws;
    const unit = {
        id: Date.now(),
        owner: isP1 ? 'p1' : 'p2',
        unitId: data.unitId,
        x: data.x,
        y: isP1 ? data.y : 1 - data.y, // Отражаем поле для врага
        hp: 100 // Взять из конфига юнита
    };
    
    room.state.units.push(unit);
}

function handleEmoji(ws, data) {
    const room = rooms.get(ws.roomId);
    if (!room) return;

    const opponent = room.p1.ws === ws ? room.p2 : room.p1;
    opponent.ws.send(JSON.stringify({ type: 'ENEMY_EMOJI', char: data.char }));
}

/**
 * ГЛАВНЫЙ ИГРОВОЙ ЦИКЛ СЕРВЕРА
 */
function startGameLoop(roomId) {
    const interval = setInterval(() => {
        const room = rooms.get(roomId);
        if (!room) return clearInterval(interval);

        // 1. Обновление позиций юнитов (простейший AI)
        room.state.units.forEach(unit => {
            const direction = unit.owner === 'p1' ? -0.005 : 0.005;
            unit.y += direction; // Юниты просто идут вперед
        });

        // 2. Проверка коллизий и здоровья башен (заглушка логики)
        // Здесь должен быть расчет расстояния до ближайшей башни

        // 3. Рассылка состояния (State Sync)
        const statePayload = JSON.stringify({
            type: 'STATE_UPDATE',
            units: room.state.units,
            towers: room.state.towers,
            timer: room.state.timer
        });

        room.p1.ws.send(statePayload);
        room.p2.ws.send(statePayload);

    }, TICK_RATE);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
});
