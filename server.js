const express = require('express');
const path = require('path');
const http = require('http');
const { Server } = require('ws');

const app = express();
const PORT = process.env.PORT || 8080;

// 1. Раздача фронтенда
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'royale.html'));
});

// 2. Создание сервера
const server = http.createServer(app);
const wss = new Server({ server });

let lobby = null;

console.log(`[SERVER] Запуск на порту ${PORT}`);

wss.on('connection', (ws) => {
    console.log('Новый игрок подключился');

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);

            if (data.type === 'join') {
                ws.userData = {
                    name: data.name || 'Игрок',
                    trophies: data.trophies || 0
                };

                if (lobby && lobby !== ws && lobby.readyState === 1) {
                    const p1 = lobby;
                    const p2 = ws;

                    p1.opponent = p2;
                    p2.opponent = p1;

                    p1.send(JSON.stringify({
                        type: 'match_found',
                        side: 'bottom',
                        oppName: p2.userData.name,
                        oppTrophies: p2.userData.trophies
                    }));

                    p2.send(JSON.stringify({
                        type: 'match_found',
                        side: 'top',
                        oppName: p1.userData.name,
                        oppTrophies: p1.userData.trophies
                    }));

                    console.log(`МАТЧ: ${p1.userData.name} vs ${p2.userData.name}`);
                    lobby = null;
                } else {
                    lobby = ws;
                    console.log(`ОЖИДАНИЕ: ${ws.userData.name} ищет игру`);
                }
            }

            if (data.type === 'spawn' || data.type === 'emoji') {
                if (ws.opponent && ws.opponent.readyState === 1) {
                    ws.opponent.send(JSON.stringify(data));
                }
            }
        } catch (err) {
            console.error('Ошибка обработки сообщения:', err);
        }
    });

    ws.on('close', () => {
        if (lobby === ws) lobby = null;
        if (ws.opponent) {
            if (ws.opponent.readyState === 1) {
                ws.opponent.send(JSON.stringify({ 
                    type: 'opponent_left', 
                    reason: 'Противник покинул игру' 
                }));
            }
            ws.opponent.opponent = null;
        }
        console.log('Игрок отключился');
    });
});

server.listen(PORT, () => {
    console.log(`[SERVER] Готов к работе на порту ${PORT}`);
});
