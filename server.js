const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const port = process.env.PORT || 8080;

// Создаем HTTP сервер для раздачи HTML файла
const server = http.createServer((req, res) => {
    // Раздаем royale.html как главную страницу
    fs.readFile(path.join(__dirname, 'royale.html'), (err, data) => {
        if (err) {
            res.writeHead(500);
            return res.end('Ошибка загрузки royale.html');
        }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(data);
    });
});

const wss = new WebSocket.Server({ server });

let waitingPlayer = null;

wss.on('connection', (ws) => {
    console.log('Новое подключение');

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            switch (data.type) {
                case 'join':
                    handleJoin(ws, data);
                    break;
                case 'spawn':
                case 'emoji':
                    handleGameAction(ws, data);
                    break;
            }
        } catch (e) {
            console.error("Ошибка парсинга:", e);
        }
    });

    ws.on('close', () => {
        if (waitingPlayer === ws) waitingPlayer = null;
        handleDisconnect(ws);
    });
});

function handleJoin(ws, data) {
    ws.userData = { nick: data.nick, trophies: data.trophies };
    
    if (waitingPlayer && waitingPlayer !== ws) {
        const p1 = waitingPlayer;
        const p2 = ws;
        
        p1.opponent = p2;
        p2.opponent = p1;

        p1.send(JSON.stringify({
            type: 'start',
            role: 'p1',
            enemy: p2.userData
        }));

        p2.send(JSON.stringify({
            type: 'start',
            role: 'p2',
            enemy: p1.userData
        }));

        waitingPlayer = null;
        console.log(`Матч начался: ${p1.userData.nick} vs ${p2.userData.nick}`);
    } else {
        waitingPlayer = ws;
        console.log(`${data.nick} ждет оппонента...`);
    }
}

function handleGameAction(ws, data) {
    if (ws.opponent && ws.opponent.readyState === WebSocket.OPEN) {
        ws.opponent.send(JSON.stringify(data));
    }
}

function handleDisconnect(ws) {
    if (ws.opponent) {
        if (ws.opponent.readyState === WebSocket.OPEN) {
            ws.opponent.send(JSON.stringify({ type: 'enemy_disconnected' }));
        }
        ws.opponent.opponent = null;
    }
}

server.listen(port, () => {
    console.log(`Сервер запущен на порту ${port}`);
});
