const WebSocket = require('ws');
const http = require('http');
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Раздаём статику (royale.html)
app.use(express.static(path.join(__dirname)));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'royale.html'));
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Хранилище игроков и матчей
const players = new Map(); // playerId -> { ws, nick, cups, status: 'idle'|'searching'|'playing', opponentId, matchId }
const matches = new Map(); // matchId -> { player1, player2, gameState, startTime, suddenDeath }

// Генерация ID
function generateId() {
  return Math.random().toString(36).substr(2, 9);
}

// Поиск соперника
function findOpponent(seekerId) {
  const seeker = players.get(seekerId);
  if (!seeker) return null;
  
  // Ищем другого игрока в поиске с похожими кубками (±200)
  for (let [id, player] of players) {
    if (id !== seekerId && 
        player.status === 'searching' && 
        Math.abs(player.cups - seeker.cups) <= 200) {
      return player;
    }
  }
  return null;
}

// Создание матча
function createMatch(player1Id, player2Id) {
  const matchId = generateId();
  const player1 = players.get(player1Id);
  const player2 = players.get(player2Id);
  
  player1.status = 'playing';
  player2.status = 'playing';
  player1.opponentId = player2Id;
  player2.opponentId = player1Id;
  player1.matchId = matchId;
  player2.matchId = matchId;
  
  const match = {
    id: matchId,
    player1: player1Id,
    player2: player2Id,
    startTime: Date.now(),
    suddenDeath: false,
    gameState: {
      units: [],
      towers: {
        player1: [
          { x: 70, y: 320, hp: 800, maxHp: 800, type: 'side', owner: 'player' },
          { x: 200, y: 340, hp: 1200, maxHp: 1200, type: 'main', owner: 'player' },
          { x: 330, y: 320, hp: 800, maxHp: 800, type: 'side', owner: 'player' }
        ],
        player2: [
          { x: 70, y: 40, hp: 800, maxHp: 800, type: 'side', owner: 'enemy' },
          { x: 200, y: 20, hp: 1200, maxHp: 1200, type: 'main', owner: 'enemy' },
          { x: 330, y: 40, hp: 800, maxHp: 800, type: 'side', owner: 'enemy' }
        ]
      },
      elixir: { player1: 5, player2: 5 }
    }
  };
  
  matches.set(matchId, match);
  
  // Уведомляем обоих игроков о найденном матче
  player1.ws.send(JSON.stringify({
    type: 'matchFound',
    opponent: player2Id,
    opponentNick: player2.nick,
    matchId: matchId,
    playerSide: 'player1'
  }));
  
  player2.ws.send(JSON.stringify({
    type: 'matchFound',
    opponent: player1Id,
    opponentNick: player1.nick,
    matchId: matchId,
    playerSide: 'player2'
  }));
  
  return match;
}

// Отправка состояния игры обоим игрокам
function broadcastGameState(matchId) {
  const match = matches.get(matchId);
  if (!match) return;
  
  const player1 = players.get(match.player1);
  const player2 = players.get(match.player2);
  
  if (player1 && player1.ws.readyState === WebSocket.OPEN) {
    player1.ws.send(JSON.stringify({
      type: 'gameState',
      units: match.gameState.units,
      towers: {
        player: match.gameState.towers.player1,
        enemy: match.gameState.towers.player2
      },
      elixir: match.gameState.elixir.player1,
      suddenDeath: match.suddenDeath
    }));
  }
  
  if (player2 && player2.ws.readyState === WebSocket.OPEN) {
    // Для player2 меняем башни местами
    player2.ws.send(JSON.stringify({
      type: 'gameState',
      units: match.gameState.units.map(u => ({
        ...u,
        owner: u.owner === 'player1' ? 'enemy' : 'player'
      })),
      towers: {
        player: match.gameState.towers.player2,
        enemy: match.gameState.towers.player1
      },
      elixir: match.gameState.elixir.player2,
      suddenDeath: match.suddenDeath
    }));
  }
}

// Обработка WebSocket соединений
wss.on('connection', (ws) => {
  let playerId = null;
  
  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data);
      
      switch(message.type) {
        case 'setId':
          // Установка ID игрока при первом подключении
          playerId = message.id;
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
            // Обновляем WebSocket если переподключился
            const player = players.get(playerId);
            player.ws = ws;
            player.nick = message.nick || player.nick;
            player.cups = message.cups || player.cups;
          }
          ws.send(JSON.stringify({ type: 'idAssigned', id: playerId }));
          break;
          
        case 'findMatch':
          // Поиск матча
          if (!playerId) return;
          const seeker = players.get(playerId);
          if (!seeker) return;
          
          seeker.status = 'searching';
          seeker.nick = message.nick || seeker.nick;
          seeker.cups = message.cups || seeker.cups;
          
          const opponent = findOpponent(playerId);
          if (opponent) {
            // Нашли соперника - создаём матч
            const match = createMatch(playerId, opponent.ws._playerId);
            // Отправляем начальное состояние
            broadcastGameState(match.id);
          } else {
            ws.send(JSON.stringify({ type: 'searching' }));
          }
          break;
          
        case 'placeUnit':
          // Размещение юнита
          if (!playerId) return;
          const player = players.get(playerId);
          if (!player || !player.matchId) return;
          
          const match = matches.get(player.matchId);
          if (!match) return;
          
          // Определяем сторону игрока
          const isPlayer1 = match.player1 === playerId;
          const unitData = {
            ...message.unit,
            owner: isPlayer1 ? 'player1' : 'player2',
            id: message.unit.id || generateId()
          };
          
          match.gameState.units.push(unitData);
          broadcastGameState(match.id);
          break;
          
        case 'stateUpdate':
          // Обновление состояния от клиента
          if (!playerId) return;
          const currentPlayer = players.get(playerId);
          if (!currentPlayer || !currentPlayer.matchId) return;
          
          const currentMatch = matches.get(currentPlayer.matchId);
          if (!currentMatch) return;
          
          const playerIsPlayer1 = currentMatch.player1 === playerId;
          
          // Обновляем юниты
          if (message.units) {
            // Удаляем старые юниты этого игрока
            currentMatch.gameState.units = currentMatch.gameState.units.filter(u => 
              u.owner !== (playerIsPlayer1 ? 'player1' : 'player2')
            );
            // Добавляем новые
            currentMatch.gameState.units.push(...message.units.map(u => ({
              ...u,
              owner: playerIsPlayer1 ? 'player1' : 'player2'
            })));
          }
          
          // Обновляем башни
          if (message.towers) {
            if (playerIsPlayer1) {
              currentMatch.gameState.towers.player1 = message.towers.player;
            } else {
              currentMatch.gameState.towers.player2 = message.towers.player;
            }
          }
          
          broadcastGameState(currentMatch.id);
          break;
          
        case 'emoji':
          // Отправка эмодзи сопернику
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
          // Завершение матча
          if (!playerId) return;
          const endPlayer = players.get(playerId);
          if (!endPlayer || !endPlayer.matchId) return;
          
          const endMatch = matches.get(endPlayer.matchId);
          if (!endMatch) return;
          
          const winner = message.result === 'win' ? playerId : 
                        (message.result === 'lose' ? endPlayer.opponentId : null);
          
          // Уведомляем обоих игроков
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
          
          // Очищаем статус игроков
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
          break;
      }
    } catch (error) {
      console.error('Error processing message:', error);
    }
  });
  
  ws.on('close', () => {
    if (playerId) {
      const player = players.get(playerId);
      if (player) {
        // Если игрок был в матче - завершаем его
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
        // Не удаляем игрока сразу, даём время на переподключение
        setTimeout(() => {
          const p = players.get(playerId);
          if (p && p.status === 'disconnected') {
            players.delete(playerId);
          }
        }, 30000);
      }
    }
  });
});

// Запуск сервера
server.listen(PORT, () => {
  console.log(`👑 Royale Server running on port ${PORT}`);
  console.log(`🌐 Access at: https://bumroyale.onrender.com`);
});
