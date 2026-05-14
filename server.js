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

// Хранилище игроков и матчей
const players = new Map(); // playerId -> { ws, nick, cups, status, opponentId, matchId }
const searchingPlayers = []; // Очередь игроков в поиске
const matches = new Map(); // matchId -> { player1, player2, gameState }

function generateId() {
  return Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
}

// Поиск соперника
function tryMatchPlayers() {
  console.log(`🔍 Поиск матча. В очереди: ${searchingPlayers.length} игроков`);
  
  while (searchingPlayers.length >= 2) {
    const player1Id = searchingPlayers.shift();
    const player2Id = searchingPlayers.shift();
    
    const player1 = players.get(player1Id);
    const player2 = players.get(player2Id);
    
    if (!player1 || !player2) continue;
    if (player1.ws.readyState !== WebSocket.OPEN || player2.ws.readyState !== WebSocket.OPEN) continue;
    
    console.log(`✅ Создаём матч: ${player1.nick} vs ${player2.nick}`);
    createMatch(player1Id, player2Id);
  }
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
  
  console.log(`🎮 Матч #${matchId}: ${player1.nick} (🏆${player1.cups}) vs ${player2.nick} (🏆${player2.cups})`);
  
  // Обновляем статусы
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
    gameState: {
      units: [],
      towers: {
        player1: [
          { x: 60, y: 470, w: 30, h: 30, hp: 800, maxHp: 800, type: 'side', owner: 'player' },
          { x: 185, y: 490, w: 45, h: 45, hp: 1500, maxHp: 1500, type: 'main', owner: 'player' },
          { x: 310, y: 470, w: 30, h: 30, hp: 800, maxHp: 800, type: 'side', owner: 'player' }
        ],
        player2: [
          { x: 60, y: 50, w: 30, h: 30, hp: 800, maxHp: 800, type: 'side', owner: 'player' },
          { x: 185, y: 15, w: 45, h: 45, hp: 1500, maxHp: 1500, type: 'main', owner: 'player' },
          { x: 310, y: 50, w: 30, h: 30, hp: 800, maxHp: 800, type: 'side', owner: 'player' }
        ]
      }
    }
  };
  
  matches.set(matchId, match);
  
  // Отправляем matchFound первому игроку
  if (player1.ws.readyState === WebSocket.OPEN) {
    const msg1 = JSON.stringify({
      type: 'matchFound',
      opponent: player2Id,
      opponentNick: player2.nick,
      opponentCups: player2.cups,
      matchId: matchId
    });
    player1.ws.send(msg1);
    console.log(`📤 matchFound -> ${player1.nick}`);
  }
  
  // Отправляем matchFound второму игроку
  if (player2.ws.readyState === WebSocket.OPEN) {
    const msg2 = JSON.stringify({
      type: 'matchFound',
      opponent: player1Id,
      opponentNick: player1.nick,
      opponentCups: player1.cups,
      matchId: matchId
    });
    player2.ws.send(msg2);
    console.log(`📤 matchFound -> ${player2.nick}`);
  }
  
  return match;
}

// Отправка состояния игры
function broadcastGameState(matchId) {
  const match = matches.get(matchId);
  if (!match) return;
  
  const player1 = players.get(match.player1);
  const player2 = players.get(match.player2);
  
  // Игроку 1
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
  
  // Игроку 2
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
      
      switch(message.type) {
        case 'setId':
          playerId = message.id;
          console.log(`🆔 Игрок подключился: ${playerId} (${message.nick})`);
          
          // Создаём или обновляем игрока
          if (!players.has(playerId)) {
            players.set(playerId, {
              ws: ws,
              nick: message.nick || 'Игрок',
              cups: message.cups || 0,
              status: 'idle',
              opponentId: null,
              matchId: null
            });
            console.log(`👤 Новый игрок: ${message.nick} (🏆${message.cups || 0})`);
          } else {
            const player = players.get(playerId);
            player.ws = ws;
            player.nick = message.nick || player.nick;
            player.cups = message.cups || player.cups;
            // Если игрок был в поиске, возвращаем в очередь
            if (player.status === 'searching') {
              player.status = 'idle';
              // Удаляем из очереди если есть
              const idx = searchingPlayers.indexOf(playerId);
              if (idx > -1) searchingPlayers.splice(idx, 1);
            }
            console.log(`🔄 Игрок переподключился: ${player.nick}`);
          }
          
          // Подтверждаем ID
          ws.send(JSON.stringify({ type: 'idAssigned', id: playerId }));
          break;
          
        case 'findMatch':
          if (!playerId) {
            console.error('❌ findMatch: нет playerId');
            return;
          }
          
          const seeker = players.get(playerId);
          if (!seeker) {
            console.error('❌ findMatch: игрок не найден');
            return;
          }
          
          // Обновляем данные игрока
          seeker.nick = message.nick || seeker.nick;
          seeker.cups = message.cups || seeker.cups;
          seeker.status = 'searching';
          
          // Добавляем в очередь поиска
          if (!searchingPlayers.includes(playerId)) {
            searchingPlayers.push(playerId);
            console.log(`🔍 ${seeker.nick} добавлен в очередь поиска (всего: ${searchingPlayers.length})`);
          }
          
          // Подтверждаем поиск
          ws.send(JSON.stringify({ type: 'searching' }));
          
          // Пробуем найти матч
          tryMatchPlayers();
          break;
          
        case 'placeUnit':
          if (!playerId) return;
          const player = players.get(playerId);
          if (!player || !player.matchId) {
            console.error('❌ placeUnit: игрок не в матче');
            return;
          }
          
          const match = matches.get(player.matchId);
          if (!match) {
            console.error('❌ placeUnit: матч не найден');
            return;
          }
          
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
          if (message.towers && message.towers.player) {
            if (playerIsPlayer1) {
              currentMatch.gameState.towers.player1 = message.towers.player;
            } else {
              currentMatch.gameState.towers.player2 = message.towers.player;
            }
          }
          
          broadcastGameState(currentMatch.id);
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
          
          console.log(`🏁 Матч #${endMatch.id} завершён. Победитель: ${winner || 'ничья'}`);
          
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
          console.log('🗑️ Матч удалён, игроки свободны');
          break;
      }
    } catch (error) {
      console.error('❌ Ошибка обработки сообщения:', error);
    }
  });
  
  ws.on('close', () => {
    console.log(`🔌 Отключение: ${playerId || 'неизвестный'}`);
    
    if (playerId) {
      // Удаляем из очереди поиска
      const searchIdx = searchingPlayers.indexOf(playerId);
      if (searchIdx > -1) {
        searchingPlayers.splice(searchIdx, 1);
        console.log(`🗑️ ${playerId} удалён из очереди поиска`);
      }
      
      const player = players.get(playerId);
      if (player) {
        // Если был в матче - завершаем
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
              console.log(`🏆 ${opponent.nick} победил из-за отключения соперника`);
            }
            matches.delete(player.matchId);
          }
        }
        
        player.status = 'disconnected';
        // Удаляем через 30 секунд
        setTimeout(() => {
          const p = players.get(playerId);
          if (p && p.status === 'disconnected') {
            players.delete(playerId);
            console.log(`🗑️ Игрок ${playerId} удалён`);
          }
        }, 30000);
      }
    }
  });
});

// Логирование состояния каждые 10 секунд
setInterval(() => {
  console.log(`📊 Статистика: ${players.size} игроков, ${searchingPlayers.length} в поиске, ${matches.size} матчей`);
}, 10000);

server.listen(PORT, () => {
  console.log(`👑 Сервер BUM ROYALE запущен на порту ${PORT}`);
  console.log(`🌐 http://localhost:${PORT}`);
});
