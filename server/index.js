const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Serve root files first (so root `index.html` becomes the main entry), then fall back to `public/` assets
app.use(express.static(path.join(__dirname, '..')));
app.use(express.static(path.join(__dirname, '..', 'public')));

// Map of clientId -> ws
const peers = new Map();

function broadcastPeerList() {
  const list = Array.from(peers.keys());
  const msg = JSON.stringify({ type: 'peers', peers: list });
  for (const ws of peers.values()) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));

  ws.on('message', (raw) => {
    let data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      console.warn('Invalid message', e);
      return;
    }

    const { type } = data;

    if (type === 'register') {
      const { id } = data;
      if (!id) return;
      peers.set(id, ws);
      ws.clientId = id;
      broadcastPeerList();
      return;
    }

    if (type === 'signal') {
      const { to, from, payload } = data;
      const target = peers.get(to);
      if (target && target.readyState === WebSocket.OPEN) {
        target.send(JSON.stringify({ type: 'signal', from, payload }));
      }
      return;
    }

    if (type === 'list') {
      const list = Array.from(peers.keys());
      ws.send(JSON.stringify({ type: 'peers', peers: list }));
      return;
    }
  });

  ws.on('close', () => {
    if (ws.clientId) {
      peers.delete(ws.clientId);
      broadcastPeerList();
    }
  });
});

// heartbeat to clean dead sockets
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping(() => {});
  });
}, 30000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
});
