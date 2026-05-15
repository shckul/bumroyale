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

// Хранилища
const players = new Map();       // playerId -> { ws, nick, cups, status, opponentId, matchId }
const searchingPlayers = [];     // очередь поиска
const matches = new Map();       // matchId -> matchData

// Фиксированные позиции башен (как в клиенте)
const TOWER_POS_BOTTOM = [
  { x: 85, y: 710, w: 30, h: 30, type: 'side' },
  { x: 200, y: 740, w: 50, h: 45, type: 'main', isKing: true },
  { x: 335, y: 710, w: 30, h: 30, type: 'side' }
];

const TOWER_POS_TOP = [
  { x: 85, y: 110, w: 30, h: 30, type: 'side' },
  { x: 200, y: 60, w: 50, h: 45, type: 'main', isKing: true },
  { x: 335, y: 110, w: 30, h: 30, type: 'side' }
];

function generateId() {
  return Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
}

// ============ ПОИСК СОПЕРНИКА ============
function tryMatchPlayers() {
  while (searchingPlayers.length >= 2) {
    const p1Id = searchingPlayers.shift();
    const p2Id = searchingPlayers.shift();
    
    const p1 = players.get(p1Id);
    const p2 = players.get(p2Id);
    
    // Проверяем что оба онлайн и не играют
    if (!p1 || !p2 || p1.ws.readyState !== WebSocket.OPEN || p2.ws.readyState !== WebSocket.OPEN) {
      if (p1 && p1.ws.readyState === WebSocket.OPEN && p1.status === 'searching') searchingPlayers.unshift(p1Id);
      if (p2 && p2.ws.readyState === WebSocket.OPEN && p2.status === 'searching') searchingPlayers.unshift(p2Id);
      continue;
    }
    
    createMatch(p1Id, p2Id);
  }
}

// ============ СОЗДАНИЕ МАТЧА ============
function createMatch(player1Id, player2Id) {
  const matchId = generateId();
  const p1 = players.get(player1Id);
  const p2 = players.get(player2Id);
  
  if (!p1 || !p2) return;
  
  console.log(`🎮 Матч: ${p1.nick} (🏆${p1.cups}) vs ${p2.nick} (🏆${p2.cups})`);
  
  p1.status = 'playing';
  p2.status = 'playing';
  p1.opponentId = player2Id;
  p2.opponentId = player1Id;
  p1.matchId = matchId;
  p2.matchId = matchId;
  
  // Храним только HP башен (позиции фиксированы)
  const match = {
    id: matchId,
    player1: player1Id,
    player2: player2Id,
    player1TowerHP: [800, 1500, 800],
    player2TowerHP: [800, 1500, 800],
    units: [] // Храним юнитов с owner = playerId
  };
  
  matches.set(matchId, match);
  
  // Уведомляем игроков
  sendToPlayer(p1, {
    type: 'matchFound',
    opponent: player2Id,
    opponentNick: p2.nick,
    opponentCups: p2.cups
  });
  
  sendToPlayer(p2, {
    type: 'matchFound',
    opponent: player1Id,
    opponentNick: p1.nick,
    opponentCups: p1.cups
  });
  
  // Отправляем начальное состояние
  setTimeout(() => broadcastState(matchId), 200);
}

// ============ ОТПРАВКА СОСТОЯНИЯ ============
function sendToPlayer(player, data) {
  if (player && player.ws.readyState === WebSocket.OPEN) {
    player.ws.send(JSON.stringify(data));
  }
}

function sendGameState(playerId, match) {
  const player = players.get(playerId);
  if (!player) return;
  
  const isPlayer1 = match.player1 === playerId;
  
  // Мои башни (внизу)
  const myHP = isPlayer1 ? match.player1TowerHP : match.player2TowerHP;
  const myTowers = TOWER_POS_BOTTOM.map((pos, i) => ({
    ...pos,
    hp: Math.max(0, myHP[i]),
    maxHp: pos.type === 'main' ? 1500 : 800,
    owner: 'player',
    team: 0
  }));
  
  // Вражеские башни (вверху)
  const enemyHP = isPlayer1 ? match.player2TowerHP : match.player1TowerHP;
  const enemyTowers = TOWER_POS_TOP.map((pos, i) => ({
    ...pos,
    hp: Math.max(0, enemyHP[i]),
    maxHp: pos.type === 'main' ? 1500 : 800,
    owner: 'enemy',
    team: 1
  }));
  
  // Только вражеские юниты (своих клиент отслеживает сам)
  const enemyUnits = match.units
    .filter(u => u.owner !== playerId && u.hp > 0)
    .map(u => ({
      id: u.id,
      icon: u.icon,
      name: u.name,
      x: u.x,
      y: u.y,
      hp: u.hp,
      maxHp: u.maxHp,
      dmg: u.dmg,
      speed: u.speed,
      size: u.size || 14,
      attackSpeed: u.attackSpeed || 1,
      attackTimer: u.attackTimer || 0,
      targets: u.targets || 'all',
      owner: 'enemy',
      team: 1
    }));
  
  sendToPlayer(player, {
    type: 'gameState',
    enemyUnits: enemyUnits,
    towers: {
      player: myTowers,
      enemy: enemyTowers
    }
  });
}

function broadcastState(matchId) {
  const match = matches.get(matchId);
  if (!match) return;
  sendGameState(match.player1, match);
  sendGameState(match.player2, match);
}

// ============ WEBSOCKET ============
wss.on('connection', (ws) => {
  let playerId = null;
  
  console.log('🔌 Новое подключение');
  
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      
      switch (msg.type) {
        
        case 'setId':
          playerId = msg.id;
          if (!players.has(playerId)) {
            players.set(playerId, {
              ws: ws,
              nick: msg.nick || 'Игрок',
              cups: msg.cups || 0,
              status: 'idle',
              opponentId: null,
              matchId: null
            });
            console.log(`👤 Новый: ${msg.nick} (${playerId})`);
          } else {
            const p = players.get(playerId);
            p.ws = ws;
            p.nick = msg.nick || p.nick;
            p.cups = msg.cups || p.cups;
            // Если был в поиске - убираем
            const idx = searchingPlayers.indexOf(playerId);
            if (idx > -1) searchingPlayers.splice(idx, 1);
            p.status = 'idle';
            console.log(`🔄 Переподключился: ${p.nick}`);
          }
          sendToPlayer(players.get(playerId), { type: 'idAssigned', id: playerId });
          break;
          
        case 'findMatch':
          if (!playerId) return;
          const seeker = players.get(playerId);
          if (!seeker) return;
          
          seeker.nick = msg.nick || seeker.nick;
          seeker.cups = msg.cups || seeker.cups;
          seeker.status = 'searching';
          
          if (!searchingPlayers.includes(playerId)) {
            searchingPlayers.push(playerId);
            console.log(`🔍 ${seeker.nick} в поиске (очередь: ${searchingPlayers.length})`);
          }
          
          sendToPlayer(seeker, { type: 'searching' });
          tryMatchPlayers();
          break;
          
        case 'placeUnit':
          if (!playerId) return;
          const placer = players.get(playerId);
          if (!placer || !placer.matchId) return;
          
          const match = matches.get(placer.matchId);
          if (!match) return;
          
          // Добавляем юнит на сервер
          const unit = {
            id: msg.unit.id || generateId(),
            icon: msg.unit.icon || '?',
            name: msg.unit.name || 'Unit',
            x: msg.x,
            y: msg.y,
            hp: msg.unit.hp,
            maxHp: msg.unit.maxHp,
            dmg: msg.unit.dmg,
            speed: msg.unit.speed,
            size: msg.unit.size || 14,
            attackSpeed: msg.unit.attackSpeed || 1,
            attackTimer: 0,
            targets: msg.unit.targets || 'all',
            owner: playerId
          };
          
          match.units.push(unit);
          broadcastState(match.id);
          break;
          
        case 'stateUpdate':
          if (!playerId) return;
          const updater = players.get(playerId);
          if (!updater || !updater.matchId) return;
          
          const updMatch = matches.get(updater.matchId);
          if (!updMatch) return;
          
          const isPlayer1 = updMatch.player1 === playerId;
          
          // Обновляем юниты этого игрока
          if (msg.units) {
            updMatch.units = updMatch.units.filter(u => u.owner !== playerId);
            updMatch.units.push(...msg.units.map(u => ({
              id: u.id,
              icon: u.icon || '?',
              name: u.name || 'Unit',
              x: u.x,
              y: u.y,
              hp: u.hp,
              maxHp: u.maxHp,
              dmg: u.dmg,
              speed: u.speed,
              size: u.size || 14,
              attackSpeed: u.attackSpeed || 1,
              attackTimer: u.attackTimer || 0,
              targets: u.targets || 'all',
              owner: playerId
            })));
          }
          
          // Обновляем HP башен (только уменьшаем, не увеличиваем)
          if (msg.towers && msg.towers.player) {
            const newHP = msg.towers.player.map(t => t.hp);
            const currentHP = isPlayer1 ? updMatch.player1TowerHP : updMatch.player2TowerHP;
            
            // Берём минимальное значение чтобы HP только уменьшалось
            const updatedHP = currentHP.map((hp, i) => Math.min(hp, newHP[i] || hp));
            
            if (isPlayer1) {
              updMatch.player1TowerHP = updatedHP;
            } else {
              updMatch.player2TowerHP = updatedHP;
            }
          }
          
          broadcastState(updMatch.id);
          break;
          
        case 'emoji':
          if (!playerId) return;
          const emojiSender = players.get(playerId);
          if (!emojiSender || !emojiSender.opponentId) return;
          
          const opponent = players.get(emojiSender.opponentId);
          if (opponent && opponent.ws.readyState === WebSocket.OPEN) {
            opponent.ws.send(JSON.stringify({
              type: 'emoji',
              emoji: msg.emoji,
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
          
          console.log(`🏁 Матч завершён: ${msg.result}`);
          
          // Определяем результат для каждого игрока
          let r1, r2;
          if (msg.result === 'win') {
            r1 = endMatch.player1 === playerId ? 'win' : 'lose';
            r2 = endMatch.player2 === playerId ? 'win' : 'lose';
          } else if (msg.result === 'lose') {
            r1 = endMatch.player1 === playerId ? 'lose' : 'win';
            r2 = endMatch.player2 === playerId ? 'lose' : 'win';
          } else {
            r1 = 'draw';
            r2 = 'draw';
          }
          
          sendToPlayer(p1, { type: 'battleEnd', result: r1 });
          sendToPlayer(p2, { type: 'battleEnd', result: r2 });
          
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
    } catch (e) {
      console.error('❌ Ошибка обработки:', e.message);
    }
  });
  
  // Отключение
  ws.on('close', () => {
    console.log(`🔌 Отключился: ${playerId}`);
    
    if (playerId) {
      // Убираем из очереди поиска
      const idx = searchingPlayers.indexOf(playerId);
      if (idx > -1) searchingPlayers.splice(idx, 1);
      
      const player = players.get(playerId);
      if (player && player.matchId) {
        // Уведомляем соперника о победе
        const match = matches.get(player.matchId);
        if (match) {
          const opponentId = match.player1 === playerId ? match.player2 : match.player1;
          const opponent = players.get(opponentId);
          if (opponent && opponent.ws.readyState === WebSocket.OPEN) {
            sendToPlayer(opponent, { type: 'battleEnd', result: 'win' });
          }
          matches.delete(player.matchId);
        }
      }
      
      if (player) {
        player.status = 'disconnected';
        setTimeout(() => {
          const p = players.get(playerId);
          if (p && p.status === 'disconnected') players.delete(playerId);
        }, 30000);
      }
    }
  });
});

// Лог каждые 30 секунд
setInterval(() => {
  console.log(`📊 Игроков: ${players.size} | В поиске: ${searchingPlayers.length} | Матчей: ${matches.size}`);
}, 30000);

server.listen(PORT, () => {
  console.log(`👑 Сервер Clash Royale запущен на порту ${PORT}`);
});
