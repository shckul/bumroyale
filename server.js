const express = require('express');
const path = require('path');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
  cors: { origin: "*" }
});

// ЭТА СТРОЧКА заставляет сервер открывать твой royale.html при заходе по ссылке
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'royale.html'));
});

let waitingPlayer = null;

io.on('connection', (socket) => {
  console.log('Игрок подключился:', socket.id);

  socket.on('find_match', () => {
    if (waitingPlayer && waitingPlayer.id !== socket.id) {
      const roomName = `room_${waitingPlayer.id}_${socket.id}`;
      socket.join(roomName);
      waitingPlayer.join(roomName);
      io.to(roomName).emit('start_game', { room: roomName });
      waitingPlayer = null;
    } else {
      waitingPlayer = socket;
    }
  });

  socket.on('spawn_unit', (data) => {
    socket.to(data.room).emit('enemy_spawn', data);
  });

  socket.on('disconnect', () => {
    if (waitingPlayer && waitingPlayer.id === socket.id) waitingPlayer = null;
  });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
  console.log(`Сервер запущен!`);
});
