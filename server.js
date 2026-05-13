const express = require('express');
const path = require('path'); // Добавь это для работы с путями
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
    cors: { origin: "*" }
});

// --- ДОБАВЬ ЭТОТ БЛОК, ЧТОБЫ УБРАТЬ "CANNOT GET /" ---
// Это говорит серверу отдавать твой index.html при заходе на сайт
app.use(express.static(path.join(__dirname, '.'))); 

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});
// -----------------------------------------------------

let waitingPlayer = null;
let rooms = {};

io.on('connection', (socket) => {
    console.log('Пользователь подключился:', socket.id);

    socket.on('find_match', (data) => {
        socket.nickname = data.nickname || "Игрок";
        socket.trophies = data.trophies || 0;

        if (waitingPlayer) {
            const room = `room_${waitingPlayer.id}_${socket.id}`;
            const players = {};
            
            players[waitingPlayer.id] = { nickname: waitingPlayer.nickname, trophies: waitingPlayer.trophies };
            players[socket.id] = { nickname: socket.nickname, trophies: socket.trophies };

            socket.join(room);
            waitingPlayer.join(room);

            rooms[room] = {
                players: [waitingPlayer.id, socket.id],
                battleData: players
            };

            io.to(room).emit('start_game', { 
                room: room, 
                players: players 
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
