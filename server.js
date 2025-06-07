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
    origin: "*", // Be more permissive with CORS in development
    methods: ["GET", "POST"],
    credentials: true,
  },
  path: "/socket.io/",
  transports: ["websocket", "polling"],
  allowEIO3: true, // Allow Engine.IO version 3 clients
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error("Error:", err);
  res.status(500).json({ error: "Internal Server Error" });
});

// serve static
app.use(express.static(path.join(__dirname, "public")));

// build country & capitals pools
const countries = getNames().map((n) =>
  n.toUpperCase().replace(/[^A-Z ]/g, "")
);
const capitalCities = capitals.capitals;

// in-memory rooms: { code: { mode, answer, players:Set, attempts:{}, hintedIndices:Set, avatars:{} } }
const rooms = new Map();

// in-memory lobby chat
const lobbyMessages = [];
const MAX_LOBBY_MESSAGES = 50;

// Game state
const WORD_LENGTH = 5;
const MAX_ATTEMPTS = 6;

// Countries and cities data (simplified for example)
const locations = {
  countries: ["SPAIN", "ITALY", "FRANCE", "JAPAN", "CHINA", "INDIA", "BRAZIL"],
  cities: ["PARIS", "TOKYO", "ROME", "DELHI", "CAIRO", "MIAMI", "DUBAI"],
  both: ["SPAIN", "PARIS", "TOKYO", "INDIA", "ROME", "DUBAI", "MIAMI"],
};

// helper: unique room codes
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

// pick answer based on mode
function chooseAnswer(mode) {
  let pool;
  if (mode === "countries") pool = countries;
  else if (mode === "cities") pool = capitalCities;
  else pool = countries.concat(capitalCities);
  return pool[Math.floor(Math.random() * pool.length)];
}

// Interactive hints system
function getLocationHint(answer) {
  const hints = {
    // Capitals
    TOKYO:
      "This city is famous for its cherry blossoms and advanced technology.",
    LONDON: "This city is home to Big Ben and the River Thames.",
    PARIS: "You can see the Eiffel Tower from many points in this city.",
    BERLIN: "This city was once divided by a famous wall.",
    ROME: "This city is known as the Eternal City and has the Colosseum.",
    // Countries
    JAPAN: "This island nation is known for sushi and Mount Fuji.",
    FRANCE:
      "This country is famous for its wine, cheese, and the Louvre Museum.",
    ITALY: "This country is shaped like a boot and known for pasta.",
    BRAZIL: "This is the largest country in South America, home to the Amazon.",
    AUSTRALIA: "This country is both a continent and home to kangaroos.",
  };
  return (
    hints[answer] ||
    `This ${answer.length} letter location is waiting to be discovered!`
  );
}

io.on("connection", (socket) => {
  let currentRoom = null;

  // Send lobby messages on connection
  socket.emit("lobbyMessages", lobbyMessages);

  // Handle lobby chat
  socket.on("lobbyChatMessage", (text) => {
    const message = {
      user: socket.id.slice(0, 5),
      text,
      timestamp: Date.now(),
    };
    lobbyMessages.push(message);
    if (lobbyMessages.length > MAX_LOBBY_MESSAGES) {
      lobbyMessages.shift();
    }
    io.emit("lobbyChatMessage", message);
  });

  // 1) create room
  socket.on("createRoom", ({ mode, avatarStyle, avatarOptions }) => {
    try {
      if (currentRoom) {
        socket.emit("errorMsg", "You are already in a room");
        return;
      }

      if (!["countries", "cities", "both"].includes(mode)) {
        socket.emit("errorMsg", "Invalid game mode");
        return;
      }

      const code = generateCode();
      const answer = chooseAnswer(mode);

      console.log(`Creating room ${code} with answer: ${answer}`);

      rooms.set(code, {
        mode,
        answer,
        players: new Map([[socket.id, { avatarStyle, avatarOptions }]]),
        attempts: new Map(),
        hintedIndices: new Set(),
        avatars: {},
        messages: [],
      });

      socket.emit("roomCreated", { code });
    } catch (error) {
      console.error("Error creating room:", error);
      socket.emit("errorMsg", "Failed to create room. Please try again.");
    }
  });

  // 2) join room
  socket.on("joinRoom", ({ code, avatarStyle, avatarOptions }) => {
    try {
      if (!code) {
        socket.emit("errorMsg", "Room code is required");
        return;
      }

      if (currentRoom) {
        socket.emit("errorMsg", "You are already in a room");
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

      // Store avatar info
      room.avatars[socket.id] = {
        seed: Math.random().toString(36).substring(2, 10),
        style: avatarStyle,
        options: avatarOptions,
      };

      socket.join(code);

      console.log(`Player ${socket.id} joined room ${code}`);

      // send join data + all current avatars + your own socket id
      socket.emit("joined", {
        code,
        wordLength: room.answer.length,
        maxAttempts: MAX_ATTEMPTS,
        avatars: Object.fromEntries(room.players),
        yourId: socket.id,
        locationHint: getLocationHint(room.answer),
        messages: room.messages,
      });

      // notify others
      socket.to(code).emit("playerJoined", {
        id: socket.id,
        seed: room.avatars[socket.id].seed,
        style: avatarStyle,
        options: avatarOptions,
      });
    } catch (error) {
      console.error("Error joining room:", error);
      socket.emit("errorMsg", "Failed to join room. Please try again.");
    }
  });

  // 3) chat
  socket.on("chatMessage", (text) => {
    if (!currentRoom || !rooms.has(currentRoom)) {
      socket.emit("errorMsg", "You are not in a room");
      return;
    }
    const message = {
      user: socket.id.slice(0, 5),
      text,
      timestamp: Date.now(),
    };
    rooms.get(currentRoom).messages.push(message);
    io.to(currentRoom).emit("chatMessage", message);
  });

  // 4) hint
  socket.on("requestHint", () => {
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
  });

  // 5) guess
  socket.on("makeGuess", (guess) => {
    if (!currentRoom || !rooms.has(currentRoom)) {
      socket.emit("errorMsg", "You are not in a room");
      return;
    }

    const room = rooms.get(currentRoom);
    const { answer, mode } = room;

    if (!guess || typeof guess !== "string") {
      socket.emit("errorMsg", "Invalid guess");
      return;
    }

    guess = guess.toUpperCase().trim();

    if (guess.length !== answer.length) {
      socket.emit("errorMsg", `Guess must be ${answer.length} letters`);
      return;
    }

    const pool =
      mode === "countries"
        ? countries
        : mode === "cities"
        ? capitalCities
        : countries.concat(capitalCities);

    if (!pool.includes(guess)) {
      socket.emit(
        "errorMsg",
        `Invalid ${
          mode === "both"
            ? "location"
            : mode === "countries"
            ? "country"
            : "capital city"
        }`
      );
      return;
    }

    room.attempts.get(socket.id).push(guess);

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

    if (
      guess === answer ||
      room.attempts.get(socket.id).length >= MAX_ATTEMPTS
    ) {
      io.to(currentRoom).emit("gameOver", {
        winner: guess === answer ? socket.id : null,
        answer,
        locationHint: getLocationHint(answer),
      });
      rooms.delete(currentRoom);
    }
  });

  // 6) disconnect cleanup
  socket.on("disconnect", () => {
    if (!currentRoom || !rooms.has(currentRoom)) return;

    console.log(`Player ${socket.id} disconnected from room ${currentRoom}`);

    const room = rooms.get(currentRoom);
    io.to(currentRoom).emit("playerLeft", { id: socket.id });
    room.players.delete(socket.id);
    room.attempts.delete(socket.id);
    delete room.avatars[socket.id];

    // Clean up empty rooms
    if (!room.players.size) {
      console.log(`Deleting empty room ${currentRoom}`);
      rooms.delete(currentRoom);
    }
  });

  // Error handling for socket.io
  socket.on("error", (error) => {
    console.error("Socket Error:", error);
  });
});

// Error handling for socket.io
io.on("error", (error) => {
  console.error("Socket.IO Error:", error);
});

// Handle root route
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok", timestamp: new Date().toISOString() });
});

// Export for Vercel
if (process.env.VERCEL) {
  // In Vercel, we export the handler
  module.exports = server;
} else {
  // Local development
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}
