import { Server, matchMaker } from "colyseus";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { monitor } from "@colyseus/monitor";
import express from "express";
import cors from "cors";
import { SnakeRoom } from "./rooms/SnakeRoom";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const port = parseInt(process.env.PORT || "2567");

app.use(cors({
  origin: process.env.CORS_ORIGIN || "*",
}));
app.use(express.json());

// Health check
app.get("/health", (_, res) => {
  res.json({ status: "ok", timestamp: Date.now() });
});

// Colyseus monitor (admin dashboard)
app.use("/monitor", monitor());

// Lobby info API
app.get("/api/lobbies", async (_, res) => {
  try {
    const rooms = await matchMaker.query({});
    const lobbies = rooms.map((room: any) => ({
      roomId: room.roomId,
      tier: room.metadata?.tier || 1,
      clients: room.clients,
      maxClients: room.maxClients,
      locked: room.locked,
    }));
    res.json({ lobbies });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch lobbies" });
  }
});

const gameServer = new Server({
  transport: new WebSocketTransport({ server: app.listen(port) }),
});

// Define room handlers for each tier
gameServer.define("snake_1", SnakeRoom, { tier: 1 });
gameServer.define("snake_5", SnakeRoom, { tier: 5 });
gameServer.define("snake_20", SnakeRoom, { tier: 20 });

// Free/guest rooms — same SnakeRoom class, guests only
gameServer.define("snake_1_free", SnakeRoom, { tier: 1 });

console.log(`
  ╔═══════════════════════════════════════╗
  ║        🐍 SWALLOW ME SERVER 🐍        ║
  ║                                       ║
  ║  Port: ${port}                          ║
  ║  Rooms: snake_1/5/20, snake_1_free    ║
  ║  Monitor: http://localhost:${port}/monitor ║
  ╚═══════════════════════════════════════╝
`);
