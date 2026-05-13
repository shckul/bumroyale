const express = require('express');
const app = express();
const http = require('http').createServer(app);
const path = require('path');
const io = require('socket.io')(http, {
    cors: { origin: "*" }
});

// Раздача файлов из текущей папки (нужно, чтобы сервер видел royale.html)
app.use(express.static(__dirname));

// При заходе на главную отдаем твой файл
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'royale.html'));
});

let waitingPlayer = null;
let rooms = {};

io.on('connection', (socket) => {
    console.log('Игрок подключился:', socket.id);

    socket.on('find_match', (data) => {
        if (waitingPlayer && waitingPlayer.id !== socket.id) {
            const roomId = `room_${waitingPlayer.id}_${socket.id}`;
            const enemy = waitingPlayer;
            waitingPlayer = null;

            rooms[roomId] = {
                players: {
                    [socket.id]: { nickname: data.nickname, trophies: data.trophies },
                    [enemy.id]: { nickname: enemy.nickname, trophies: enemy.trophies }
                }
            };

            socket.join(roomId);
            enemy.socket.join(roomId);

            io.to(roomId).emit('start_game', {
                room: roomId,
                players: rooms[roomId].players
            });
            console.log(`Игра началась в комнате: ${roomId}`);
        } else {
            waitingPlayer = { id: socket.id, socket: socket, nickname: data.nickname, trophies: data.trophies };
        }
    });

    socket.on('spawn_unit', (data) => {
        socket.to(data.room).emit('enemy_spawn', {
            unitId: data.unitId,
            x: data.x,
            y: data.y
        });
    });

    socket.on('send_emoji', (data) => {
        socket.to(data.room).emit('receive_emoji', {
            emoji: data.emoji
        });
    });

    socket.on('disconnect', () => {
        if (waitingPlayer && waitingPlayer.id === socket.id) {
            waitingPlayer = null;
        }
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Сервер Bum Royale запущен на порту ${PORT}`);
});
