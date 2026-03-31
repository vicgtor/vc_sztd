const express = require('express');
const https = require('https');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const os = require('os');

const app = express();
const server = https.createServer({
  key: fs.readFileSync(path.join(__dirname, 'cert.key')),
  cert: fs.readFileSync(path.join(__dirname, 'cert.crt')),
}, app);
const io = new Server(server, {
  cors: { origin: '*' }
});

// Get LAN IP
function getLanIp() {
  const nets = os.networkInterfaces();
  for (const iface of Object.values(nets)) {
    for (const net of iface) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return 'localhost';
}

app.use(express.static(path.join(__dirname, 'public')));

// room -> { socketId -> { name, videoOn, audioOn } }
const rooms = new Map();

io.on('connection', (socket) => {
  console.log(`[+] Connected: ${socket.id}`);

  // Join a room
  socket.on('join-room', ({ roomId, userName }) => {
    socket.join(roomId);

    if (!rooms.has(roomId)) {
      rooms.set(roomId, new Map());
    }
    const room = rooms.get(roomId);
    room.set(socket.id, { name: userName, videoOn: true, audioOn: true });

    // Send the new user the list of existing participants
    const existingPeers = [];
    room.forEach((info, peerId) => {
      if (peerId !== socket.id) {
        existingPeers.push({ peerId, ...info });
      }
    });
    socket.emit('room-peers', existingPeers);

    // Notify others that a new user joined
    socket.to(roomId).emit('peer-joined', {
      peerId: socket.id,
      name: userName,
      videoOn: true,
      audioOn: true
    });

    socket.data.roomId = roomId;
    socket.data.userName = userName;

    console.log(`[R] ${userName} joined room ${roomId} (${room.size} peers)`);
  });

  // WebRTC signaling: offer
  socket.on('offer', ({ to, offer }) => {
    socket.to(to).emit('offer', { from: socket.id, offer });
  });

  // WebRTC signaling: answer
  socket.on('answer', ({ to, answer }) => {
    socket.to(to).emit('answer', { from: socket.id, answer });
  });

  // WebRTC signaling: ICE candidate
  socket.on('ice-candidate', ({ to, candidate }) => {
    socket.to(to).emit('ice-candidate', { from: socket.id, candidate });
  });

  // Media state change
  socket.on('media-state', ({ videoOn, audioOn }) => {
    const { roomId } = socket.data;
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (room && room.has(socket.id)) {
      const info = room.get(socket.id);
      info.videoOn = videoOn;
      info.audioOn = audioOn;
    }
    socket.to(roomId).emit('peer-media-state', {
      peerId: socket.id,
      videoOn,
      audioOn
    });
  });

  // Chat message
  socket.on('chat-message', ({ message }) => {
    const { roomId, userName } = socket.data;
    if (!roomId) return;
    const payload = {
      from: socket.id,
      name: userName,
      message,
      time: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    };
    io.to(roomId).emit('chat-message', payload);
  });

  // Disconnect
  socket.on('disconnect', () => {
    const { roomId, userName } = socket.data;
    if (roomId && rooms.has(roomId)) {
      const room = rooms.get(roomId);
      room.delete(socket.id);
      if (room.size === 0) {
        rooms.delete(roomId);
      }
      socket.to(roomId).emit('peer-left', { peerId: socket.id });
      console.log(`[-] ${userName} left room ${roomId}`);
    }
    console.log(`[-] Disconnected: ${socket.id}`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  const lan = getLanIp();
  console.log(`\n🚀 Video conference server (HTTPS) running at:`);
  console.log(`   Local : https://localhost:${PORT}`);
  console.log(`   LAN   : https://${lan}:${PORT}`);
  console.log(`\n⚠️  First visit: browser will warn about self-signed cert.`);
  console.log(`   Click "Advanced" → "Proceed" to continue.\n`);
});
