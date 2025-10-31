const WebSocket = require('ws');
const https = require('https');
const fs = require('fs');

// Configuration
const PORT = process.env.PORT || 8080;
const HOST = '0.0.0.0';

// SSL Configuration (read your SSL cert files)
const sslOptions = {
  key: fs.readFileSync('./private.key'),
  cert: fs.readFileSync('./certificate.crt'),
  ca: fs.readFileSync('./ca_bundle.crt')
};

// Room storage: Map<roomCode, { p1: WebSocket, p2: WebSocket }>
const rooms = new Map();

// Player storage: Map<WebSocket, { roomCode: string, role: 'p1' | 'p2' }>
const players = new Map();

// Create HTTPS server
const server = https.createServer(sslOptions, (req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'healthy',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      activeRooms: rooms.size,
      activePlayers: players.size,
      connectedClients: wss.clients.size
    }));
  } else if (req.url === '/stats') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      rooms: rooms.size,
      players: players.size,
      connections: wss.clients.size,
      uptime: Math.floor(process.uptime()),
      memory: process.memoryUsage()
    }));
  } else {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('WeClash Secure Signaling Server\n\nEndpoints:\n/health\n/stats\n\nWebSocket: wss://216.250.115.243:8080');
  }
});

// Create secure WebSocket server
const wss = new WebSocket.Server({
  server,
  perMessageDeflate: false
});

console.log(`🚀 WeClash Signaling Server starting...`);
console.log(`📡 Host: ${HOST}`);
console.log(`🔌 Port: ${PORT}`);
console.log(`🌐 WebSocket URL: ws://${HOST}:${PORT}`);

wss.on('connection', (ws, req) => {
  const clientIP = req.socket.remoteAddress;
  console.log(`🔗 New connection from ${clientIP}`);

  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString());
      handleMessage(ws, message);
    } catch (error) {
      console.error('❌ Error parsing message:', error);
      sendError(ws, 'Invalid message format');
    }
  });

  ws.on('close', () => {
    handleDisconnection(ws);
    console.log(`🔌 Connection closed for ${clientIP}`);
  });

  ws.on('error', (error) => {
    console.error(`❌ WebSocket error for ${clientIP}:`, error);
    handleDisconnection(ws);
  });

  // Send welcome message
  send(ws, {
    type: 'connected',
    message: 'Welcome to WeClash signaling server'
  });
});

function handleMessage(ws, message) {
  console.log(`📨 Received message: ${message.type}`);

  switch (message.type) {
    case 'join':
      handleJoinRoom(ws, message);
      break;

    case 'rtc-offer':
      relayToOpponent(ws, message);
      break;

    case 'rtc-answer':
      relayToOpponent(ws, message);
      break;

    case 'rtc-ice':
      relayToOpponent(ws, message);
      break;

    case 'keypoints':
      relayToOpponent(ws, message);
      break;

    case 'hit':
      relayToOpponent(ws, message);
      break;

    case 'game-state':
      relayToOpponent(ws, message);
      break;

    default:
      console.warn(`⚠️ Unknown message type: ${message.type}`);
      sendError(ws, `Unknown message type: ${message.type}`);
  }
}

function handleJoinRoom(ws, message) {
  const { code } = message;

  if (!code || typeof code !== 'string' || code.length !== 6) {
    sendError(ws, 'Invalid room code');
    return;
  }

  // Remove player from any existing room first
  handleDisconnection(ws);

  let room = rooms.get(code);
  let playerRole;

  if (!room) {
    // Create new room - this player becomes p1
    room = { p1: ws, p2: null };
    rooms.set(code, room);
    playerRole = 'p1';
    players.set(ws, { roomCode: code, role: 'p1' });

    console.log(`🏠 Room ${code} created by p1`);

    send(ws, {
      type: 'room-created',
      code: code,
      role: 'p1'
    });

  } else if (!room.p2) {
    // Join existing room as p2
    room.p2 = ws;
    playerRole = 'p2';
    players.set(ws, { roomCode: code, role: 'p2' });

    console.log(`🤝 p2 joined room ${code}`);

    // Notify both players
    send(ws, {
      type: 'room-joined',
      code: code,
      role: 'p2'
    });

    send(room.p1, {
      type: 'peer-joined'
    });

    send(ws, {
      type: 'peer-joined'
    });

  } else {
    // Room is full
    sendError(ws, 'Room is full');
    return;
  }

  console.log(`✅ Player joined room ${code} as ${playerRole}`);
}

function relayToOpponent(ws, message) {
  const playerData = players.get(ws);

  if (!playerData) {
    sendError(ws, 'Not in a room');
    return;
  }

  const room = rooms.get(playerData.roomCode);
  if (!room) {
    sendError(ws, 'Room not found');
    return;
  }

  // Determine opponent
  const opponent = playerData.role === 'p1' ? room.p2 : room.p1;

  if (!opponent) {
    console.log(`⚠️ No opponent to relay message to in room ${playerData.roomCode}`);
    return;
  }

  // Check if opponent is still connected
  if (opponent.readyState !== WebSocket.OPEN) {
    console.log(`⚠️ Opponent disconnected in room ${playerData.roomCode}`);
    handleDisconnection(opponent);
    return;
  }

  // Relay the message
  send(opponent, message);

  // Log specific message types for debugging
  if (message.type === 'hit') {
    console.log(`💥 Hit relayed in room ${playerData.roomCode}: ${message.hit?.part} for ${message.hit?.damage} damage`);
  } else if (message.type === 'keypoints') {
    console.log(`🎯 Keypoints relayed in room ${playerData.roomCode}: ${message.keypoints?.length} points`);
  }
}

function handleDisconnection(ws) {
  const playerData = players.get(ws);

  if (!playerData) {
    return; // Player wasn't in a room
  }

  const { roomCode, role } = playerData;
  const room = rooms.get(roomCode);

  if (room) {
    // Notify opponent that peer left
    const opponent = role === 'p1' ? room.p2 : room.p1;

    if (opponent && opponent.readyState === WebSocket.OPEN) {
      send(opponent, {
        type: 'peer-left'
      });
      console.log(`📢 Notified opponent that ${role} left room ${roomCode}`);
    }

    // Remove the disconnected player from the room
    if (role === 'p1') {
      if (room.p2) {
        // p1 left, p2 becomes the new p1
        room.p1 = room.p2;
        room.p2 = null;
        players.set(room.p1, { roomCode, role: 'p1' });
        console.log(`🔄 p2 promoted to p1 in room ${roomCode}`);
      } else {
        // Room is now empty, delete it
        rooms.delete(roomCode);
        console.log(`🗑️ Room ${roomCode} deleted (empty)`);
      }
    } else {
      // p2 left
      room.p2 = null;
      console.log(`👋 p2 left room ${roomCode}`);
    }
  }

  // Remove player from tracking
  players.delete(ws);
  console.log(`🧹 Player ${role} removed from room ${roomCode}`);
}

function send(ws, message) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function sendError(ws, errorMessage) {
  send(ws, {
    type: 'error',
    message: errorMessage
  });
}

// Cleanup function for graceful shutdown
function cleanup() {
  console.log('🧹 Cleaning up server...');

  // Close all connections
  wss.clients.forEach((ws) => {
    ws.close();
  });

  // Clear all rooms and players
  rooms.clear();
  players.clear();

  console.log('✅ Cleanup complete');
}

// Graceful shutdown handlers
process.on('SIGINT', () => {
  console.log('\n🛑 Received SIGINT, shutting down gracefully...');
  cleanup();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n🛑 Received SIGTERM, shutting down gracefully...');
  cleanup();
  process.exit(0);
});

// Error handling
process.on('uncaughtException', (error) => {
  console.error('💥 Uncaught Exception:', error);
  cleanup();
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 Unhandled Rejection at:', promise, 'reason:', reason);
});

// Health check endpoint
server.on('request', (req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'healthy',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      activeRooms: rooms.size,
      activePlayers: players.size,
      connectedClients: wss.clients.size
    }));
  } else if (req.url === '/stats') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      rooms: rooms.size,
      players: players.size,
      connections: wss.clients.size,
      uptime: Math.floor(process.uptime()),
      memory: process.memoryUsage()
    }));
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('WeClash Signaling Server\n\nEndpoints:\n/health - Health check\n/stats - Server statistics\n\nWebSocket: ws://localhost:8080');
  }
});

// Start the server
server.listen(PORT, HOST, () => {
  console.log(`🎮 WeClash Signaling Server running!`);
  console.log(`📊 Health check: http://${HOST}:${PORT}/health`);
  console.log(`📈 Stats: http://${HOST}:${PORT}/stats`);
  console.log(`🔥 Ready for battles!\n`);
});

// Periodic cleanup of stale connections
setInterval(() => {
  let removedConnections = 0;

  wss.clients.forEach((ws) => {
    if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
      handleDisconnection(ws);
      removedConnections++;
    }
  });

  if (removedConnections > 0) {
    console.log(`🧹 Cleaned up ${removedConnections} stale connections`);
  }
}, 30000); // Every 30 seconds

// Log server stats periodically
setInterval(() => {
  console.log(`📊 Server Stats: ${rooms.size} rooms, ${players.size} players, ${wss.clients.size} connections`);
}, 300000); // Every 5 minutes
