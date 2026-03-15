import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { createServer as createViteServer } from "vite";
import path from "path";

async function startServer() {
  const app = express();
  const httpServer = createServer(app);
  const io = new Server(httpServer, {
    cors: {
      origin: "*",
    },
  });

  const PORT = 3000;

  // In-memory storage for rooms and messages
  // Structure: { [roomId: string]: { messages: any[], settings: any, users: Set<string> } }
  const rooms: Record<string, { 
    messages: any[]; 
    settings: { expiryMinutes: number }; 
    users: Map<string, string>; // socketId -> name
    expiryTimer?: NodeJS.Timeout;
  }> = {};

  io.on("connection", (socket) => {
    console.log("User connected:", socket.id);

    socket.on("join-room", ({ roomId, name, settings }) => {
      socket.join(roomId);
      
      if (!rooms[roomId]) {
        rooms[roomId] = {
          messages: [],
          settings: settings || { expiryMinutes: 10 },
          users: new Map(),
        };
      }

      rooms[roomId].users.set(socket.id, name);
      
      // Broadcast updated user list
      io.to(roomId).emit("user-list", Array.from(rooms[roomId].users.values()));
      
      // Send existing messages (if any)
      socket.emit("chat-history", rooms[roomId].messages);

      console.log(`User ${name} joined room ${roomId}`);
    });

    socket.on("send-message", ({ roomId, encryptedMessage }) => {
      if (rooms[roomId]) {
        const message = {
          ...encryptedMessage,
          id: Math.random().toString(36).substring(2, 15),
          timestamp: Date.now(),
        };
        
        rooms[roomId].messages.push(message);
        io.to(roomId).emit("new-message", message);

        // Handle auto-delete timer if not already running for this message?
        // Actually the requirement says "Once the timer expires: messages automatically disappear, chat history clears from all clients"
        // This could mean a per-room timer or per-message.
        // "When creating a room, the user can select how long messages remain visible."
        // This implies a per-room setting.
      }
    });

    socket.on("disconnect", () => {
      for (const roomId in rooms) {
        if (rooms[roomId].users.has(socket.id)) {
          rooms[roomId].users.delete(socket.id);
          io.to(roomId).emit("user-list", Array.from(rooms[roomId].users.values()));
          
          // If room is empty, we could clean it up, but maybe keep it for a bit
          if (rooms[roomId].users.size === 0) {
            // Optional: cleanup room after some time
          }
        }
      }
      console.log("User disconnected:", socket.id);
    });

    socket.on("clear-chat", (roomId) => {
      if (rooms[roomId]) {
        rooms[roomId].messages = [];
        io.to(roomId).emit("chat-cleared");
      }
    });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
