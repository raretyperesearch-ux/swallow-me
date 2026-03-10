import { Room, Client } from "colyseus";
import { SnakeRoomState, SnakeEntity, FoodOrb, KillFeedEntry } from "./SnakeState";
import { ServerSnake, createSnake } from "../game/Snake";
import { ServerFood, spawnRandomFood } from "../game/Food";
import { runGameTick } from "../game/GameLoop";
import { KillEvent } from "../game/Physics";
import { findSafeSpawn } from "../game/Arena";
import { initBotState, removeBotState, getRandomBotName } from "../game/BotAI";
import { GAME_CONFIG, TIER_CONFIG } from "../config/gameConfig";
import { v4 as uuidv4 } from "uuid";

interface ClientViewport {
  x: number;
  y: number;
  w: number;
  h: number;
}

export class SnakeRoom extends Room<SnakeRoomState> {
  // Server-side state (not synced — full precision, per-room instance)
  private serverSnakes = new Map<string, ServerSnake>();
  private serverFoods = new Map<string, ServerFood>();

  private gameInterval!: ReturnType<typeof setInterval>;
  private syncInterval!: ReturnType<typeof setInterval>;
  private botCheckInterval!: ReturnType<typeof setInterval>;
  private tier: number = 1;
  private botCounter: number = 0;

  // Interest management: track each client's viewport
  private clientViewports = new Map<string, ClientViewport>();

  onCreate(options: { tier?: number }) {
    this.tier = options.tier || 1;
    const tierConfig = TIER_CONFIG[this.tier];
    if (!tierConfig) throw new Error(`Invalid tier: ${this.tier}`);

    this.maxClients = tierConfig.maxPlayers;
    this.setState(new SnakeRoomState());
    this.state.tier = this.tier;
    this.state.arenaRadius = GAME_CONFIG.ARENA_RADIUS;

    // Spawn initial food and sync to state individually
    for (let i = 0; i < GAME_CONFIG.INITIAL_FOOD_COUNT; i++) {
      const food = spawnRandomFood(GAME_CONFIG.ARENA_RADIUS);
      this.serverFoods.set(food.id, food);
      this.addFoodToState(food);
    }

    // Game loop — runs physics at TICK_RATE (30Hz)
    this.gameInterval = setInterval(() => {
      this.gameTick();
    }, 1000 / GAME_CONFIG.TICK_RATE);

    // State sync — push filtered snake positions to each client
    this.syncInterval = setInterval(() => {
      this.syncSnakesToState();
      this.updateCounts();
    }, 1000 / GAME_CONFIG.CLIENT_SEND_RATE);

    // Bot management
    this.botCheckInterval = setInterval(() => {
      this.manageBots();
    }, 3000);

    // Handle player input
    this.onMessage("input", (client, data: { angle: number; boost: boolean }) => {
      const snake = this.serverSnakes.get(client.sessionId);
      if (snake && snake.alive) {
        snake.targetAngle = data.angle;
        snake.boosting = data.boost;
        snake.lastInputTime = Date.now();
      }
    });

    // Handle viewport updates for interest management
    this.onMessage("viewport", (client, data: { x: number; y: number; w: number; h: number }) => {
      if (typeof data.x === "number" && typeof data.y === "number" &&
          typeof data.w === "number" && typeof data.h === "number") {
        this.clientViewports.set(client.sessionId, {
          x: data.x,
          y: data.y,
          w: data.w,
          h: data.h,
        });
      }
    });

    // Handle cashout request
    this.onMessage("cashout", (client) => {
      this.handleCashout(client);
    });

    console.log(`[SnakeRoom] Created tier $${this.tier} room: ${this.roomId}`);
  }

  async onJoin(client: Client, options: { wallet?: string; name?: string }) {
    const wallet = options.wallet || "unknown";
    const name = options.name || `player_${client.sessionId.slice(0, 6)}`;
    const tierConfig = TIER_CONFIG[this.tier];

    console.log(`[SnakeRoom] ${name} joined (${client.sessionId})`);

    const spawn = findSafeSpawn(this.serverSnakes, GAME_CONFIG.ARENA_RADIUS);
    const snake = createSnake(
      client.sessionId,
      name,
      wallet,
      spawn.x,
      spawn.y,
      tierConfig.entryAmount,
      false,
      0 // Player always gets rainbow skin (index 0)
    );

    this.serverSnakes.set(client.sessionId, snake);

    // Initialize viewport to spawn position
    this.clientViewports.set(client.sessionId, {
      x: spawn.x,
      y: spawn.y,
      w: 1920,
      h: 1080,
    });

    this.updateCounts();
  }

  onLeave(client: Client, consented: boolean) {
    const snake = this.serverSnakes.get(client.sessionId);
    if (snake && snake.alive) {
      snake.alive = false;
      console.log(`[SnakeRoom] ${snake.name} left (forfeited $${snake.valueUsdc / 1_000_000})`);
    }

    this.serverSnakes.delete(client.sessionId);
    this.state.snakes.delete(client.sessionId);
    this.clientViewports.delete(client.sessionId);
    this.updateCounts();
  }

  onDispose() {
    clearInterval(this.gameInterval);
    clearInterval(this.syncInterval);
    clearInterval(this.botCheckInterval);

    for (const [id, snake] of this.serverSnakes) {
      if (snake.isBot) removeBotState(id);
    }
    this.serverSnakes.clear();
    this.serverFoods.clear();
    this.clientViewports.clear();

    console.log(`[SnakeRoom] Disposed tier $${this.tier} room: ${this.roomId}`);
  }

  // ─── Individual Food State Helpers ─────────────────────

  private addFoodToState(food: ServerFood) {
    const stateFood = new FoodOrb();
    stateFood.id = food.id;
    stateFood.x = food.x;
    stateFood.y = food.y;
    stateFood.size = food.size;
    this.state.food.set(food.id, stateFood);
  }

  private removeFoodFromState(foodId: string) {
    this.state.food.delete(foodId);
  }

  // ─── Game Loop ─────────────────────────────────────────

  private gameTick() {
    runGameTick(this.serverSnakes, this.serverFoods, GAME_CONFIG.ARENA_RADIUS, {
      onKill: (event) => this.handleKill(event),
      onBoostFoodDrop: (x, y) => {
        const food: ServerFood = { id: uuidv4(), x, y, size: 1 };
        this.serverFoods.set(food.id, food);
        this.addFoodToState(food);
      },
      onFoodEaten: (eats) => {
        // Group eaten food by eater for client-side filtering
        const byEater = new Map<string, string[]>();
        for (const eat of eats) {
          let arr = byEater.get(eat.snakeId);
          if (!arr) { arr = []; byEater.set(eat.snakeId, arr); }
          arr.push(eat.foodId);
        }
        // Broadcast with eater info so clients can filter sounds/popups
        for (const [eaterId, ids] of byEater) {
          this.broadcast("food_eaten", { ids, eaterId });
        }
        // Remove from Colyseus state
        for (const eat of eats) {
          this.removeFoodFromState(eat.foodId);
        }
      },
      onFoodSpawned: (foods) => {
        // Add new food to Colyseus state so clients can see it
        for (const food of foods) {
          this.addFoodToState(food);
        }
      },
    });
  }

  // ─── Kill Handler ──────────────────────────────────────

  private handleKill(event: KillEvent) {
    const victim = this.serverSnakes.get(event.victim);
    if (!victim) return;

    const tierConfig = TIER_CONFIG[this.tier];
    const rakeAmount = Math.floor(event.victimValue * tierConfig.rakeBps / 10000);
    const payoutAmount = event.victimValue - rakeAmount;

    if (event.killer) {
      const killer = this.serverSnakes.get(event.killer);
      if (killer && killer.alive) {
        killer.valueUsdc += payoutAmount;
        console.log(
          `[Kill] ${killer.name} swallowed ${victim.name} → +$${(payoutAmount / 1_000_000).toFixed(2)}`
        );
      }
    } else {
      console.log(
        `[Kill] ${victim.name} hit the wall → forfeited $${(event.victimValue / 1_000_000).toFixed(2)}`
      );
    }

    // Add to kill feed
    const entry = new KillFeedEntry();
    entry.killerName = event.killerName || "Wall";
    entry.victimName = event.victimName;
    entry.amount = payoutAmount / 1_000_000;
    entry.timestamp = event.timestamp;
    this.state.killFeed.push(entry);

    while (this.state.killFeed.length > 10) {
      this.state.killFeed.shift();
    }

    // Remove dead snake from synced state
    this.state.snakes.delete(event.victim);

    // Death food is now synced via onFoodSpawned callback — no full sync needed

    // Notify the killed client
    const victimClient = this.clients.find((c) => c.sessionId === event.victim);
    if (victimClient) {
      victimClient.send("death", {
        killerName: event.killerName || "Wall",
        valueUsdc: event.victimValue,
        duration: Date.now() - (victim.spawnTime || Date.now()),
        kills: victim.kills,
      });
    }
  }

  // ─── Cashout Handler ───────────────────────────────────

  private handleCashout(client: Client) {
    const snake = this.serverSnakes.get(client.sessionId);
    if (!snake || !snake.alive) {
      client.send("cashout_error", { message: "Not alive" });
      return;
    }

    console.log(
      `[Cashout] ${snake.name} cashing out $${(snake.valueUsdc / 1_000_000).toFixed(2)}`
    );

    snake.alive = false;
    this.serverSnakes.delete(client.sessionId);
    this.state.snakes.delete(client.sessionId);
    this.updateCounts();

    client.send("cashout_success", {
      amount: snake.valueUsdc,
      kills: snake.kills,
      duration: Date.now() - snake.spawnTime,
    });
  }

  // ─── Bot Management ────────────────────────────────────

  private manageBots() {
    const realPlayerCount = Array.from(this.serverSnakes.values()).filter(
      (s) => !s.isBot && s.alive
    ).length;
    const aliveBotsCount = Array.from(this.serverSnakes.values()).filter(
      (s) => s.isBot && s.alive
    ).length;
    const totalAlive = realPlayerCount + aliveBotsCount;

    if (realPlayerCount >= 1 && totalAlive < GAME_CONFIG.BOT_FILL_TARGET) {
      const botsNeeded = GAME_CONFIG.BOT_FILL_TARGET - totalAlive;
      for (let i = 0; i < botsNeeded; i++) {
        this.spawnBot();
      }
    }

    if (realPlayerCount >= GAME_CONFIG.BOT_FILL_TARGET) {
      for (const [id, snake] of this.serverSnakes) {
        if (snake.isBot && snake.alive && Math.random() < 0.3) {
          snake.alive = false;
          this.serverSnakes.delete(id);
          this.state.snakes.delete(id);
          removeBotState(id);
          break;
        }
      }
    }

    // Randomly kill bots occasionally
    if (aliveBotsCount > 2 && Math.random() < 0.15) {
      const bots = Array.from(this.serverSnakes.entries()).filter(
        ([, s]) => s.isBot && s.alive
      );
      if (bots.length > 0) {
        const [botId, bot] = bots[Math.floor(Math.random() * bots.length)];
        bot.alive = false;
        this.handleKill({
          killer: null,
          victim: botId,
          victimValue: bot.valueUsdc,
          victimName: bot.name,
          killerName: "timeout",
          timestamp: Date.now(),
        });
      }
    }
  }

  private spawnBot() {
    const botId = `bot_${++this.botCounter}_${uuidv4().slice(0, 8)}`;
    const tierConfig = TIER_CONFIG[this.tier];
    const spawn = findSafeSpawn(this.serverSnakes, GAME_CONFIG.ARENA_RADIUS);

    const bot = createSnake(
      botId,
      getRandomBotName(),
      "bot",
      spawn.x,
      spawn.y,
      tierConfig.entryAmount,
      true,
      1 + Math.floor(Math.random() * 9) // Skins 1-9, rainbow (0) reserved for player
    );

    this.serverSnakes.set(botId, bot);
    initBotState(botId);
  }

  // ─── Interest Management Helpers ────────────────────────

  private isInViewport(viewport: ClientViewport, x: number, y: number): boolean {
    const margin = GAME_CONFIG.VIEWPORT_MARGIN;
    const halfW = viewport.w / 2 + margin;
    const halfH = viewport.h / 2 + margin;
    return (
      x > viewport.x - halfW &&
      x < viewport.x + halfW &&
      y > viewport.y - halfH &&
      y < viewport.y + halfH
    );
  }

  // ─── State Sync (with interest management) ──────────────

  private syncSnakesToState() {
    // Collect all alive snake data for interest management
    const aliveSnakes: [string, ServerSnake][] = [];
    for (const [id, snake] of this.serverSnakes) {
      if (snake.alive) aliveSnakes.push([id, snake]);
    }

    // Track which snake IDs should be in state (union of all clients' viewports)
    const visibleSnakeIds = new Set<string>();

    // For each real client, determine which snakes are in their viewport
    for (const client of this.clients) {
      const viewport = this.clientViewports.get(client.sessionId);
      if (!viewport) continue;

      // Always include self
      visibleSnakeIds.add(client.sessionId);

      for (const [id, snake] of aliveSnakes) {
        if (this.isInViewport(viewport, snake.headX, snake.headY)) {
          visibleSnakeIds.add(id);
        }
      }
    }

    // Sync visible snakes to Colyseus state
    for (const [id, snake] of aliveSnakes) {
      if (!visibleSnakeIds.has(id)) continue;

      let stateSnake = this.state.snakes.get(id);
      if (!stateSnake) {
        stateSnake = new SnakeEntity();
        stateSnake.id = id;
        stateSnake.name = snake.name;
        stateSnake.isBot = snake.isBot;
        stateSnake.skinId = snake.skinId;
        this.state.snakes.set(id, stateSnake);
      }

      stateSnake.headX = snake.headX;
      stateSnake.headY = snake.headY;
      stateSnake.angle = snake.angle;
      stateSnake.speed = snake.speed;
      stateSnake.boosting = snake.boosting;
      stateSnake.length = Math.floor(snake.length);
      stateSnake.alive = snake.alive;
      stateSnake.kills = snake.kills;
      stateSnake.valueUsdc = snake.valueUsdc;
    }

    // Remove snakes that are dead or no longer visible to any client
    for (const [id] of this.state.snakes) {
      const server = this.serverSnakes.get(id);
      if (!server || !server.alive || !visibleSnakeIds.has(id)) {
        this.state.snakes.delete(id);
      }
    }
  }

  private updateCounts() {
    let players = 0;
    let alive = 0;
    for (const [, snake] of this.serverSnakes) {
      if (!snake.isBot) players++;
      if (snake.alive) alive++;
    }
    this.state.playerCount = players;
    this.state.aliveCount = alive;
  }
}
