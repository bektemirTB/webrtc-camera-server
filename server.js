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
// connections: { socketId: { roomId, role, paired, originalId } }

const activeCodes = {}; // Временные коды (5 минут)
const pairs = {}; // Постоянные пары (по оригинальным ID, не socket ID)
const connections = {}; // Текущие подключения
const socketToOriginalId = {}; // Маппинг socket.id → original ID

const CODE_LIFETIME = 5 * 60 * 1000; // 5 минут

io.on("connection", (socket) => {
  console.log("🔌 Подключился:", socket.id);

  // Регистрация с оригинальным ID (из localStorage)
  socket.on("register", ({ originalId, role }) => {
    socketToOriginalId[socket.id] = originalId;
    connections[socket.id] = { originalId, role };
    console.log(`📝 Зарегистрирован: ${socket.id} с original ID: ${originalId}, роль: ${role}`);
  });

  // Генерация кода для камеры
  socket.on("generate-code", ({ originalId }) => {
    // Проверяем, есть ли у этой камеры уже пара
    if (pairs[originalId]) {
      socket.emit("error", "У вас уже есть активная пара. Разорвите её для создания новой.");
      console.log(`❌ ${originalId} пытается создать код, но уже в паре`);
      return;
    }

    // Генерируем уникальный 4-значный код
    let code;
    do {
      code = Math.floor(1000 + Math.random() * 9000).toString();
    } while (activeCodes[code]);

    // Сохраняем код на 5 минут
    activeCodes[code] = {
      cameraOriginalId: originalId,
      cameraSocketId: socket.id,
      expiresAt: Date.now() + CODE_LIFETIME,
      viewerOriginalId: null
    };

    socket.emit("code-generated", { 
      code, 
      expiresAt: activeCodes[code].expiresAt 
    });
    
    console.log(`🔑 Код ${code} создан для камеры ${originalId}, истекает через 5 минут`);

    // Автоматическое удаление через 5 минут
    setTimeout(() => {
      if (activeCodes[code] && !activeCodes[code].viewerOriginalId) {
        delete activeCodes[code];
        socket.emit("code-expired");
        console.log(`⏰ Код ${code} истек`);
      }
    }, CODE_LIFETIME);
  });

  // Подключение зрителя по коду
  socket.on("connect-with-code", ({ code, originalId }) => {
    console.log(`👁 Зритель ${originalId} пытается подключиться с кодом ${code}`);

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
    if (codeData.viewerOriginalId) {
      socket.emit("error", "Этот код уже используется");
      console.log(`❌ Код ${code} уже используется`);
      return;
    }

    // Проверяем, нет ли у зрителя уже пары
    if (pairs[originalId]) {
      socket.emit("error", "У вас уже есть активная пара. Разорвите её для создания новой.");
      console.log(`❌ Зритель ${originalId} уже в паре`);
      return;
    }

    // Создаем постоянную пару (используем оригинальные ID)
    const cameraOriginalId = codeData.cameraOriginalId;
    pairs[cameraOriginalId] = originalId;
    pairs[originalId] = cameraOriginalId;

    // Удаляем использованный код
    codeData.viewerOriginalId = originalId;
    delete activeCodes[code];

    // Создаем уникальную комнату для пары
    const roomId = `pair_${cameraOriginalId}`;
    socket.join(roomId);

    // Уведомляем зрителя
    socket.emit("paired", { 
      pairedWith: cameraOriginalId, 
      roomId,
      role: "viewer",
      cameraOnline: !!codeData.cameraSocketId // Проверяем онлайн ли камера
    });

    // Уведомляем камеру (если она онлайн)
    if (codeData.cameraSocketId) {
      io.to(codeData.cameraSocketId).emit("paired", { 
        pairedWith: originalId, 
        roomId,
        role: "camera"
      });
      
      // Сообщаем зрителю что камера онлайн
      socket.emit("camera-online");
      console.log(`📹 Камера ${cameraOriginalId} онлайн, зритель ${originalId} уведомлен`);
    } else {
      console.log(`📴 Камера ${cameraOriginalId} офлайн`);
    }

    console.log(`✅ Пара создана: камера ${cameraOriginalId} ↔ зритель ${originalId}`);
    console.log(`📊 Всего пар: ${Object.keys(pairs).length / 2}`);
  });

  // Восстановление соединения для существующей пары
  socket.on("restore-connection", ({ originalId, role }) => {
    console.log(`🔄 ${originalId} (${role}) восстанавливает соединение`);

    // Проверяем существование пары
    const pairedWith = pairs[originalId];
    if (!pairedWith) {
      socket.emit("error", "Пара не найдена. Создайте новую пару.");
      console.log(`❌ Пара не найдена для ${originalId}`);
      return;
    }

    // Проверяем взаимность
    if (pairs[pairedWith] !== originalId) {
      socket.emit("error", "Пара повреждена. Разорвите её и создайте новую.");
      console.log(`❌ Пара повреждена для ${originalId}`);
      return;
    }

    const roomId = `pair_${role === "camera" ? originalId : pairedWith}`;
    socket.join(roomId);

    connections[socket.id] = { originalId, role, pairedWith };

    socket.emit("connection-restored", { 
      pairedWith, 
      roomId,
      role 
    });

    // Находим socket ID партнера
    const partnerSocketId = Object.keys(connections).find(
      sid => connections[sid].originalId === pairedWith
    );

    if (partnerSocketId) {
      // Партнер онлайн - уведомляем обоих
      if (role === "viewer") {
        // Зритель подключился
        io.to(partnerSocketId).emit("viewer-online", originalId);
        socket.emit("camera-online");
        console.log(`✅ Зритель ${originalId} подключился, камера ${pairedWith} уведомлена`);
      } else {
        // Камера подключилась
        io.to(partnerSocketId).emit("camera-online", originalId);
        socket.emit("viewer-online");
        console.log(`✅ Камера ${originalId} подключилась, зритель ${pairedWith} уведомлен`);
      }
      
      console.log(`✅ Оба в паре онлайн: ${originalId} ↔ ${pairedWith}`);
    } else {
      // Партнер офлайн
      if (role === "viewer") {
        socket.emit("camera-offline");
        console.log(`📴 Камера ${pairedWith} офлайн`);
      } else {
        socket.emit("viewer-offline");
        console.log(`📴 Зритель ${pairedWith} офлайн`);
      }
    }

    console.log(`✅ Соединение восстановлено: ${originalId} (${role}) ↔ ${pairedWith}`);
  });

  // Разрыв пары
  socket.on("break-pair", ({ originalId }) => {
    const pairedWith = pairs[originalId];
    
    if (!pairedWith) {
      socket.emit("error", "У вас нет активной пары");
      return;
    }

    console.log(`💔 Разрыв пары: ${originalId} ↔ ${pairedWith}`);

    // Удаляем пару
    delete pairs[originalId];
    delete pairs[pairedWith];

    // Находим socket ID партнера
    const partnerSocketId = Object.keys(connections).find(
      sid => connections[sid].originalId === pairedWith
    );

    // Уведомляем обоих
    socket.emit("pair-broken");
    if (partnerSocketId) {
      io.to(partnerSocketId).emit("pair-broken");
    }

    console.log(`✅ Пара разорвана`);
    console.log(`📊 Осталось пар: ${Object.keys(pairs).length / 2}`);
  });

  // WebRTC сигналинг (только для пар)
  socket.on("offer", ({ offer, originalId }) => {
    const conn = connections[socket.id];
    if (!conn) return;

    const pairedWith = pairs[conn.originalId];
    if (!pairedWith) {
      socket.emit("error", "Нет активной пары");
      return;
    }

    // Находим socket ID партнера
    const partnerSocketId = Object.keys(connections).find(
      sid => connections[sid].originalId === pairedWith
    );

    if (partnerSocketId) {
      console.log(`📥 Offer от ${conn.originalId} для ${pairedWith}`);
      io.to(partnerSocketId).emit("offer", { offer, from: conn.originalId });
    }
  });

  socket.on("answer", ({ answer, originalId }) => {
    const conn = connections[socket.id];
    if (!conn) return;

    const pairedWith = pairs[conn.originalId];
    if (!pairedWith) return;

    const partnerSocketId = Object.keys(connections).find(
      sid => connections[sid].originalId === pairedWith
    );

    if (partnerSocketId) {
      console.log(`📥 Answer от ${conn.originalId} для ${pairedWith}`);
      io.to(partnerSocketId).emit("answer", { answer, from: conn.originalId });
    }
  });

  socket.on("ice-candidate", ({ candidate, originalId }) => {
    const conn = connections[socket.id];
    if (!conn) return;

    const pairedWith = pairs[conn.originalId];
    if (!pairedWith) return;

    const partnerSocketId = Object.keys(connections).find(
      sid => connections[sid].originalId === pairedWith
    );

    if (partnerSocketId) {
      io.to(partnerSocketId).emit("ice-candidate", { candidate, from: conn.originalId });
    }
  });

  // Отключение
  socket.on("disconnect", () => {
    console.log("❌ Отключился:", socket.id);

    const conn = connections[socket.id];
    if (conn && conn.originalId) {
      const pairedWith = pairs[conn.originalId];
      
      if (pairedWith) {
        // Находим socket ID партнера
        const partnerSocketId = Object.keys(connections).find(
          sid => connections[sid].originalId === pairedWith
        );

        if (partnerSocketId) {
          if (conn.role === "camera") {
            io.to(partnerSocketId).emit("camera-offline");
          } else {
            io.to(partnerSocketId).emit("viewer-offline");
          }
          console.log(`📴 ${conn.originalId} офлайн, партнер ${pairedWith} уведомлен`);
        }
      }
    }

    delete socketToOriginalId[socket.id];
    delete connections[socket.id];

    // Удаляем неиспользованные коды этого сокета
    Object.keys(activeCodes).forEach(code => {
      if (activeCodes[code].cameraSocketId === socket.id && !activeCodes[code].viewerOriginalId) {
        delete activeCodes[code];
        console.log(`🗑 Удален неиспользованный код ${code}`);
      }
    });
  });
});

// Очистка истекших кодов каждую минуту
setInterval(() => {
  const now = Date.now();
  Object.keys(activeCodes).forEach(code => {
    if (now > activeCodes[code].expiresAt && !activeCodes[code].viewerOriginalId) {
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