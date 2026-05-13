const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
    cors: { origin: "*" }
});

// Раздаем статику (твой HTML, картинки, если есть) из корня
app.use(express.static(__dirname));

// При заходе на главную — отдаем твой файл
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/royale.html');
});

let waitingPlayer = null;

io.on('connection', (socket) => {
    console.log('Подключен:', socket.id);

    socket.on('find_match', (data) => {
        // Сохраняем данные игрока из твоего royale.html
        socket.nickname = data.nickname || "Игрок";
        socket.trophies = data.trophies || 0;

        if (waitingPlayer && waitingPlayer.id !== socket.id) {
            const room = `room_${waitingPlayer.id}_${socket.id}`;
            
            const playersData = {};
            playersData[waitingPlayer.id] = { nickname: waitingPlayer.nickname, trophies: waitingPlayer.trophies };
            playersData[socket.id] = { nickname: socket.nickname, trophies: socket.trophies };

            socket.join(room);
            waitingPlayer.join(room);

            // Отправляем старт обоим
            io.to(room).emit('start_game', { 
                room: room, 
                players: playersData 
            });

            waitingPlayer = null;
        } else {
            waitingPlayer = socket;
        }
    });

    socket.on('spawn_unit', (data) => {
        socket.to(data.room).emit('enemy_spawn', {
            unitId: data.unitId,
            x: data.x,
            y: data.y
        });
    });

    socket.on('disconnect', () => {
        if (waitingPlayer && waitingPlayer.id === socket.id) waitingPlayer = null;
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log('Сервер запущен на порту ' + PORT);
});
