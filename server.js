const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

app.use(express.static(__dirname));

let codes = {}; 
let pairs = {}; 
let sockets = {};

function generateCode() {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

io.on("connection", (socket) => {
  sockets[socket.id] = socket;

  socket.on("generate-code", () => {
    const code = generateCode();
    const expires = Date.now() + 5 * 60 * 1000;

    codes[code] = { cameraId: socket.id, expires };

    socket.emit("code-generated", { code, expiresAt: expires });
  });

  socket.on("connect-with-code", ({ code }) => {
    const entry = codes[code];

    if (!entry || Date.now() > entry.expires) {
      socket.emit("error", "Код истек или неверный");
      return;
    }

    const cameraId = entry.cameraId;
    const viewerId = socket.id;

    delete codes[code];

    pairs[cameraId] = viewerId;
    pairs[viewerId] = cameraId;

    io.to(cameraId).emit("paired", { pairedWith: viewerId });
    socket.emit("paired", { pairedWith: cameraId });
  });

  socket.on("restore-connection", ({ pairedWith }) => {
    if (pairs[pairedWith] === socket.id) {
      socket.emit("connection-restored", { pairedWith });
      io.to(pairedWith).emit("partner-online");
    } else {
      socket.emit("restore-wait");
    }
  });

  socket.on("offer", ({ offer, target }) => {
    io.to(target).emit("offer", { offer });
  });

  socket.on("answer", ({ answer, target }) => {
    io.to(target).emit("answer", { answer });
  });

  socket.on("ice-candidate", ({ candidate, target }) => {
    io.to(target).emit("ice-candidate", { candidate });
  });

  socket.on("break-pair", () => {
    const partner = pairs[socket.id];
    if (partner) {
      io.to(partner).emit("pair-broken");
      delete pairs[partner];
      delete pairs[socket.id];
    }
  });

  socket.on("disconnect", () => {
    const partner = pairs[socket.id];
    if (partner) {
      io.to(partner).emit("partner-offline");
    }
    delete pairs[socket.id];
    delete sockets[socket.id];
  });
});

server.listen(3000, () => console.log("Server running"));
