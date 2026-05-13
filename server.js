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

    // Обработка поиска матча с получением данных игрока
    socket.on('find_match', (data) => {
        // Сохраняем ник и кубки в объекте сокета
        socket.nickname = data.nickname || "Игрок";
        socket.trophies = data.trophies || 0;

        if (waitingPlayer) {
            const room = `room_${waitingPlayer.id}_${socket.id}`;
            const players = {};
            
            // Формируем данные о игроках для отправки обоим клиентам
            players[waitingPlayer.id] = { nickname: waitingPlayer.nickname, trophies: waitingPlayer.trophies };
            players[socket.id] = { nickname: socket.nickname, trophies: socket.trophies };

            socket.join(room);
            waitingPlayer.join(room);

            rooms[room] = {
                players: [waitingPlayer.id, socket.id],
                battleData: players
            };

            // Отправляем событие старта с данными о соперниках
            io.to(room).emit('start_game', { 
                room: room, 
                players: players 
            });

            waitingPlayer = null;
        } else {
            waitingPlayer = socket;
        }
    });

    // Передача спавна юнита врагу
    socket.on('spawn_unit', (data) => {
        socket.to(data.room).emit('enemy_spawn', {
            unitId: data.unitId,
            x: data.x,
            y: data.y
        });
    });

    socket.on('disconnect', () => {
        if (waitingPlayer && waitingPlayer.id === socket.id) {
            waitingPlayer = null;
        }
        console.log('Пользователь отключился');
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
});
