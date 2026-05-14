const WebSocket = require('ws');
const http = require('http');
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname)));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'royale.html'));
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const players = new Map();
const searchingPlayers = [];
const matches = new Map();

function generateId() {
  return Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
}

// Создание матча
function createMatch(player1Id, player2Id) {
  const matchId = generateId();
  const player1 = players.get(player1Id);
  const player2 = players.get(player2Id);
  
  if (!player1 || !player2) return null;
  
  console.log(`🎮 Матч: ${player1.nick} vs ${player2.nick}`);
  
  player1.status = 'playing';
  player2.status = 'playing';
  player1.opponentId = player2Id;
  player2.opponentId = player1Id;
  player1.matchId = matchId;
  player2.matchId = matchId;
  
  // Создаем состояние матча
  const match = {
    id: matchId,
    player1: player1Id,
    player2: player2Id,
    // Башни хранятся отдельно для каждого игрока
    player1Towers: [
      { x: 60, y: 470, w: 30, h: 30, hp: 800, maxHp: 800, type: 'side' },
      { x: 185, y: 490, w: 45, h: 45, hp: 1500, maxHp: 1500, type: 'main' },
      { x: 310, y: 470, w: 30, h: 30, hp: 800, maxHp: 800, type: 'side' }
    ],
    player2Towers: [
      { x: 60, y: 50, w: 30, h: 30, hp: 800, maxHp: 800, type: 'side' },
      { x: 185, y: 15, w: 45, h: 45, hp: 1500, maxHp: 1500, type: 'main' },
      { x: 310, y: 50, w: 30, h: 30, hp: 800, maxHp: 800, type: 'side' }
    ],
    units: []
  };
  
  matches.set(matchId, match);
  
  // Отправляем matchFound игроку 1 (он видит врага сверху)
  player1.ws.send(JSON.stringify({
    type: 'matchFound',
    opponent: player2Id,
    opponentNick: player2.nick,
    opponentCups: player2.cups,
    matchId: matchId,
    mySide: 'bottom'
  }));
  
  // Отправляем matchFound игроку 2 (он видит врага сверху)
  player2.ws.send(JSON.stringify({
    type: 'matchFound',
    opponent: player1Id,
    opponentNick: player1.nick,
    opponentCups: player1.cups,
    matchId: matchId,
    mySide: 'bottom'
  }));
  
  return match;
}

// Отправка состояния игроку
function sendGameState(playerId, match) {
  const player = players.get(playerId);
  if (!player || player.ws.readyState !== WebSocket.OPEN) return;
  
  const isPlayer1 = match.player1 === playerId;
  
  // Определяем, какие башни мои, а какие врага
  const myTowers = isPlayer1 ? match.player1Towers : match.player2Towers;
  const enemyTowers = isPlayer1 ? match.player2Towers : match.player1Towers;
  
  // Фильтруем юнитов: мои и вражеские
  const myUnits = match.units
    .filter(u => u.owner === playerId)
    .map(u => ({ ...u, owner: 'player' }));
  const enemyUnits = match.units
    .filter(u => u.owner !== playerId)
    .map(u => ({ ...u, owner: 'enemy' }));
  
  const state = {
    type: 'gameState',
    units: [...myUnits, ...enemyUnits],
    towers: {
      player: myTowers.map(t => ({ ...t, owner: 'player' })),
      enemy: enemyTowers.map(t => ({ ...t, owner: 'enemy' }))
    }
  };
  
  player.ws.send(JSON.stringify(state));
}

// Отправка состояния обоим игрокам
function broadcastGameState(matchId) {
  const match = matches.get(matchId);
  if (!match) return;
  
  sendGameState(match.player1, match);
  sendGameState(match.player2, match);
}

// Поиск соперника
function tryMatchPlayers() {
  console.log(`🔍 В очереди: ${searchingPlayers.length}`);
  
  while (searchingPlayers.length >= 2) {
    const player1Id = searchingPlayers.shift();
    const player2Id = searchingPlayers.shift();
    
    const player1 = players.get(player1Id);
    const player2 = players.get(player2Id);
    
    if (!player1 || !player2) continue;
    if (player1.ws.readyState !== WebSocket.OPEN || player2.ws.readyState !== WebSocket.OPEN) {
      // Возвращаем в очередь того, кто еще подключен
      if (player1 && player1.ws.readyState === WebSocket.OPEN) {
        searchingPlayers.unshift(player1Id);
      }
      if (player2 && player2.ws.readyState === WebSocket.OPEN) {
        searchingPlayers.unshift(player2Id);
      }
      continue;
    }
    
    createMatch(player1Id, player2Id);
  }
}

wss.on('connection', (ws) => {
  let playerId = null;
  
  console.log('🔌 Новое подключение');
  
  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data);
      
      switch(message.type) {
        case 'setId':
          playerId = message.id;
          console.log(`🆔 ${message.nick} (${playerId})`);
          
          if (!players.has(playerId)) {
            players.set(playerId, {
              ws: ws,
              nick: message.nick || 'Игрок',
              cups: message.cups || 0,
              status: 'idle',
              opponentId: null,
              matchId: null
            });
          } else {
            const p = players.get(playerId);
            p.ws = ws;
            p.nick = message.nick || p.nick;
            p.cups = message.cups || p.cups;
            // Если был в поиске - удаляем из очереди
            const idx = searchingPlayers.indexOf(playerId);
            if (idx > -1) searchingPlayers.splice(idx, 1);
            p.status = 'idle';
          }
          
          ws.send(JSON.stringify({ type: 'idAssigned', id: playerId }));
          break;
          
        case 'findMatch':
          if (!playerId) return;
          const seeker = players.get(playerId);
          if (!seeker) return;
          
          seeker.nick = message.nick || seeker.nick;
          seeker.cups = message.cups || seeker.cups;
          seeker.status = 'searching';
          
          if (!searchingPlayers.includes(playerId)) {
            searchingPlayers.push(playerId);
            console.log(`🔍 ${seeker.nick} ищет матч (в очереди: ${searchingPlayers.length})`);
          }
          
          ws.send(JSON.stringify({ type: 'searching' }));
          tryMatchPlayers();
          break;
          
        case 'placeUnit':
          if (!playerId) return;
          const player = players.get(playerId);
          if (!player || !player.matchId) return;
          
          const match = matches.get(player.matchId);
          if (!match) return;
          
          // Добавляем юнит с правильным owner (ID игрока)
          const unit = {
            ...message.unit,
            owner: playerId, // Владелец - ID игрока
            id: message.unit.id || generateId()
          };
          
          match.units.push(unit);
          console.log(`👤 ${player.nick} разместил ${unit.icon || unit.type}`);
          broadcastGameState(match.id);
          break;
          
        case 'stateUpdate':
          if (!playerId) return;
          const currentPlayer = players.get(playerId);
          if (!currentPlayer || !currentPlayer.matchId) return;
          
          const currentMatch = matches.get(currentPlayer.matchId);
          if (!currentMatch) return;
          
          // Обновляем юниты: удаляем старые юниты этого игрока, добавляем новые
          if (message.units) {
            currentMatch.units = currentMatch.units.filter(u => u.owner !== playerId);
            currentMatch.units.push(...message.units.map(u => ({
              ...u,
              owner: playerId
            })));
          }
          
          // Обновляем башни игрока
          if (message.towers && message.towers.player) {
            const isPlayer1 = currentMatch.player1 === playerId;
            if (isPlayer1) {
              currentMatch.player1Towers = message.towers.player.map(t => ({
                x: t.x, y: t.y, w: t.w, h: t.h, hp: t.hp, maxHp: t.maxHp, type: t.type
              }));
            } else {
              currentMatch.player2Towers = message.towers.player.map(t => ({
                x: t.x, y: t.y, w: t.w, h: t.h, hp: t.hp, maxHp: t.maxHp, type: t.type
              }));
            }
          }
          
          // Отправляем обновленное состояние обоим
          broadcastGameState(currentMatch.id);
          break;
          
        case 'emoji':
          if (!playerId) return;
          const emojiPlayer = players.get(playerId);
          if (!emojiPlayer || !emojiPlayer.opponentId) return;
          
          const opponent = players.get(emojiPlayer.opponentId);
          if (opponent && opponent.ws.readyState === WebSocket.OPEN) {
            opponent.ws.send(JSON.stringify({
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
          
          const p1 = players.get(endMatch.player1);
          const p2 = players.get(endMatch.player2);
          
          console.log(`🏁 Матч завершен`);
          
          // Определяем результат для каждого
          let result1, result2;
          if (message.result === 'win') {
            result1 = endMatch.player1 === playerId ? 'win' : 'lose';
            result2 = endMatch.player2 === playerId ? 'win' : 'lose';
          } else if (message.result === 'lose') {
            result1 = endMatch.player1 === playerId ? 'lose' : 'win';
            result2 = endMatch.player2 === playerId ? 'lose' : 'win';
          } else {
            result1 = 'draw';
            result2 = 'draw';
          }
          
          if (p1 && p1.ws.readyState === WebSocket.OPEN) {
            p1.ws.send(JSON.stringify({ type: 'battleEnd', result: result1 }));
          }
          if (p2 && p2.ws.readyState === WebSocket.OPEN) {
            p2.ws.send(JSON.stringify({ type: 'battleEnd', result: result2 }));
          }
          
          // Очистка
          [p1, p2].forEach(p => {
            if (p) {
              p.status = 'idle';
              p.opponentId = null;
              p.matchId = null;
            }
          });
          
          matches.delete(endMatch.id);
          break;
      }
    } catch (error) {
      console.error('❌ Ошибка:', error);
    }
  });
  
  ws.on('close', () => {
    console.log(`🔌 Отключение: ${playerId}`);
    if (playerId) {
      const idx = searchingPlayers.indexOf(playerId);
      if (idx > -1) searchingPlayers.splice(idx, 1);
      
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
                result: 'win'
              }));
            }
            matches.delete(player.matchId);
          }
        }
        player.status = 'disconnected';
        setTimeout(() => {
          const p = players.get(playerId);
          if (p && p.status === 'disconnected') players.delete(playerId);
        }, 30000);
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`👑 Сервер запущен на порту ${PORT}`);
});
