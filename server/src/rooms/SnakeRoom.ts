import { Room, Client } from "colyseus";
import { SnakeRoomState, SnakeEntity, FoodOrb, KillFeedEntry } from "./SnakeState";
import { ServerSnake, createSnake } from "../game/Snake";
import { ServerFood, spawnRandomFood, spawnDeathFood } from "../game/Food";
import { runGameTick } from "../game/GameLoop";
import { KillEvent } from "../game/Physics";
import { findSafeSpawn } from "../game/Arena";
import { initBotState, removeBotState, getRandomBotName, getRandomBotType, getBotState } from "../game/BotAI";
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
  private botCashoutInterval!: ReturnType<typeof setInterval>;
  private healthInterval!: ReturnType<typeof setInterval>;
  private tier: number = 1;
  private botCounter: number = 0;
  private healthLastTime: number = Date.now();
  private healthTickCount: number = 0;
  private killedThisTick = new Set<string>();

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

    // Bot cashout check — ROI-based every 5 seconds
    this.botCashoutInterval = setInterval(() => {
      this.checkBotCashouts();
    }, 5000);

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

    // Health telemetry — log every 5 seconds
    this.healthInterval = setInterval(() => {
      const now = Date.now();
      const elapsed = (now - this.healthLastTime) / 1000;
      const tps = this.healthTickCount / elapsed;
      this.healthLastTime = now;
      this.healthTickCount = 0;

      const alive = Array.from(this.serverSnakes.values()).filter(s => s.alive).length;
      const total = this.serverSnakes.size;
      const foodCount = this.serverFoods.size;
      const mem = process.memoryUsage();
      const heapMB = (mem.heapUsed / 1024 / 1024).toFixed(1);
      const rssMB = (mem.rss / 1024 / 1024).toFixed(1);

      console.log(
        `[HEALTH] TPS=${tps.toFixed(1)} alive=${alive}/${total} food=${foodCount} heap=${heapMB}MB rss=${rssMB}MB`
      );
      if (tps < 25) {
        console.warn(`[HEALTH:WARN] TPS dropped below 25! (${tps.toFixed(1)})`);
      }
    }, 5000);

    console.log(`[SnakeRoom] Created tier $${this.tier} room: ${this.roomId}`);
  }

  // Track spectators (no snake, just watching)
  private spectators = new Set<string>();
  // Track guest players (play with bots, no real money)
  private guests = new Set<string>();

  async onJoin(client: Client, options: { wallet?: string; name?: string; sessionId?: string; playerId?: string; guest?: boolean; spectate?: boolean }) {
    const wallet = options.wallet || "unknown";
    const name = options.name || `player_${client.sessionId.slice(0, 6)}`;
    const tierConfig = TIER_CONFIG[this.tier];
    const isFreeRoom = this.roomName.endsWith("_free");

    // Block guests from real money rooms
    if (options.guest && !isFreeRoom) {
      console.log(`[ROOM] Rejected guest from real money room ${this.roomName}`);
      throw new Error("Free players must join the free room");
    }

    // Block real (non-spectator) players from free rooms
    if (!options.guest && !options.spectate && isFreeRoom) {
      console.log(`[ROOM] Rejected real player from free room ${this.roomName}`);
      throw new Error("Paid players must join the real room");
    }

    // Spectate mode — no snake, just camera following top player
    if (options.spectate) {
      console.log(`[SnakeRoom] Spectator joined (${client.sessionId})`);
      this.spectators.add(client.sessionId);

      // Find the top snake to set initial viewport
      const topSnake = this.getTopSnake();
      const viewX = topSnake ? topSnake.headX : 0;
      const viewY = topSnake ? topSnake.headY : 0;

      this.clientViewports.set(client.sessionId, {
        x: viewX,
        y: viewY,
        w: 1920,
        h: 1080,
      });

      // Tell client they're spectating and who the top player is
      client.send("spectate_start", {
        topPlayerId: topSnake ? topSnake.id : null,
        topPlayerName: topSnake ? topSnake.name : null,
      });

      this.updateCounts();
      return;
    }

    console.log(`[SnakeRoom] ${name} joined (${client.sessionId}) session=${options.sessionId || 'none'} guest=${!!options.guest}`);

    const spawn = findSafeSpawn(this.serverSnakes, GAME_CONFIG.ARENA_RADIUS);
    const snake = createSnake(
      client.sessionId,
      name,
      wallet,
      spawn.x,
      spawn.y,
      options.guest ? tierConfig.entryAmount : tierConfig.entryAmount, // same initial value for display
      false,
      0 // Player always gets rainbow skin (index 0)
    );

    // Store settlement info from game entry
    if (options.sessionId) snake.sessionId = options.sessionId;
    if (options.playerId) snake.playerId = options.playerId;
    snake.isSettling = false;

    // Mark as guest — no settlement on death
    if (options.guest) {
      this.guests.add(client.sessionId);
    }

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
    // Spectator leaving — just clean up viewport
    if (this.spectators.has(client.sessionId)) {
      this.spectators.delete(client.sessionId);
      this.clientViewports.delete(client.sessionId);
      this.updateCounts();
      return;
    }

    const isGuest = this.guests.has(client.sessionId);
    const snake = this.serverSnakes.get(client.sessionId);
    if (snake && snake.alive) {
      snake.alive = false;
      console.log(`[SnakeRoom] ${snake.name} left (forfeited $${snake.valueUsdc / 1_000_000})${isGuest ? ' [GUEST]' : ''}`);

      // Settle forfeit for real-money players only (not guests)
      if (!isGuest && snake.playerId && snake.sessionId && !snake.isSettling) {
        this.callSettle({
          sessionId: snake.sessionId,
          outcome: "forfeit",
          cashoutAmountMicro: 0,
          kills: snake.kills || 0,
          durationMs: Date.now() - (snake.spawnTime || Date.now()),
        }).catch((err) => console.error("[FORFEIT] Settlement failed:", err));
      }
    }

    this.guests.delete(client.sessionId);
    this.serverSnakes.delete(client.sessionId);
    if (this.state.snakes.has(client.sessionId)) {
      this.state.snakes.delete(client.sessionId);
    }
    this.clientViewports.delete(client.sessionId);
    this.updateCounts();
  }

  onDispose() {
    clearInterval(this.gameInterval);
    clearInterval(this.syncInterval);
    clearInterval(this.botCheckInterval);
    clearInterval(this.botCashoutInterval);
    clearInterval(this.healthInterval);

    for (const [id, snake] of this.serverSnakes) {
      if (snake.isBot) removeBotState(id);
    }
    this.serverSnakes.clear();
    this.serverFoods.clear();
    this.clientViewports.clear();
    this.spectators.clear();
    this.guests.clear();

    console.log(`[SnakeRoom] Disposed tier $${this.tier} room: ${this.roomId}`);
  }

  // ─── Helper: get top alive snake by value ─────────────
  private getTopSnake(): ServerSnake | null {
    let top: ServerSnake | null = null;
    for (const [, snake] of this.serverSnakes) {
      if (snake.alive && (!top || snake.valueUsdc > top.valueUsdc)) {
        top = snake;
      }
    }
    return top;
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
    this.healthTickCount++;
    this.killedThisTick.clear();
    runGameTick(this.serverSnakes, this.serverFoods, GAME_CONFIG.ARENA_RADIUS, {
      onKill: (event) => this.handleKill(event),
      onBoostFoodDrop: (x, y) => {
        const food: ServerFood = { id: uuidv4(), x, y, size: 1 };
        this.serverFoods.set(food.id, food);
        this.addFoodToState(food);
        return food.id;
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

    // Don't kill players who are cashing out
    if (victim.isSettling) return;

    // Messaging-level dedupe: suppress duplicate kill events within the same tick
    if (this.killedThisTick.has(event.victim)) return;
    this.killedThisTick.add(event.victim);

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
    if (this.state.snakes.has(event.victim)) {
      this.state.snakes.delete(event.victim);
    }

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

    // Settle death for real-money players only — skip bots and guests (fire and forget)
    if (!victim.isBot && !this.guests.has(event.victim) && victim.playerId && victim.sessionId && !victim.isSettling) {
      const killer = event.killer ? this.serverSnakes.get(event.killer) : null;
      this.callSettle({
        sessionId: victim.sessionId,
        outcome: "death",
        cashoutAmountMicro: 0,
        kills: victim.kills || 0,
        durationMs: Date.now() - (victim.spawnTime || Date.now()),
        diedTo: killer?.name || event.killerName || "Wall",
      }).catch((err) => console.error("[DEATH] Settlement failed:", err));
    }
  }

  // ─── Settlement API ────────────────────────────────────

  private async callSettle(params: {
    sessionId: string;
    outcome: "cashout" | "death" | "forfeit";
    cashoutAmountMicro?: number;
    kills?: number;
    durationMs?: number;
    diedTo?: string;
  }): Promise<any> {
    const url = process.env.SETTLEMENT_API_URL;
    const secret = process.env.GAME_SERVER_SECRET;
    if (!url || !secret) {
      console.error("[SETTLE] Missing SETTLEMENT_API_URL or GAME_SERVER_SECRET");
      return null;
    }

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-server-secret": secret,
        },
        body: JSON.stringify({
          sessionId: params.sessionId,
          outcome: params.outcome,
          cashoutAmountMicro: params.cashoutAmountMicro || 0,
          kills: params.kills || 0,
          durationMs: params.durationMs || 0,
          diedTo: params.diedTo || null,
        }),
      });
      const result = await res.json();
      return result;
    } catch (err) {
      console.error("[SETTLE] API call failed:", err);
      return null;
    }
  }

  // ─── Cashout Handler ───────────────────────────────────

  private async handleCashout(client: Client) {
    const snake = this.serverSnakes.get(client.sessionId);
    if (!snake || !snake.alive) {
      client.send("cashout_error", { message: "Not alive" });
      return;
    }

    if (snake.isSettling) {
      client.send("cashout_error", { message: "Already settling" });
      return;
    }

    // Guest players can't cash out real money
    if (this.guests.has(client.sessionId)) {
      snake.alive = false;
      this.serverSnakes.delete(client.sessionId);
      if (this.state.snakes.has(client.sessionId)) {
        this.state.snakes.delete(client.sessionId);
      }
      this.guests.delete(client.sessionId);
      this.updateCounts();
      client.send("cashout_success", {
        amount: 0,
        kills: snake.kills,
        duration: Date.now() - snake.spawnTime,
        guest: true,
      });
      return;
    }

    // If no session info, do local-only cashout (non-real-money player)
    if (!snake.sessionId || !snake.playerId) {
      console.log(
        `[Cashout] ${snake.name} cashing out $${(snake.valueUsdc / 1_000_000).toFixed(2)} (no session)`
      );
      snake.alive = false;
      this.serverSnakes.delete(client.sessionId);
      if (this.state.snakes.has(client.sessionId)) {
        this.state.snakes.delete(client.sessionId);
      }
      this.updateCounts();
      client.send("cashout_success", {
        amount: snake.valueUsdc,
        kills: snake.kills,
        duration: Date.now() - snake.spawnTime,
      });
      return;
    }

    snake.isSettling = true;
    const rawValue = Math.floor(snake.valueUsdc || 0);
    const rake = Math.floor(rawValue * 0.15);
    const cashoutMicro = rawValue - rake;
    const kills = snake.kills || 0;
    const duration = Date.now() - snake.spawnTime;

    console.log(
      `[CASHOUT] Raw: ${rawValue}, Rake: ${rake} (15%), Payout: ${cashoutMicro}`
    );

    const result = await this.callSettle({
      sessionId: snake.sessionId,
      outcome: "cashout",
      cashoutAmountMicro: cashoutMicro,
      kills,
      durationMs: duration,
    });

    if (result?.success) {
      snake.alive = false;
      this.serverSnakes.delete(client.sessionId);
      if (this.state.snakes.has(client.sessionId)) {
        this.state.snakes.delete(client.sessionId);
      }
      this.updateCounts();
      client.send("cashout_success", {
        amount: cashoutMicro,
        kills,
        duration,
        txSignature: result.txSignature,
      });
    } else {
      // Settlement failed — unlock, let them keep playing
      snake.isSettling = false;
      console.error("[CASHOUT] Settlement failed:", result?.error || "unknown");
      client.send("cashout_error", {
        message: result?.error || "Cashout failed. Try again.",
        canRetry: true,
      });
    }
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
          removeBotState(id);
          // syncSnakesToState handles state.snakes cleanup next cycle
          break;
        }
      }
    }

    // Randomly despawn bots occasionally (direct cleanup, no kill event path)
    if (aliveBotsCount > 2 && Math.random() < 0.15) {
      const bots = Array.from(this.serverSnakes.entries()).filter(
        ([, s]) => s.isBot && s.alive
      );
      if (bots.length > 0) {
        const [botId, bot] = bots[Math.floor(Math.random() * bots.length)];
        bot.alive = false;

        const deathFoods = spawnDeathFood(bot.segments, GAME_CONFIG.DEATH_FOOD_COUNT);
        for (const f of deathFoods) {
          this.serverFoods.set(f.id, f);
          this.addFoodToState(f);
        }

        this.serverSnakes.delete(botId);
        removeBotState(botId);
        // syncSnakesToState handles state.snakes cleanup next cycle
      }
    }
  }

  private randomBotValue(): number {
    const roll = Math.random();
    if (roll < 0.70) {
      // 70% chance: $0.10 - $0.15
      return 100000 + Math.floor(Math.random() * 50000);
    } else {
      // 30% chance: $0.15 - $0.25
      return 150000 + Math.floor(Math.random() * 100000);
    }
  }

  private spawnBot() {
    const botId = `bot_${++this.botCounter}_${uuidv4().slice(0, 8)}`;
    const spawn = findSafeSpawn(this.serverSnakes, GAME_CONFIG.ARENA_RADIUS);
    const botType = getRandomBotType();
    const botValue = this.randomBotValue();

    const bot = createSnake(
      botId,
      getRandomBotName(),
      "bot",
      spawn.x,
      spawn.y,
      botValue,
      true,
      1 + Math.floor(Math.random() * 9) // Skins 1-9, rainbow (0) reserved for player
    );
    bot.botType = botType;
    bot.botStartValue = botValue;

    this.serverSnakes.set(botId, bot);
    initBotState(botId, botType);
  }

  // ─── Bot Cashout (ROI-based) ────────────────────────────

  private checkBotCashouts() {
    for (const [botId, bot] of this.serverSnakes) {
      if (!bot.isBot || !bot.alive) continue;

      const startValue = bot.botStartValue || 100000;
      const currentValue = bot.valueUsdc;
      const roi = (currentValue - startValue) / startValue;

      if (roi < 0.40) continue;

      let cashoutChance = 0;
      if (roi >= 0.40) cashoutChance = 0.15;
      if (roi >= 0.75) cashoutChance = 0.30;
      if (roi >= 1.00) cashoutChance = 0.50;
      if (roi >= 1.50) cashoutChance = 0.70;
      if (roi >= 2.00) cashoutChance = 0.90;
      if (roi >= 3.00) cashoutChance = 1.00;

      const killBonus = (bot.kills || 0) * 0.10;
      cashoutChance = Math.min(1.0, cashoutChance + killBonus);

      if (Math.random() < cashoutChance) {
        console.log(
          `[BOT] ${bot.name} cashed out at $${(currentValue / 1_000_000).toFixed(2)} (${(roi * 100).toFixed(0)}% ROI, ${bot.kills || 0} kills)`
        );

        bot.alive = false;
        this.serverSnakes.delete(botId);
        if (this.state.snakes.has(botId)) {
          this.state.snakes.delete(botId);
        }
        removeBotState(botId);

        // Spawn fresh replacement
        this.spawnBot();
      }
    }
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
        stateSnake.botType = snake.botType || "";
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
    const toRemove: string[] = [];
    for (const [id] of this.state.snakes) {
      const server = this.serverSnakes.get(id);
      if (!server || !server.alive || !visibleSnakeIds.has(id)) {
        toRemove.push(id);
      }
    }
    for (const id of toRemove) {
      this.state.snakes.delete(id);
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

    // Update spectators with current top player info
    if (this.spectators.size > 0) {
      const topSnake = this.getTopSnake();
      if (topSnake) {
        for (const specId of this.spectators) {
          const client = this.clients.find((c) => c.sessionId === specId);
          if (client) {
            client.send("spectate_update", {
              topPlayerId: topSnake.id,
              topPlayerName: topSnake.name,
              topPlayerValue: topSnake.valueUsdc,
              topPlayerX: topSnake.headX,
              topPlayerY: topSnake.headY,
            });
            // Update spectator viewport to follow top player
            this.clientViewports.set(specId, {
              x: topSnake.headX,
              y: topSnake.headY,
              w: 1920,
              h: 1080,
            });
          }
        }
      }
    }
  }
}
