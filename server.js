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

// ФИКСИРОВАННЫЕ позиции башен
const TOWER_POSITIONS_BOTTOM = [
  { x: 60, y: 470, w: 30, h: 30, type: 'side' },
  { x: 185, y: 490, w: 45, h: 45, type: 'main' },
  { x: 310, y: 470, w: 30, h: 30, type: 'side' }
];

const TOWER_POSITIONS_TOP = [
  { x: 60, y: 50, w: 30, h: 30, type: 'side' },
  { x: 185, y: 15, w: 45, h: 45, type: 'main' },
  { x: 310, y: 50, w: 30, h: 30, type: 'side' }
];

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
  
  const match = {
    id: matchId,
    player1: player1Id,
    player2: player2Id,
    player1TowerHP: [800, 1500, 800],
    player2TowerHP: [800, 1500, 800],
    units: []
  };
  
  matches.set(matchId, match);
  
  player1.ws.send(JSON.stringify({
    type: 'matchFound',
    opponent: player2Id,
    opponentNick: player2.nick,
    opponentCups: player2.cups,
    matchId: matchId
  }));
  
  player2.ws.send(JSON.stringify({
    type: 'matchFound',
    opponent: player1Id,
    opponentNick: player1.nick,
    opponentCups: player1.cups,
    matchId: matchId
  }));
  
  setTimeout(() => broadcastGameState(matchId), 100);
  
  return match;
}

function sendGameState(playerId, match) {
  const player = players.get(playerId);
  if (!player || player.ws.readyState !== WebSocket.OPEN) return;
  
  const isPlayer1 = match.player1 === playerId;
  
  // Мои башни (внизу)
  const myHP = isPlayer1 ? match.player1TowerHP : match.player2TowerHP;
  const myTowers = TOWER_POSITIONS_BOTTOM.map((pos, i) => ({
    ...pos,
    hp: myHP[i],
    maxHp: pos.type === 'main' ? 1500 : 800,
    owner: 'player'
  }));
  
  // Вражеские башни (вверху)
  const enemyHP = isPlayer1 ? match.player2TowerHP : match.player1TowerHP;
  const enemyTowers = TOWER_POSITIONS_TOP.map((pos, i) => ({
    ...pos,
    hp: enemyHP[i],
    maxHp: pos.type === 'main' ? 1500 : 800,
    owner: 'enemy'
  }));
  
  // ТОЛЬКО вражеские юниты (своих клиент отслеживает сам)
  const enemyUnits = match.units
    .filter(u => u.owner !== playerId && u.hp > 0)
    .map(u => ({
      ...u,
      owner: 'enemy'
    }));
  
  const state = {
    type: 'gameState',
    enemyUnits: enemyUnits,
    towers: {
      player: myTowers,
      enemy: enemyTowers
    }
  };
  
  player.ws.send(JSON.stringify(state));
}

function broadcastGameState(matchId) {
  const match = matches.get(matchId);
  if (!match) return;
  
  sendGameState(match.player1, match);
  sendGameState(match.player2, match);
}

function tryMatchPlayers() {
  while (searchingPlayers.length >= 2) {
    const player1Id = searchingPlayers.shift();
    const player2Id = searchingPlayers.shift();
    
    const player1 = players.get(player1Id);
    const player2 = players.get(player2Id);
    
    if (!player1 || !player2) continue;
    if (player1.ws.readyState !== WebSocket.OPEN || player2.ws.readyState !== WebSocket.OPEN) {
      if (player1 && player1.ws.readyState === WebSocket.OPEN) searchingPlayers.unshift(player1Id);
      if (player2 && player2.ws.readyState === WebSocket.OPEN) searchingPlayers.unshift(player2Id);
      continue;
    }
    
    createMatch(player1Id, player2Id);
  }
}

wss.on('connection', (ws) => {
  let playerId = null;
  
  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data);
      
      switch(message.type) {
        case 'setId':
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
            const p = players.get(playerId);
            p.ws = ws;
            p.nick = message.nick || p.nick;
            p.cups = message.cups || p.cups;
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
          
          const unit = {
            id: message.unit.id,
            type: message.unit.type,
            x: message.x,
            y: message.y,
            hp: message.unit.hp,
            maxHp: message.unit.maxHp,
            dmg: message.unit.dmg,
            speed: message.unit.speed,
            size: message.unit.size || 10,
            color: message.unit.color || '#fff',
            icon: message.unit.icon || '?',
            attackSpeed: message.unit.attackSpeed || 1,
            attackTimer: 0,
            targets: message.unit.targets || 'all',
            owner: playerId
          };
          
          match.units.push(unit);
          broadcastGameState(match.id);
          break;
          
        case 'stateUpdate':
          if (!playerId) return;
          const currentPlayer = players.get(playerId);
          if (!currentPlayer || !currentPlayer.matchId) return;
          
          const currentMatch = matches.get(currentPlayer.matchId);
          if (!currentMatch) return;
          
          const isPlayer1 = currentMatch.player1 === playerId;
          
          // Обновляем юниты игрока на сервере
          if (message.units) {
            // Удаляем старые юниты этого игрока
            currentMatch.units = currentMatch.units.filter(u => u.owner !== playerId);
            // Добавляем обновленные
            currentMatch.units.push(...message.units.map(u => ({
              id: u.id,
              type: u.type,
              x: u.x,
              y: u.y,
              hp: u.hp,
              maxHp: u.maxHp,
              dmg: u.dmg,
              speed: u.speed,
              size: u.size || 10,
              color: u.color || '#fff',
              icon: u.icon || '?',
              attackSpeed: u.attackSpeed || 1,
              attackTimer: u.attackTimer || 0,
              targets: u.targets || 'all',
              owner: playerId
            })));
          }
          
          // Обновляем ТОЛЬКО HP башен
          if (message.towers && message.towers.player) {
            const towersHP = message.towers.player.map(t => t.hp);
            if (isPlayer1) {
              // Сохраняем HP, но не даем "восстановиться"
              for (let i = 0; i < 3; i++) {
                currentMatch.player1TowerHP[i] = Math.min(
                  currentMatch.player1TowerHP[i],
                  towersHP[i] || currentMatch.player1TowerHP[i]
                );
              }
            } else {
              for (let i = 0; i < 3; i++) {
                currentMatch.player2TowerHP[i] = Math.min(
                  currentMatch.player2TowerHP[i],
                  towersHP[i] || currentMatch.player2TowerHP[i]
                );
              }
            }
          }
          
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
              opponent.ws.send(JSON.stringify({ type: 'battleEnd', result: 'win' }));
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
