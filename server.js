const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
    cors: { origin: "*" }
});

let waitingPlayer = null;
let rooms = {};

io.on('connection', (socket) => {
    console.log('Пользователь подключился:', socket.id);

    socket.on('find_match', (data) => {
        if (waitingPlayer && waitingPlayer.id !== socket.id) {
            // Создаем комнату для двоих
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
            console.log('Игрок в очереди:', data.nickname);
        }
    });

    // Обработка спавна юнитов
    socket.on('spawn_unit', (data) => {
        // Пересылаем данные о юните второму игроку в комнате
        socket.to(data.room).emit('enemy_spawn', {
            unitId: data.unitId,
            x: data.x,
            y: data.y
        });
    });

    // НОВАЯ ФУНКЦИЯ: Обработка пинов (эмодзи)
    socket.on('send_emoji', (data) => {
        // Пересылаем эмодзи противнику
        socket.to(data.room).emit('receive_emoji', {
            emoji: data.emoji
        });
    });

    socket.on('disconnect', () => {
        if (waitingPlayer && waitingPlayer.id === socket.id) {
            waitingPlayer = null;
        }
        console.log('Пользователь отключился:', socket.id);
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
});

