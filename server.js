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
// activeCodes: { "1234": { cameraDeviceId, expiresAt, viewerId: null } }
// pairs: { cameraDeviceId: viewerDeviceId, viewerDeviceId: cameraDeviceId }
// deviceSockets: { deviceId: socketId } - текущие подключения
// connections: { socketId: { deviceId, role, pairedWith } }

const activeCodes = {}; // Временные коды (5 минут)
const pairs = {}; // Постоянные пары по deviceId
const deviceSockets = {}; // Привязка deviceId к socket.id
const connections = {}; // Текущие подключения

const CODE_LIFETIME = 5 * 60 * 1000; // 5 минут

io.on("connection", (socket) => {
  console.log("🔌 Подключился:", socket.id);

  // Регистрация устройства с постоянным deviceId
  socket.on("register-device", ({ deviceId, role }) => {
    console.log(`📱 Регистрация устройства: ${deviceId} (${role})`);
    
    // Удаляем старое подключение этого устройства
    if (deviceSockets[deviceId]) {
      const oldSocketId = deviceSockets[deviceId];
      delete connections[oldSocketId];
    }
    
    deviceSockets[deviceId] = socket.id;
    connections[socket.id] = { deviceId, role, pairedWith: null };
    
    // Проверяем существующую пару
    const pairedDeviceId = pairs[deviceId];
    if (pairedDeviceId) {
      const pairedSocketId = deviceSockets[pairedDeviceId];
      const partnerOnline = !!pairedSocketId;
      
      connections[socket.id].pairedWith = pairedDeviceId;
      
      socket.emit("pair-exists", {
        pairedWith: pairedDeviceId,
        partnerOnline,
        role
      });
      
      // Если партнер онлайн, уведомляем его
      if (partnerOnline) {
        io.to(pairedSocketId).emit("partner-online", deviceId);
        console.log(`✅ Устройство ${deviceId} переподключилось, партнер ${pairedDeviceId} онлайн`);
      } else {
        console.log(`⚠️ Устройство ${deviceId} имеет пару с ${pairedDeviceId}, но партнер офлайн`);
      }
    } else {
      socket.emit("no-pair");
      console.log(`ℹ️ Устройство ${deviceId} без пары`);
    }
  });

  // Генерация кода для камеры
  socket.on("generate-code", ({ deviceId }) => {
    console.log(`🔑 Запрос кода от камеры ${deviceId}`);
    
    // Проверяем, есть ли у этой камеры уже пара
    if (pairs[deviceId]) {
      socket.emit("error", "У вас уже есть активная пара. Разорвите её для создания новой.");
      console.log(`❌ ${deviceId} пытается создать код, но уже в паре`);
      return;
    }

    // Генерируем уникальный 4-значный код
    let code;
    do {
      code = Math.floor(1000 + Math.random() * 9000).toString();
    } while (activeCodes[code]);

    // Сохраняем код на 5 минут
    activeCodes[code] = {
      cameraDeviceId: deviceId,
      cameraSocketId: socket.id,
      expiresAt: Date.now() + CODE_LIFETIME,
      viewerId: null
    };

    socket.emit("code-generated", {
      code,
      expiresAt: activeCodes[code].expiresAt
    });

    console.log(`🔑 Код ${code} создан для камеры ${deviceId}, истекает через 5 минут`);

    // Автоматическое удаление через 5 минут
    setTimeout(() => {
      if (activeCodes[code] && !activeCodes[code].viewerId) {
        delete activeCodes[code];
        const cameraSocket = deviceSockets[deviceId];
        if (cameraSocket) {
          io.to(cameraSocket).emit("code-expired");
        }
        console.log(`⏰ Код ${code} истек`);
      }
    }, CODE_LIFETIME);
  });

  // Подключение зрителя по коду
  socket.on("connect-with-code", ({ code, deviceId }) => {
    console.log(`👁 Зритель ${deviceId} пытается подключиться с кодом ${code}`);

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
    if (pairs[deviceId]) {
      socket.emit("error", "У вас уже есть активная пара. Разорвите её для создания новой.");
      console.log(`❌ Зритель ${deviceId} уже в паре`);
      return;
    }

    // Создаем постоянную пару по deviceId
    const cameraDeviceId = codeData.cameraDeviceId;
    pairs[cameraDeviceId] = deviceId;
    pairs[deviceId] = cameraDeviceId;

    // Удаляем использованный код
    codeData.viewerId = deviceId;
    delete activeCodes[code];

    // Сохраняем информацию о паре
    if (connections[socket.id]) {
      connections[socket.id].pairedWith = cameraDeviceId;
    }
    
    const cameraSocketId = deviceSockets[cameraDeviceId];
    if (cameraSocketId && connections[cameraSocketId]) {
      connections[cameraSocketId].pairedWith = deviceId;
    }

    // Уведомляем обоих
    socket.emit("paired", {
      pairedWith: cameraDeviceId,
      role: "viewer"
    });

    if (cameraSocketId) {
      io.to(cameraSocketId).emit("paired", {
        pairedWith: deviceId,
        role: "camera"
      });
      
      // Сразу запрашиваем запуск камеры
      io.to(cameraSocketId).emit("start-camera-request");
    }

    console.log(`✅ Пара создана: камера ${cameraDeviceId} ↔ зритель ${deviceId}`);
    console.log(`📊 Всего пар: ${Object.keys(pairs).length / 2}`);
  });

  // Разрыв пары
  socket.on("break-pair", ({ deviceId }) => {
    const pairedDeviceId = pairs[deviceId];
    if (!pairedDeviceId) {
      socket.emit("error", "У вас нет активной пары");
      return;
    }

    console.log(`💔 Разрыв пары: ${deviceId} ↔ ${pairedDeviceId}`);

    // Удаляем пару
    delete pairs[deviceId];
    delete pairs[pairedDeviceId];

    // Обновляем connections
    if (connections[socket.id]) {
      connections[socket.id].pairedWith = null;
    }
    
    const pairedSocketId = deviceSockets[pairedDeviceId];
    if (pairedSocketId && connections[pairedSocketId]) {
      connections[pairedSocketId].pairedWith = null;
    }

    // Уведомляем обоих
    socket.emit("pair-broken");
    if (pairedSocketId) {
      io.to(pairedSocketId).emit("pair-broken");
    }

    console.log(`✅ Пара разорвана`);
    console.log(`📊 Осталось пар: ${Object.keys(pairs).length / 2}`);
  });

  // Зритель ушел - останавливаем камеру
  socket.on("viewer-leave", ({ deviceId }) => {
    const pairedDeviceId = pairs[deviceId];
    if (pairedDeviceId) {
      const cameraSocketId = deviceSockets[pairedDeviceId];
      if (cameraSocketId) {
        io.to(cameraSocketId).emit("stop-camera-request");
        console.log(`⏸ Зритель ${deviceId} ушел, останавливаем камеру ${pairedDeviceId}`);
      }
    }
  });

  // Зритель вернулся - запускаем камеру
  socket.on("viewer-return", ({ deviceId }) => {
    const pairedDeviceId = pairs[deviceId];
    if (pairedDeviceId) {
      const cameraSocketId = deviceSockets[pairedDeviceId];
      if (cameraSocketId) {
        io.to(cameraSocketId).emit("start-camera-request");
        console.log(`▶️ Зритель ${deviceId} вернулся, запускаем камеру ${pairedDeviceId}`);
      }
    }
  });

  // WebRTC сигналинг (через deviceId)
  socket.on("offer", ({ offer, targetDeviceId }) => {
    const senderDeviceId = connections[socket.id]?.deviceId;
    
    // Проверяем что это пара
    if (pairs[senderDeviceId] !== targetDeviceId) {
      socket.emit("error", "Можно отправлять offer только своей паре");
      return;
    }

    const targetSocketId = deviceSockets[targetDeviceId];
    if (targetSocketId) {
      console.log(`📥 Offer от ${senderDeviceId} для ${targetDeviceId}`);
      io.to(targetSocketId).emit("offer", { offer, fromDeviceId: senderDeviceId });
    }
  });

  socket.on("answer", ({ answer, targetDeviceId }) => {
    const senderDeviceId = connections[socket.id]?.deviceId;
    
    if (pairs[senderDeviceId] !== targetDeviceId) {
      socket.emit("error", "Можно отправлять answer только своей паре");
      return;
    }

    const targetSocketId = deviceSockets[targetDeviceId];
    if (targetSocketId) {
      console.log(`📥 Answer от ${senderDeviceId} для ${targetDeviceId}`);
      io.to(targetSocketId).emit("answer", { answer, fromDeviceId: senderDeviceId });
    }
  });

  socket.on("ice-candidate", ({ candidate, targetDeviceId }) => {
    const senderDeviceId = connections[socket.id]?.deviceId;
    
    if (pairs[senderDeviceId] !== targetDeviceId) {
      return; // Молча игнорируем
    }

    const targetSocketId = deviceSockets[targetDeviceId];
    if (targetSocketId) {
      io.to(targetSocketId).emit("ice-candidate", { candidate, fromDeviceId: senderDeviceId });
    }
  });

  // Отключение
  socket.on("disconnect", () => {
    console.log("❌ Отключился:", socket.id);
    
    const connection = connections[socket.id];
    if (!connection) return;
    
    const { deviceId } = connection;
    const pairedDeviceId = pairs[deviceId];

    if (pairedDeviceId) {
      const pairedSocketId = deviceSockets[pairedDeviceId];
      if (pairedSocketId) {
        io.to(pairedSocketId).emit("partner-offline", deviceId);
        console.log(`📴 ${deviceId} офлайн, пара с ${pairedDeviceId} сохранена`);
      }
    }

    // Удаляем из текущих подключений, но НЕ из pairs
    delete connections[socket.id];
    if (deviceSockets[deviceId] === socket.id) {
      delete deviceSockets[deviceId];
    }

    // Удаляем неиспользованные коды этого устройства
    Object.keys(activeCodes).forEach(code => {
      if (activeCodes[code].cameraDeviceId === deviceId && !activeCodes[code].viewerId) {
        delete activeCodes[code];
        console.log(`🗑 Удален неиспользованный код ${code}`);
      }
    });
  });

  // Проверка статуса пары
  socket.on("check-pair-status", ({ deviceId }) => {
    const pairedDeviceId = pairs[deviceId];
    if (pairedDeviceId) {
      const pairedSocketId = deviceSockets[pairedDeviceId];
      const partnerOnline = !!pairedSocketId;
      
      socket.emit("pair-status", {
        hasPair: true,
        pairedWith: pairedDeviceId,
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