const WebSocket = require('ws');
const http = require('http');
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Раздаём статику
app.use(express.static(path.join(__dirname)));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'royale.html'));
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Хранилище игроков
const players = new Map(); // playerId -> { ws, nick, cups, status, opponentId, matchId, side }
const matches = new Map(); // matchId -> { player1, player2, gameState }

function generateId() {
  return Math.random().toString(36).substr(2, 9);
}

// Поиск соперника
function findOpponent(seekerId) {
  const seeker = players.get(seekerId);
  if (!seeker || seeker.status !== 'searching') return null;
  
  console.log(`🔍 Ищем соперника для ${seeker.nick} (${seekerId})`);
  console.log(`Всего игроков: ${players.size}`);
  
  for (let [id, player] of players) {
    if (id !== seekerId && 
        player.status === 'searching' &&
        player.ws.readyState === WebSocket.OPEN) {
      console.log(`✅ Найден соперник: ${player.nick} (${id})`);
      return player;
    }
  }
  
  console.log(`❌ Соперник не найден для ${seeker.nick}`);
  return null;
}

// Создание матча
function createMatch(player1Id, player2Id) {
  const matchId = generateId();
  const player1 = players.get(player1Id);
  const player2 = players.get(player2Id);
  
  if (!player1 || !player2) {
    console.error('❌ Ошибка: игроки не найдены');
    return null;
  }
  
  console.log(`🎮 Создание матча: ${player1.nick} vs ${player2.nick}`);
  
  player1.status = 'playing';
  player2.status = 'playing';
  player1.opponentId = player2Id;
  player2.opponentId = player1Id;
  player1.matchId = matchId;
  player2.matchId = matchId;
  player1.side = 'player1';
  player2.side = 'player2';
  
  const match = {
    id: matchId,
    player1: player1Id,
    player2: player2Id,
    gameState: {
      units: [],
      towers: {
        player1: [
          { x: 70, y: 320, hp: 800, maxHp: 800, type: 'side', owner: 'player' },
          { x: 200, y: 340, hp: 1200, maxHp: 1200, type: 'main', owner: 'player' },
          { x: 330, y: 320, hp: 800, maxHp: 800, type: 'side', owner: 'player' }
        ],
        player2: [
          { x: 70, y: 40, hp: 800, maxHp: 800, type: 'side', owner: 'player' },
          { x: 200, y: 20, hp: 1200, maxHp: 1200, type: 'main', owner: 'player' },
          { x: 330, y: 40, hp: 800, maxHp: 800, type: 'side', owner: 'player' }
        ]
      }
    }
  };
  
  matches.set(matchId, match);
  
  // Уведомляем первого игрока
  if (player1.ws.readyState === WebSocket.OPEN) {
    player1.ws.send(JSON.stringify({
      type: 'matchFound',
      opponent: player2Id,
      opponentNick: player2.nick,
      matchId: matchId
    }));
    console.log(`📤 matchFound отправлен игроку 1: ${player1.nick}`);
  }
  
  // Уведомляем второго игрока
  if (player2.ws.readyState === WebSocket.OPEN) {
    player2.ws.send(JSON.stringify({
      type: 'matchFound',
      opponent: player1Id,
      opponentNick: player1.nick,
      matchId: matchId
    }));
    console.log(`📤 matchFound отправлен игроку 2: ${player2.nick}`);
  }
  
  return match;
}

// Отправка состояния игры
function broadcastGameState(matchId) {
  const match = matches.get(matchId);
  if (!match) return;
  
  const player1 = players.get(match.player1);
  const player2 = players.get(match.player2);
  
  // Игроку 1 отправляем его башни как player, вражеские как enemy
  if (player1 && player1.ws.readyState === WebSocket.OPEN) {
    player1.ws.send(JSON.stringify({
      type: 'gameState',
      units: match.gameState.units.map(u => ({
        ...u,
        owner: u.owner === 'player2' ? 'enemy' : u.owner
      })),
      towers: {
        player: match.gameState.towers.player1,
        enemy: match.gameState.towers.player2.map(t => ({...t, owner: 'enemy'}))
      }
    }));
  }
  
  // Игроку 2 отправляем его башни как player, вражеские как enemy
  if (player2 && player2.ws.readyState === WebSocket.OPEN) {
    player2.ws.send(JSON.stringify({
      type: 'gameState',
      units: match.gameState.units.map(u => ({
        ...u,
        owner: u.owner === 'player1' ? 'enemy' : u.owner
      })),
      towers: {
        player: match.gameState.towers.player2,
        enemy: match.gameState.towers.player1.map(t => ({...t, owner: 'enemy'}))
      }
    }));
  }
}

// Обработка WebSocket соединений
wss.on('connection', (ws) => {
  let playerId = null;
  
  console.log('🔌 Новое подключение');
  
  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data);
      console.log(`📩 Сообщение от ${playerId || 'неизвестный'}: ${message.type}`);
      
      switch(message.type) {
        case 'setId':
          playerId = message.id;
          console.log(`🆔 Установка ID: ${playerId} (${message.nick})`);
          
          if (!players.has(playerId)) {
            players.set(playerId, {
              ws: ws,
              nick: message.nick || 'Игрок',
              cups: message.cups || 0,
              status: 'idle',
              opponentId: null,
              matchId: null,
              side: null
            });
            console.log(`👤 Новый игрок: ${message.nick}`);
          } else {
            const player = players.get(playerId);
            player.ws = ws;
            player.nick = message.nick || player.nick;
            player.cups = message.cups || player.cups;
            console.log(`🔄 Игрок переподключился: ${player.nick}`);
          }
          
          ws.send(JSON.stringify({ type: 'idAssigned', id: playerId }));
          break;
          
        case 'findMatch':
          if (!playerId) return;
          const seeker = players.get(playerId);
          if (!seeker) return;
          
          seeker.status = 'searching';
          seeker.nick = message.nick || seeker.nick;
          seeker.cups = message.cups || seeker.cups;
          
          console.log(`🔍 ${seeker.nick} ищет матч...`);
          
          // Ищем соперника
          const opponent = findOpponent(playerId);
          if (opponent) {
            createMatch(playerId, opponent.ws._playerId || opponent.opponentId || playerId);
          } else {
            ws.send(JSON.stringify({ type: 'searching' }));
          }
          break;
          
        case 'placeUnit':
          if (!playerId) return;
          const player = players.get(playerId);
          if (!player || !player.matchId) return;
          
          const match = matches.get(player.matchId);
          if (!match) return;
          
          const isPlayer1 = match.player1 === playerId;
          const unitData = {
            ...message.unit,
            owner: isPlayer1 ? 'player1' : 'player2',
            id: message.unit.id || generateId()
          };
          
          match.gameState.units.push(unitData);
          broadcastGameState(match.id);
          break;
          
        case 'emoji':
          if (!playerId) return;
          const emojiPlayer = players.get(playerId);
          if (!emojiPlayer || !emojiPlayer.opponentId) return;
          
          const opponentPlayer = players.get(emojiPlayer.opponentId);
          if (opponentPlayer && opponentPlayer.ws.readyState === WebSocket.OPEN) {
            opponentPlayer.ws.send(JSON.stringify({
              type: 'emoji',
              emoji: message.emoji,
              from: playerId
            }));
          }
          break;
          
        case 'battleEnd':
          if (!playerId) return;
          const endPlayer = players.get(playerId);
          if (!endPlayer || !endPlayer.matchId) return;
          
          const endMatch = matches.get(endPlayer.matchId);
          if (!endMatch) return;
          
          const winner = message.result === 'win' ? playerId : 
                        (message.result === 'lose' ? endPlayer.opponentId : null);
          
          const p1 = players.get(endMatch.player1);
          const p2 = players.get(endMatch.player2);
          
          if (p1 && p1.ws.readyState === WebSocket.OPEN) {
            p1.ws.send(JSON.stringify({
              type: 'battleEnd',
              result: winner === endMatch.player1 ? 'win' : (winner === endMatch.player2 ? 'lose' : 'draw'),
              winner: winner
            }));
          }
          
          if (p2 && p2.ws.readyState === WebSocket.OPEN) {
            p2.ws.send(JSON.stringify({
              type: 'battleEnd',
              result: winner === endMatch.player2 ? 'win' : (winner === endMatch.player1 ? 'lose' : 'draw'),
              winner: winner
            }));
          }
          
          // Очистка
          if (p1) {
            p1.status = 'idle';
            p1.opponentId = null;
            p1.matchId = null;
          }
          if (p2) {
            p2.status = 'idle';
            p2.opponentId = null;
            p2.matchId = null;
          }
          
          matches.delete(endMatch.id);
          console.log('🗑️ Матч удален');
          break;
      }
    } catch (error) {
      console.error('❌ Ошибка обработки сообщения:', error);
    }
  });
  
  ws.on('close', () => {
    console.log(`🔌 Отключение игрока: ${playerId}`);
    if (playerId) {
      const player = players.get(playerId);
      if (player) {
        if (player.matchId) {
          const match = matches.get(player.matchId);
          if (match) {
            const opponentId = match.player1 === playerId ? match.player2 : match.player1;
            const opponent = players.get(opponentId);
            if (opponent && opponent.ws.readyState === WebSocket.OPEN) {
              opponent.ws.send(JSON.stringify({
                type: 'battleEnd',
                result: 'win',
                winner: opponentId
              }));
            }
            matches.delete(player.matchId);
          }
        }
        player.status = 'disconnected';
        setTimeout(() => {
          const p = players.get(playerId);
          if (p && p.status === 'disconnected') {
            players.delete(playerId);
          }
        }, 30000);
      }
    }
  });
  
  // Сохраняем playerId в объекте ws для доступа из других мест
  ws._playerId = null;
  const originalOnMessage = ws.onmessage;
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'setId') {
        ws._playerId = msg.id;
      }
    } catch(e) {}
  });
});

server.listen(PORT, () => {
  console.log(`👑 Сервер запущен на порту ${PORT}`);
  console.log(`🌐 Доступен по адресу: http://localhost:${PORT}`);
});
