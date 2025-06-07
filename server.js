// server.js
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const { getNames } = require("country-list");
const capitals = require("./capitals.json");

const app = express();
const server = http.createServer(app);

// Configure Socket.IO with proper CORS for Vercel
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    credentials: true,
  },
  transports: ["websocket", "polling"],
});

// Serve static files
app.use(express.static(path.join(__dirname, "public")));

// Build country & capitals pools
const countries = getNames().map((n) =>
  n.toUpperCase().replace(/[^A-Z ]/g, "")
);
const capitalCities = capitals.capitals;

// Game state
const WORD_LENGTH = 5;
const MAX_ATTEMPTS = 6;
const rooms = new Map();

// Helper: generate unique room code
function generateCode(len = 6) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let code;
  do {
    code = Array.from(
      { length: len },
      () => chars[Math.floor(Math.random() * chars.length)]
    ).join("");
  } while (rooms.has(code));
  return code;
}

// Pick answer based on mode
function chooseAnswer(mode) {
  let pool;
  if (mode === "countries") pool = countries;
  else if (mode === "cities") pool = capitalCities;
  else pool = [...countries, ...capitalCities];
  return pool[Math.floor(Math.random() * pool.length)];
}

// Get location hint
function getLocationHint(answer) {
  const hints = {
    TOKYO:
      "This city is famous for its cherry blossoms and advanced technology.",
    LONDON: "This city is home to Big Ben and the River Thames.",
    PARIS: "You can see the Eiffel Tower from many points in this city.",
    BERLIN: "This city was once divided by a famous wall.",
    ROME: "This city is known as the Eternal City and has the Colosseum.",
    JAPAN: "This island nation is known for sushi and Mount Fuji.",
    FRANCE:
      "This country is famous for its wine, cheese, and the Louvre Museum.",
    ITALY: "This country is shaped like a boot and known for pasta.",
    BRAZIL: "This is the largest country in South America, home to the Amazon.",
    SPAIN: "This country is known for tapas and flamenco dancing.",
  };
  return (
    hints[answer] ||
    `This ${answer.length} letter location is waiting to be discovered!`
  );
}

io.on("connection", (socket) => {
  console.log("New client connected:", socket.id);
  let currentRoom = null;

  socket.on("createRoom", async ({ mode, avatarStyle, avatarOptions }) => {
    try {
      console.log("Creating room:", { mode, avatarStyle, avatarOptions });

      if (!["countries", "cities", "both"].includes(mode)) {
        socket.emit("errorMsg", "Invalid game mode");
        return;
      }

      const code = generateCode();
      const answer = chooseAnswer(mode);
      console.log(`Created room ${code} with answer: ${answer}`);

      rooms.set(code, {
        mode,
        answer,
        players: new Map([[socket.id, { avatarStyle, avatarOptions }]]),
        attempts: new Map([[socket.id, []]]),
        hintedIndices: new Set(),
        avatars: {
          [socket.id]: {
            seed: Math.random().toString(36).substring(2, 10),
            style: avatarStyle,
            options: avatarOptions,
          },
        },
      });

      currentRoom = code;
      await socket.join(code);
      socket.emit("roomCreated", { code });
    } catch (error) {
      console.error("Error creating room:", error);
      socket.emit("errorMsg", "Failed to create room");
    }
  });

  socket.on("joinRoom", async ({ code, avatarStyle, avatarOptions }) => {
    try {
      console.log("Joining room:", { code, avatarStyle, avatarOptions });

      if (!code) {
        socket.emit("errorMsg", "Room code is required");
        return;
      }

      const room = rooms.get(code);
      if (!room) {
        socket.emit("errorMsg", "Room not found");
        return;
      }

      currentRoom = code;
      room.players.set(socket.id, { avatarStyle, avatarOptions });
      room.attempts.set(socket.id, []);
      room.avatars[socket.id] = {
        seed: Math.random().toString(36).substring(2, 10),
        style: avatarStyle,
        options: avatarOptions,
      };

      await socket.join(code);
      console.log(`Player ${socket.id} joined room ${code}`);

      socket.emit("joined", {
        code,
        wordLength: room.answer.length,
        maxAttempts: MAX_ATTEMPTS,
        avatars: room.avatars,
        yourId: socket.id,
        locationHint: getLocationHint(room.answer),
      });

      socket.to(code).emit("playerJoined", {
        id: socket.id,
        seed: room.avatars[socket.id].seed,
        style: avatarStyle,
        options: avatarOptions,
      });
    } catch (error) {
      console.error("Error joining room:", error);
      socket.emit("errorMsg", "Failed to join room");
    }
  });

  socket.on("makeGuess", (guess) => {
    try {
      if (!currentRoom || !rooms.has(currentRoom)) {
        socket.emit("errorMsg", "You are not in a room");
        return;
      }

      const room = rooms.get(currentRoom);
      const { answer } = room;

      if (!guess || typeof guess !== "string") {
        socket.emit("errorMsg", "Invalid guess");
        return;
      }

      guess = guess.toUpperCase().trim();

      if (guess.length !== answer.length) {
        socket.emit("errorMsg", `Guess must be ${answer.length} letters`);
        return;
      }

      const attempts = room.attempts.get(socket.id);
      attempts.push(guess);

      const feedback = guess.split("").map((ch, i) => {
        if (ch === answer[i]) return "correct";
        if (answer.includes(ch)) return "present";
        return "absent";
      });

      io.to(currentRoom).emit("feedback", {
        guess,
        feedback,
        player: socket.id,
      });

      if (guess === answer || attempts.length >= MAX_ATTEMPTS) {
        io.to(currentRoom).emit("gameOver", {
          winner: guess === answer ? socket.id : null,
          answer,
          locationHint: getLocationHint(answer),
        });
        rooms.delete(currentRoom);
      }
    } catch (error) {
      console.error("Error making guess:", error);
      socket.emit("errorMsg", "Failed to process guess");
    }
  });

  socket.on("requestHint", () => {
    try {
      if (!currentRoom || !rooms.has(currentRoom)) {
        socket.emit("errorMsg", "You are not in a room");
        return;
      }

      const room = rooms.get(currentRoom);
      const { answer, hintedIndices } = room;
      const available = [...Array(answer.length).keys()].filter(
        (i) => !hintedIndices.has(i)
      );

      if (!available.length) {
        socket.emit("errorMsg", "No more hints available");
        return;
      }

      const idx = available[Math.floor(Math.random() * available.length)];
      hintedIndices.add(idx);

      io.to(currentRoom).emit("hint", {
        index: idx,
        letter: answer[idx],
        locationHint: getLocationHint(answer),
      });
    } catch (error) {
      console.error("Error requesting hint:", error);
      socket.emit("errorMsg", "Failed to get hint");
    }
  });

  socket.on("disconnect", () => {
    try {
      console.log("Client disconnected:", socket.id);

      if (currentRoom && rooms.has(currentRoom)) {
        const room = rooms.get(currentRoom);
        io.to(currentRoom).emit("playerLeft", { id: socket.id });
        room.players.delete(socket.id);
        room.attempts.delete(socket.id);
        delete room.avatars[socket.id];

        if (room.players.size === 0) {
          console.log(`Deleting empty room ${currentRoom}`);
          rooms.delete(currentRoom);
        }
      }
    } catch (error) {
      console.error("Error handling disconnect:", error);
    }
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error("Error:", err);
  res.status(500).json({ error: "Internal Server Error" });
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok", timestamp: new Date().toISOString() });
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
