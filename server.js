const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

app.use(express.static("public"));

const rooms = {}; // { roomId: { camera: socketId, viewers: [socketId, ...] } }

io.on("connection", (socket) => {
  console.log("🔌 Подключился:", socket.id);

  socket.on("join-room", ({ roomId, role }) => {
    socket.join(roomId);
    console.log(`${role} вошёл в комнату: ${roomId}`);

    if (!rooms[roomId]) {
      rooms[roomId] = { camera: null, viewers: [] };
    }

    if (role === "camera") {
      rooms[roomId].camera = socket.id;
      io.to(roomId).emit("camera-ready");
    } else if (role === "viewer") {
      rooms[roomId].viewers.push(socket.id);
      if (rooms[roomId].camera) {
        io.to(rooms[roomId].camera).emit("viewer-ready", socket.id);
      }
    }
  });

  socket.on("offer", ({ roomId, offer, target }) => {
    if (target) {
      io.to(target).emit("offer", offer);
    } else {
      socket.to(roomId).emit("offer", offer);
    }
  });

  socket.on("answer", ({ roomId, answer, target }) => {
    if (target) {
      io.to(target).emit("answer", answer);
    } else {
      socket.to(roomId).emit("answer", answer);
    }
  });

  socket.on("ice-candidate", ({ roomId, candidate, target }) => {
    if (target) {
      io.to(target).emit("ice-candidate", candidate);
    } else {
      socket.to(roomId).emit("ice-candidate", candidate);
    }
  });

  socket.on("disconnect", () => {
  console.log("❌ Отключился:", socket.id);
  for (const roomId in rooms) {
    const room = rooms[roomId];
    if (room.camera === socket.id) {
      io.to(roomId).emit("camera-disconnected");
      delete rooms[roomId];
    } else {
      room.viewers = room.viewers.filter(v => v !== socket.id);
      if (room.viewers.length === 0 && room.camera) {
        io.to(room.camera).emit("camera-stop"); // 🚀 говорим камере выключиться
      }
    }
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Сервер запущен на порту ${PORT}`));
