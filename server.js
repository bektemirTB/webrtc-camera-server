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
// connections: { socketId: { roomId, role, pairedWith } }

const activeCodes = {}; // Временные коды (5 минут)
const pairs = {}; // Постоянные пары
const connections = {}; // Текущие подключения

const CODE_LIFETIME = 5 * 60 * 1000; // 5 минут

io.on("connection", (socket) => {
  console.log("🔌 Подключился:", socket.id);

  // Генерация кода для камеры
  socket.on("generate-code", () => {
    const existingPair = Object.keys(pairs).find(key =>
      pairs[key] === socket.id || key === socket.id
    );

    if (existingPair) {
      socket.emit("error", "У вас уже есть активная пара. Разорвите её для создания новой.");
      console.log(`❌ ${socket.id} пытается создать код, но уже в паре`);
      return;
    }

    let code;
    do {
      code = Math.floor(1000 + Math.random() * 9000).toString();
    } while (activeCodes[code]);

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

    setTimeout(() => {
      if (activeCodes[code] && !activeCodes[code].viewerId) {
        delete activeCodes[code];
        // не уведомляем напрямую (клиент сам увидит code-expired)
        try { socket.emit("code-expired"); } catch(e){}
        console.log(`⏰ Код ${code} истек`);
      }
    }, CODE_LIFETIME);
  });

  // Подключение зрителя по коду
  socket.on("connect-with-code", ({ code }) => {
    console.log(`👁 Зритель ${socket.id} пытается подключиться с кодом ${code}`);

    if (!activeCodes[code]) {
      socket.emit("error", "Неверный код или срок действия истек");
      console.log(`❌ Код ${code} не найден`);
      return;
    }

    const codeData = activeCodes[code];

    if (Date.now() > codeData.expiresAt) {
      delete activeCodes[code];
      socket.emit("error", "Срок действия кода истек");
      console.log(`❌ Код ${code} истек`);
      return;
    }

    if (codeData.viewerId) {
      socket.emit("error", "Этот код уже используется");
      console.log(`❌ Код ${code} уже используется`);
      return;
    }

    if (pairs[socket.id]) {
      socket.emit("error", "У вас уже есть активная пара. Разорвите её для создания новой.");
      console.log(`❌ Зритель ${socket.id} уже в паре`);
      return;
    }

    const cameraId = codeData.cameraId;

    // Создаем постоянную пару
    pairs[cameraId] = socket.id;
    pairs[socket.id] = cameraId;

    // Удаляем использованный код
    codeData.viewerId = socket.id;
    delete activeCodes[code];

    // Сохраняем информацию о подключениях
    connections[socket.id] = { role: "viewer", pairedWith: cameraId };
    connections[cameraId] = connections[cameraId] || { role: "camera", pairedWith: socket.id };
    connections[cameraId].pairedWith = socket.id;

    // Комната
    const roomId = `pair_${cameraId}_${socket.id}`;
    socket.join(roomId);
    io.sockets.sockets.get(cameraId)?.join(roomId);

    // Уведомляем
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
  });

  // Восстановление соединения для существующей пары
  socket.on("restore-connection", ({ pairedWith }) => {
    console.log(`🔄 ${socket.id} просит восстановить соединение с ${pairedWith}`);

    // Если в pairs пара есть — OK
    if (pairs[socket.id] === pairedWith && pairs[pairedWith] === socket.id) {
      // Роль определим по наличию записи
      const role = pairs[socket.id] === pairedWith ? (connections[socket.id]?.role || (socket.id === Object.keys(pairs).find(k => pairs[k] === pairs[k]) ? "camera" : "viewer")) : "viewer";

      connections[socket.id] = { role, pairedWith };
      const roomId = (role === "camera") ? `pair_${socket.id}_${pairedWith}` : `pair_${pairedWith}_${socket.id}`;
      socket.join(roomId);

      socket.emit("connection-restored", {
        pairedWith,
        roomId,
        role
      });

      io.to(pairedWith).emit("partner-online", socket.id);
      console.log(`✅ Соединение восстановлено: ${socket.id} ↔ ${pairedWith}`);
      return;
    }

    // Если пара в серверной памяти отсутствует — не ругаемся, говорим клиенту ждать.
    // Это важно: не удаляем локальную пару на клиенте — пусть клиент показывает "ожидание второй стороны".
    socket.emit("wait-for-pair", { pairedWith });
    console.log(`ℹ️ Пара для ${socket.id} не найдена на сервере, клиенту предложено ждать.`);
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

    // Удаляем connections
    delete connections[socket.id];
    delete connections[pairedWith];

    // Уведомляем обоих
    socket.emit("pair-broken");
    io.to(pairedWith).emit("pair-broken");

    console.log(`✅ Пара разорвана`);
  });

  // WebRTC сигналинг (только для пар)
  socket.on("offer", ({ offer, target }) => {
    if (pairs[socket.id] !== target) {
      socket.emit("error", "Можно отправлять offer только своей паре");
      return;
    }
    io.to(target).emit("offer", { offer, target: socket.id });
  });

  socket.on("answer", ({ answer, target }) => {
    if (pairs[socket.id] !== target) {
      socket.emit("error", "Можно отправлять answer только своей паре");
      return;
    }
    io.to(target).emit("answer", { answer, target: socket.id });
  });

  socket.on("ice-candidate", ({ candidate, target }) => {
    if (pairs[socket.id] !== target) {
      return; // игнорируем
    }
    io.to(target).emit("ice-candidate", { candidate, target: socket.id });
  });

  // Отключение
  socket.on("disconnect", () => {
    console.log("❌ Отключился:", socket.id);

    const pairedWith = pairs[socket.id];

    if (pairedWith) {
      // Уведомляем партнера что он офлайн (но не разрываем пару)
      io.to(pairedWith).emit("partner-offline", socket.id);
      console.log(`📴 ${socket.id} офлайн, пара с ${pairedWith} сохранена`);
    }

    delete connections[socket.id];

    // Удаляем неиспользованные коды этой камеры
    Object.keys(activeCodes).forEach(code => {
      if (activeCodes[code].cameraId === socket.id && !activeCodes[code].viewerId) {
        delete activeCodes[code];
        console.log(`🗑 Удален неиспользованный код ${code}`);
      }
    });
  });

  // Дополнительно: можно запросить статус пары
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
});
