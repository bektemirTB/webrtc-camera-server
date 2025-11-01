const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

app.use(express.static("public"));

// Структура:
// activeCodes: { "1234": { cameraId, expiresAt, viewerId: null } }
// pairs: { cameraId: viewerId, viewerId: cameraId }
// connections: { socketId: { roomId, role, paired } }

const activeCodes = {}; // Временные коды (5 минут)
const pairs = {}; // Постоянные пары
const connections = {}; // Текущие подключения

const CODE_LIFETIME = 5 * 60 * 1000; // 5 минут

io.on("connection", (socket) => {
  console.log("🔌 Подключился:", socket.id);

  // Генерация кода для камеры
  socket.on("generate-code", () => {
    // Проверяем, есть ли у этой камеры уже пара
    const existingPair = Object.keys(pairs).find(key => 
      pairs[key] === socket.id || key === socket.id
    );
    
    if (existingPair) {
      socket.emit("error", "У вас уже есть активная пара. Разорвите её для создания новой.");
      console.log(`❌ ${socket.id} пытается создать код, но уже в паре`);
      return;
    }

    // Генерируем уникальный 4-значный код
    let code;
    do {
      code = Math.floor(1000 + Math.random() * 9000).toString();
    } while (activeCodes[code]);

    // Сохраняем код на 5 минут
    activeCodes[code] = {
      cameraId: socket.id,
      expiresAt: Date.now() + CODE_LIFETIME,
      viewerId: null
    };

    socket.emit("code-generated", { 
      code, 
      expiresAt: activeCodes[code].expiresAt 
    });
    
    console.log(`🔑 Код ${code} создан для камеры ${socket.id}, истекает через 5 минут`);

    // Автоматическое удаление через 5 минут
    setTimeout(() => {
      if (activeCodes[code] && !activeCodes[code].viewerId) {
        delete activeCodes[code];
        socket.emit("code-expired");
        console.log(`⏰ Код ${code} истек`);
      }
    }, CODE_LIFETIME);
  });

  // Подключение зрителя по коду
  socket.on("connect-with-code", ({ code }) => {
    console.log(`👁 Зритель ${socket.id} пытается подключиться с кодом ${code}`);

    // Проверяем существование кода
    if (!activeCodes[code]) {
      socket.emit("error", "Неверный код или срок действия истек");
      console.log(`❌ Код ${code} не найден`);
      return;
    }

    const codeData = activeCodes[code];

    // Проверяем не истек ли код
    if (Date.now() > codeData.expiresAt) {
      delete activeCodes[code];
      socket.emit("error", "Срок действия кода истек");
      console.log(`❌ Код ${code} истек`);
      return;
    }

    // Проверяем, не используется ли код уже
    if (codeData.viewerId) {
      socket.emit("error", "Этот код уже используется");
      console.log(`❌ Код ${code} уже используется`);
      return;
    }

    // Проверяем, нет ли у зрителя уже пары
    if (pairs[socket.id]) {
      socket.emit("error", "У вас уже есть активная пара. Разорвите её для создания новой.");
      console.log(`❌ Зритель ${socket.id} уже в паре`);
      return;
    }

    // Создаем постоянную пару
    const cameraId = codeData.cameraId;
    pairs[cameraId] = socket.id;
    pairs[socket.id] = cameraId;

    // Удаляем использованный код
    codeData.viewerId = socket.id;
    delete activeCodes[code];

    // Сохраняем информацию о подключениях
    connections[socket.id] = { role: "viewer", pairedWith: cameraId };
    if (connections[cameraId]) {
      connections[cameraId].pairedWith = socket.id;
    }

    // Создаем уникальную комнату для пары
    const roomId = `pair_${cameraId}_${socket.id}`;
    socket.join(roomId);

    // Уведомляем обоих
    socket.emit("paired", { 
      pairedWith: cameraId, 
      roomId,
      role: "viewer" 
    });

    io.to(cameraId).emit("paired", { 
      pairedWith: socket.id, 
      roomId,
      role: "camera" 
    });

    console.log(`✅ Пара создана: камера ${cameraId} ↔ зритель ${socket.id}`);
    console.log(`📊 Всего пар: ${Object.keys(pairs).length / 2}`);
  });

  // Восстановление соединения для существующей пары
  socket.on("restore-connection", ({ pairedWith }) => {
    console.log(`🔄 ${socket.id} восстанавливает соединение с ${pairedWith}`);

    // Проверяем существование пары
    if (pairs[socket.id] !== pairedWith || pairs[pairedWith] !== socket.id) {
      socket.emit("error", "Пара не найдена. Создайте новую пару.");
      console.log(`❌ Пара не найдена для ${socket.id}`);
      return;
    }

    // Определяем роль
    const isCameraInConnections = connections[pairedWith] && connections[pairedWith].role === "camera";
    const role = isCameraInConnections ? "viewer" : "camera";

    connections[socket.id] = { role, pairedWith };

    const roomId = role === "camera" ? 
      `pair_${socket.id}_${pairedWith}` : 
      `pair_${pairedWith}_${socket.id}`;
    
    socket.join(roomId);

    socket.emit("connection-restored", { 
      pairedWith, 
      roomId,
      role 
    });

    // Если партнер онлайн, уведомляем его
    io.to(pairedWith).emit("partner-online", socket.id);

    console.log(`✅ Соединение восстановлено: ${socket.id} (${role}) ↔ ${pairedWith}`);
  });

  // Разрыв пары
  socket.on("break-pair", () => {
    const pairedWith = pairs[socket.id];
    
    if (!pairedWith) {
      socket.emit("error", "У вас нет активной пары");
      return;
    }

    console.log(`💔 Разрыв пары: ${socket.id} ↔ ${pairedWith}`);

    // Удаляем пару
    delete pairs[socket.id];
    delete pairs[pairedWith];
    delete connections[socket.id];
    delete connections[pairedWith];

    // Уведомляем обоих
    socket.emit("pair-broken");
    io.to(pairedWith).emit("pair-broken");

    console.log(`✅ Пара разорвана`);
    console.log(`📊 Осталось пар: ${Object.keys(pairs).length / 2}`);
  });

  // WebRTC сигналинг (только для пар)
  socket.on("offer", ({ offer, target }) => {
    // Проверяем что это пара
    if (pairs[socket.id] !== target) {
      socket.emit("error", "Можно отправлять offer только своей паре");
      return;
    }

    console.log(`📥 Offer от ${socket.id} для ${target}`);
    io.to(target).emit("offer", { offer, target: socket.id });
  });

  socket.on("answer", ({ answer, target }) => {
    if (pairs[socket.id] !== target) {
      socket.emit("error", "Можно отправлять answer только своей паре");
      return;
    }

    console.log(`📥 Answer от ${socket.id} для ${target}`);
    io.to(target).emit("answer", { answer, target: socket.id });
  });

  socket.on("ice-candidate", ({ candidate, target }) => {
    if (pairs[socket.id] !== target) {
      return; // Молча игнорируем (ICE candidates могут приходить после разрыва)
    }

    io.to(target).emit("ice-candidate", { candidate, target: socket.id });
  });

  // Отключение
  socket.on("disconnect", () => {
    console.log("❌ Отключился:", socket.id);

    const pairedWith = pairs[socket.id];
    
    if (pairedWith) {
      // Не удаляем пару, просто уведомляем партнера об офлайне
      io.to(pairedWith).emit("partner-offline", socket.id);
      console.log(`📴 ${socket.id} офлайн, пара с ${pairedWith} сохранена`);
    }

    // Удаляем из connections, но не из pairs
    delete connections[socket.id];

    // Удаляем неиспользованные коды этой камеры
    Object.keys(activeCodes).forEach(code => {
      if (activeCodes[code].cameraId === socket.id && !activeCodes[code].viewerId) {
        delete activeCodes[code];
        console.log(`🗑 Удален неиспользованный код ${code}`);
      }
    });
  });

  // Проверка статуса пары
  socket.on("check-pair-status", () => {
    const pairedWith = pairs[socket.id];
    
    if (pairedWith) {
      const partnerOnline = io.sockets.sockets.has(pairedWith);
      socket.emit("pair-status", { 
        hasPair: true, 
        pairedWith,
        partnerOnline 
      });
    } else {
      socket.emit("pair-status", { hasPair: false });
    }
  });
});

// Очистка истекших кодов каждую минуту
setInterval(() => {
  const now = Date.now();
  Object.keys(activeCodes).forEach(code => {
    if (now > activeCodes[code].expiresAt && !activeCodes[code].viewerId) {
      delete activeCodes[code];
      console.log(`🧹 Очищен истекший код ${code}`);
    }
  });
}, 60000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
  console.log(`📊 Система парного подключения активна`);
});