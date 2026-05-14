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
const matches = new Map();

function generateId() {
  return Math.random().toString(36).substr(2, 9);
}

function findOpponent(seekerId) {
  const seeker = players.get(seekerId);
  if (!seeker || seeker.status !== 'searching') return null;
  
  for (let [id, player] of players) {
    if (id !== seekerId && 
        player.status === 'searching' &&
        player.ws.readyState === WebSocket.OPEN) {
      return player;
    }
  }
  return null;
}

function createMatch(player1Id, player2Id) {
  const matchId = generateId();
  const player1 = players.get(player1Id);
  const player2 = players.get(player2Id);
  
  if (!player1 || !player2) return null;
  
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
  
  if (player1.ws.readyState === WebSocket.OPEN) {
    player1.ws.send(JSON.stringify({
      type: 'matchFound',
      opponent: player2Id,
      opponentNick: player2.nick,
      opponentCups: player2.cups,
      matchId: matchId
    }));
  }
  
  if (player2.ws.readyState === WebSocket.OPEN) {
    player2.ws.send(JSON.stringify({
      type: 'matchFound',
      opponent: player1Id,
      opponentNick: player1.nick,
      opponentCups: player1.cups,
      matchId: matchId
    }));
  }
  
  return match;
}

function broadcastGameState(matchId) {
  const match = matches.get(matchId);
  if (!match) return;
  
  const player1 = players.get(match.player1);
  const player2 = players.get(match.player2);
  
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
            const player = players.get(playerId);
            player.ws = ws;
            player.nick = message.nick || player.nick;
            player.cups = message.cups || player.cups;
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
          
          const opponent = findOpponent(playerId);
          if (opponent) {
            createMatch(playerId, opponent.ws._playerId);
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
          
        case 'stateUpdate':
          if (!playerId) return;
          const currentPlayer = players.get(playerId);
          if (!currentPlayer || !currentPlayer.matchId) return;
          
          const currentMatch = matches.get(currentPlayer.matchId);
          if (!currentMatch) return;
          
          const playerIsPlayer1 = currentMatch.player1 === playerId;
          
          if (message.units) {
            currentMatch.gameState.units = currentMatch.gameState.units.filter(u => 
              u.owner !== (playerIsPlayer1 ? 'player1' : 'player2')
            );
            currentMatch.gameState.units.push(...message.units.map(u => ({
              ...u,
              owner: playerIsPlayer1 ? 'player1' : 'player2'
            })));
          }
          
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
          
          if (p1) { p1.status = 'idle'; p1.opponentId = null; p1.matchId = null; }
          if (p2) { p2.status = 'idle'; p2.opponentId = null; p2.matchId = null; }
          
          matches.delete(endMatch.id);
          break;
      }
    } catch (error) {
      console.error('Ошибка обработки сообщения:', error);
    }
  });
  
  ws.on('close', () => {
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
          if (p && p.status === 'disconnected') players.delete(playerId);
        }, 30000);
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`👑 Сервер запущен на порту ${PORT}`);
});
