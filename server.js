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
    console.log(`✅ ${role} вошёл в комнату: ${roomId}, ID: ${socket.id}`);

    if (!rooms[roomId]) {
      rooms[roomId] = { camera: null, viewers: [] };
    }

    if (role === "camera") {
      rooms[roomId].camera = socket.id;
      console.log(`📹 Камера установлена для комнаты ${roomId}`);
      io.to(roomId).emit("camera-ready");
    } else if (role === "viewer") {
      rooms[roomId].viewers.push(socket.id);
      console.log(`👁 Зритель добавлен, всего зрителей: ${rooms[roomId].viewers.length}`);
      if (rooms[roomId].camera) {
        console.log(`📡 Отправляю viewer-ready камере ${rooms[roomId].camera}, зритель: ${socket.id}`);
        io.to(rooms[roomId].camera).emit("viewer-ready", socket.id);
      } else {
        console.log(`⚠️ Камера еще не подключена к комнате ${roomId}`);
      }
    }
  });

  // ИСПРАВЛЕНО: Передаем offer с правильной структурой
  socket.on("offer", ({ offer, target }) => {
    console.log(`📥 Получен offer от ${socket.id} для ${target}`);
    console.log(`📊 Offer type: ${offer?.type}, SDP length: ${offer?.sdp?.length}`);
    
    if (!offer) {
      console.error("❌ ОШИБКА: offer пустой!");
      return;
    }
    
    if (!target) {
      console.error("❌ ОШИБКА: target не указан!");
      return;
    }
    
    // КРИТИЧНО: отправляем объект с offer И target (sender - это ID камеры)
    io.to(target).emit("offer", { offer, target: socket.id });
    console.log(`✅ Offer переслан зрителю ${target} от камеры ${socket.id}`);
  });

  // ИСПРАВЛЕНО: Передаем answer с правильной структурой
  socket.on("answer", ({ answer, target }) => {
    console.log(`📥 Получен answer от ${socket.id} для ${target}`);
    console.log(`📊 Answer type: ${answer?.type}, SDP length: ${answer?.sdp?.length}`);
    
    if (!answer) {
      console.error("❌ ОШИБКА: answer пустой!");
      return;
    }
    
    if (!target) {
      console.error("❌ ОШИБКА: target не указан!");
      return;
    }
    
    // Отправляем объект с answer И target (sender - это ID зрителя)
    io.to(target).emit("answer", { answer, target: socket.id });
    console.log(`✅ Answer переслан камере ${target} от зрителя ${socket.id}`);
  });

  // ИСПРАВЛЕНО: Передаем ICE candidate с правильной структурой
  socket.on("ice-candidate", ({ candidate, target }) => {
    console.log(`📥 Получен ICE candidate от ${socket.id} для ${target}`);
    
    if (!candidate) {
      console.error("❌ ОШИБКА: candidate пустой!");
      return;
    }
    
    if (!target) {
      console.error("❌ ОШИБКА: target не указан!");
      return;
    }
    
    // Отправляем объект с candidate И target
    io.to(target).emit("ice-candidate", { candidate, target: socket.id });
    console.log(`✅ ICE candidate переслан ${target} от ${socket.id}`);
  });

  socket.on("disconnect", () => {
    console.log("❌ Отключился:", socket.id);
    
    for (const roomId in rooms) {
      const room = rooms[roomId];
      
      // Если отключилась камера
      if (room.camera === socket.id) {
        console.log(`📹 Камера отключилась от комнаты ${roomId}`);
        io.to(roomId).emit("camera-disconnected");
        
        // Удаляем комнату, если нет зрителей
        if (room.viewers.length === 0) {
          delete rooms[roomId];
          console.log(`🗑 Комната ${roomId} удалена (нет зрителей)`);
        } else {
          room.camera = null;
          console.log(`⏸ Комната ${roomId} ожидает новую камеру`);
        }
      } 
      // Если отключился зритель
      else {
        const viewerIndex = room.viewers.indexOf(socket.id);
        if (viewerIndex !== -1) {
          room.viewers.splice(viewerIndex, 1);
          console.log(`👁 Зритель отключился, осталось: ${room.viewers.length}`);
          
          // Если больше нет зрителей, говорим камере выключиться
          if (room.viewers.length === 0 && room.camera) {
            console.log(`🛑 Нет зрителей, отправляю camera-stop камере ${room.camera}`);
            io.to(room.camera).emit("camera-stop");
          }
        }
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Сервер запущен на порту ${PORT}`));