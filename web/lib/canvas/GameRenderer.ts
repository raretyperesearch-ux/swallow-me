import * as Colyseus from "colyseus.js";

// ─── Types ──────────────────────────────────────────

interface LocalSnake {
  segments: { x: number; y: number }[];
  headX: number;
  headY: number;
  angle: number;
  targetAngle: number;
  length: number;
  alive: boolean;
  skinId: number;
  boosting: boolean;
  speed: number;
  name: string;
  isBot: boolean;
  kills: number;
  valueUsdc: number;
  // Server target positions for interpolation
  serverHeadX: number;
  serverHeadY: number;
  serverSegments: { x: number; y: number }[];
}

// Food colors (bright like slither.io)
const FOOD_COLORS = [
  "#FF0000", "#FFFF00", "#00FF00", "#FF00FF",
  "#FFFFFF", "#00FFFF", "#7FFF00", "#FFCC00",
];

const NUM_BODY_SKINS = 13;

// ─── GameRenderer Class ─────────────────────────────

export class GameRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private room: Colyseus.Room;
  private mySessionId: string;
  private animFrame: number = 0;
  private destroyed: boolean = false;

  // Camera
  private camX: number = 0;
  private camY: number = 0;
  private bgOffsetX: number = 0;
  private bgOffsetY: number = 0;

  // Local interpolated state
  private localSnakes: Map<string, LocalSnake> = new Map();
  private arenaRadius: number = 3000;

  // Assets
  private bgImage: HTMLImageElement | null = null;
  private headImage: HTMLImageElement | null = null;
  private bodyImages: HTMLImageElement[] = [];
  private assetsLoaded: boolean = false;

  // Input
  private mouseX: number = 0;
  private mouseY: number = 0;
  private mouseDown: boolean = false;
  private inputThrottle: number = 0;

  // Callbacks
  public onDeath?: (data: any) => void;
  public onCashout?: (data: any) => void;
  public onStatsUpdate?: (stats: { kills: number; value: number; alive: number }) => void;

  constructor(container: HTMLDivElement, room: Colyseus.Room) {
    this.room = room;
    this.mySessionId = room.sessionId;

    // Create canvas
    this.canvas = document.createElement("canvas");
    this.canvas.width = window.innerWidth;
    this.canvas.height = window.innerHeight;
    this.canvas.style.display = "block";
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext("2d")!;

    this.loadAssets();
    this.setupListeners();
    this.setupInput();
    this.loop();
  }

  // ─── Asset Loading ────────────────────────────────

  private loadAssets() {
    let loaded = 0;
    const total = 2 + NUM_BODY_SKINS;

    const onLoad = () => {
      loaded++;
      if (loaded >= total) this.assetsLoaded = true;
    };

    // Background hex map
    this.bgImage = new Image();
    this.bgImage.onload = onLoad;
    this.bgImage.src = "/assets/Map2.png";

    // Snake head
    this.headImage = new Image();
    this.headImage.onload = onLoad;
    this.headImage.src = "/assets/head.png";

    // Body skins (0..12)
    for (let i = 0; i < NUM_BODY_SKINS; i++) {
      const img = new Image();
      img.onload = onLoad;
      img.src = `/assets/body/${i}.png`;
      this.bodyImages.push(img);
    }
  }

  // ─── Colyseus State Sync ──────────────────────────

  private setupListeners() {
    this.room.state.snakes.onAdd((snake: any, key: string) => {
      const segs: { x: number; y: number }[] = [];
      if (snake.segments) {
        for (let i = 0; i < snake.segments.length; i++) {
          segs.push({ x: snake.segments[i].x, y: snake.segments[i].y });
        }
      }

      this.localSnakes.set(key, {
        segments: segs.map(s => ({ ...s })),
        headX: snake.headX,
        headY: snake.headY,
        angle: snake.angle,
        targetAngle: snake.angle,
        length: snake.length,
        alive: snake.alive,
        skinId: snake.skinId || 0,
        boosting: snake.boosting || false,
        speed: snake.speed || 0,
        name: snake.name || key.slice(0, 8),
        isBot: snake.isBot || false,
        kills: snake.kills || 0,
        valueUsdc: snake.valueUsdc || 0,
        serverHeadX: snake.headX,
        serverHeadY: snake.headY,
        serverSegments: segs.map(s => ({ ...s })),
      });

      snake.onChange(() => {
        const local = this.localSnakes.get(key);
        if (!local) return;

        // Set server targets (don't snap — interpolate in render loop)
        local.serverHeadX = snake.headX;
        local.serverHeadY = snake.headY;
        local.targetAngle = snake.angle;
        local.length = snake.length;
        local.alive = snake.alive;
        local.skinId = snake.skinId;
        local.boosting = snake.boosting;
        local.speed = snake.speed;
        local.kills = snake.kills;
        local.valueUsdc = snake.valueUsdc;

        // Update server segment targets
        local.serverSegments = [];
        if (snake.segments) {
          for (let i = 0; i < snake.segments.length; i++) {
            local.serverSegments.push({ x: snake.segments[i].x, y: snake.segments[i].y });
          }
        }
      });
    });

    this.room.state.snakes.onRemove((_: any, key: string) => {
      this.localSnakes.delete(key);
    });

    this.room.state.listen("arenaRadius", (value: number) => {
      this.arenaRadius = value;
    });

    this.room.onMessage("death", (data: any) => {
      this.onDeath?.(data);
    });

    this.room.onMessage("cashout_success", (data: any) => {
      this.onCashout?.(data);
    });
  }

  // ─── Input ────────────────────────────────────────

  private setupInput() {
    const onResize = () => {
      this.canvas.width = window.innerWidth;
      this.canvas.height = window.innerHeight;
    };
    window.addEventListener("resize", onResize);

    this.canvas.addEventListener("mousemove", (e) => {
      this.mouseX = e.clientX;
      this.mouseY = e.clientY;
      this.sendInput();
    });

    this.canvas.addEventListener("mousedown", () => {
      this.mouseDown = true;
      this.sendInput();
    });

    this.canvas.addEventListener("mouseup", () => {
      this.mouseDown = false;
      this.sendInput();
    });

    // Touch support
    this.canvas.addEventListener("touchmove", (e) => {
      e.preventDefault();
      this.mouseX = e.touches[0].clientX;
      this.mouseY = e.touches[0].clientY;
      this.sendInput();
    }, { passive: false });

    this.canvas.addEventListener("touchstart", (e) => {
      this.mouseDown = true;
      this.mouseX = e.touches[0].clientX;
      this.mouseY = e.touches[0].clientY;
      this.sendInput();
    });

    this.canvas.addEventListener("touchend", () => {
      this.mouseDown = false;
      this.sendInput();
    });
  }

  private sendInput() {
    const now = Date.now();
    if (now < this.inputThrottle) return;
    this.inputThrottle = now + 33; // ~30/sec

    // Mouse position relative to screen center = direction
    const cx = this.canvas.width / 2;
    const cy = this.canvas.height / 2;
    const dx = this.mouseX - cx;
    const dy = this.mouseY - cy;
    const angle = Math.atan2(dy, dx);

    this.room.send("input", { angle, boost: this.mouseDown });
  }

  // ─── Main Loop ────────────────────────────────────

  private loop = () => {
    if (this.destroyed) return;
    this.update();
    this.draw();
    this.animFrame = requestAnimationFrame(this.loop);
  };

  private update() {
    // Interpolate all snakes toward server state
    for (const [id, snake] of this.localSnakes) {
      if (!snake.alive) continue;

      // Lerp head toward server position
      snake.headX += (snake.serverHeadX - snake.headX) * 0.25;
      snake.headY += (snake.serverHeadY - snake.headY) * 0.25;

      // Smooth angle rotation
      let angleDiff = snake.targetAngle - snake.angle;
      while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
      while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;
      snake.angle += angleDiff * 0.2;

      // Match segment array length to server
      while (snake.segments.length < snake.serverSegments.length) {
        const last = snake.segments[snake.segments.length - 1] || { x: snake.headX, y: snake.headY };
        snake.segments.push({ x: last.x, y: last.y });
      }
      while (snake.segments.length > snake.serverSegments.length && snake.segments.length > 0) {
        snake.segments.pop();
      }

      // Set head segment to head position
      if (snake.segments.length > 0) {
        snake.segments[0].x = snake.headX;
        snake.segments[0].y = snake.headY;
      }

      // Reference-style segment following: each segment chases the one ahead
      // This is the key to smooth worm-like movement (from snake.js lines 70-77)
      const segSpacing = this.getSnakeSize(snake) / 5;
      for (let i = 1; i < snake.segments.length; i++) {
        const prev = snake.segments[i - 1];
        const curr = snake.segments[i];

        // Also lerp toward server target
        if (i < snake.serverSegments.length) {
          curr.x += (snake.serverSegments[i].x - curr.x) * 0.15;
          curr.y += (snake.serverSegments[i].y - curr.y) * 0.15;
        }

        // Chain following — if too far from previous segment, snap closer
        const dx = curr.x - prev.x;
        const dy = curr.y - prev.y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist > segSpacing) {
          // Double-averaging like the reference for extra smoothness
          curr.x = (curr.x + prev.x) / 2;
          curr.y = (curr.y + prev.y) / 2;
          curr.x = (curr.x + prev.x) / 2;
          curr.y = (curr.y + prev.y) / 2;
        }
      }
    }

    // Smooth camera follow on our snake
    const me = this.localSnakes.get(this.mySessionId);
    if (me && me.alive) {
      this.camX += (me.headX - this.camX) * 0.12;
      this.camY += (me.headY - this.camY) * 0.12;

      // Update stats
      this.onStatsUpdate?.({
        kills: me.kills,
        value: me.valueUsdc / 1_000_000,
        alive: this.room.state.aliveCount || 0,
      });
    }
  }

  // ─── Drawing ──────────────────────────────────────

  private draw() {
    const W = this.canvas.width;
    const H = this.canvas.height;
    const ctx = this.ctx;

    ctx.clearRect(0, 0, W, H);

    // ─── Hex Background (tiled/scrolling like reference) ────
    if (this.bgImage && this.assetsLoaded) {
      const bgW = this.bgImage.width;
      const bgH = this.bgImage.height;

      // Scroll background with camera (parallax)
      const srcX = ((this.camX * 0.8) % bgW + bgW) % bgW;
      const srcY = ((this.camY * 0.8) % bgH + bgH) % bgH;

      // Tile the background to cover the entire screen
      // We need to draw up to 4 tiles to handle wrapping
      for (let ox = -1; ox <= 1; ox++) {
        for (let oy = -1; oy <= 1; oy++) {
          ctx.drawImage(
            this.bgImage,
            -srcX + ox * bgW,
            -srcY + oy * bgH,
            bgW,
            bgH
          );
        }
      }
    } else {
      // Fallback dark background
      ctx.fillStyle = "#0a0a1a";
      ctx.fillRect(0, 0, W, H);
    }

    // ─── Arena Boundary ─────────────────────────────
    this.drawBoundary(ctx, W, H);

    // ─── Food ───────────────────────────────────────
    this.drawFood(ctx, W, H);

    // ─── Snakes (back to front, our snake last) ─────
    const sortedIds: string[] = [];
    for (const [id] of this.localSnakes) {
      if (id !== this.mySessionId) sortedIds.push(id);
    }
    if (this.localSnakes.has(this.mySessionId)) {
      sortedIds.push(this.mySessionId);
    }

    for (const id of sortedIds) {
      const snake = this.localSnakes.get(id);
      if (snake && snake.alive) {
        this.drawSnake(ctx, snake, W, H, id === this.mySessionId);
      }
    }

    // ─── Snake Names ────────────────────────────────
    for (const id of sortedIds) {
      const snake = this.localSnakes.get(id);
      if (snake && snake.alive) {
        this.drawSnakeName(ctx, snake, W, H);
      }
    }
  }

  // ─── World-to-Screen ──────────────────────────────

  private toScreenX(worldX: number): number {
    return worldX - this.camX + this.canvas.width / 2;
  }

  private toScreenY(worldY: number): number {
    return worldY - this.camY + this.canvas.height / 2;
  }

  private isOnScreen(wx: number, wy: number, margin: number = 100): boolean {
    const sx = this.toScreenX(wx);
    const sy = this.toScreenY(wy);
    return sx > -margin && sx < this.canvas.width + margin &&
           sy > -margin && sy < this.canvas.height + margin;
  }

  private getSnakeSize(snake: LocalSnake): number {
    // Scale size with length like the reference
    const baseSize = 30;
    const scale = Math.pow(snake.length / 50, 0.2);
    return baseSize * Math.min(2.0, scale);
  }

  // ─── Snake Drawing ────────────────────────────────

  private drawSnake(ctx: CanvasRenderingContext2D, snake: LocalSnake, W: number, H: number, isMe: boolean) {
    if (snake.segments.length < 2) return;

    const size = this.getSnakeSize(snake);
    const bodyImg = this.bodyImages[snake.skinId % this.bodyImages.length];

    // Draw body segments back-to-front (tail first)
    for (let i = snake.segments.length - 1; i >= 1; i--) {
      const seg = snake.segments[i];
      const sx = this.toScreenX(seg.x);
      const sy = this.toScreenY(seg.y);

      // Cull off-screen segments
      if (sx < -size || sx > W + size || sy < -size || sy > H + size) continue;

      // Taper toward tail
      const t = i / snake.segments.length;
      const segSize = size * (0.5 + t * 0.5);

      // Draw body sprite (like reference snake.js line 96)
      if (bodyImg && bodyImg.complete) {
        ctx.drawImage(
          bodyImg,
          sx - segSize / 2,
          sy - segSize / 2,
          segSize,
          segSize
        );
      }
    }

    // Draw head (rotated to movement angle, like reference snake.js lines 98-103)
    const headSx = this.toScreenX(snake.headX);
    const headSy = this.toScreenY(snake.headY);
    const headSize = size * 1.3;

    if (this.headImage && this.headImage.complete) {
      ctx.save();
      ctx.translate(headSx, headSy);
      ctx.rotate(snake.angle - Math.PI / 2); // Adjust for head sprite orientation
      ctx.drawImage(
        this.headImage,
        -headSize / 2,
        -headSize / 2,
        headSize,
        headSize
      );
      ctx.restore();
    }

    // Boost glow effect
    if (snake.boosting && isMe) {
      const gradient = ctx.createRadialGradient(headSx, headSy, 0, headSx, headSy, headSize * 3);
      gradient.addColorStop(0, "rgba(255, 255, 100, 0.15)");
      gradient.addColorStop(1, "rgba(255, 255, 100, 0)");
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(headSx, headSy, headSize * 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private drawSnakeName(ctx: CanvasRenderingContext2D, snake: LocalSnake, W: number, H: number) {
    const sx = this.toScreenX(snake.headX);
    const sy = this.toScreenY(snake.headY);
    const size = this.getSnakeSize(snake);

    if (sx < -100 || sx > W + 100 || sy < -100 || sy > H + 100) return;

    ctx.font = "bold 13px Arial, sans-serif";
    ctx.textAlign = "center";
    ctx.strokeStyle = "#000000";
    ctx.lineWidth = 3;
    ctx.strokeText(snake.name, sx, sy - size * 0.8);
    ctx.fillStyle = "#ffffff";
    ctx.fillText(snake.name, sx, sy - size * 0.8);
  }

  // ─── Food Drawing ─────────────────────────────────

  private drawFood(ctx: CanvasRenderingContext2D, W: number, H: number) {
    const time = Date.now();

    this.room.state.food.forEach((food: any) => {
      const sx = this.toScreenX(food.x);
      const sy = this.toScreenY(food.y);

      // Cull off-screen
      if (sx < -20 || sx > W + 20 || sy < -20 || sy > H + 20) return;

      const isDeath = food.size === 2;
      const baseSize = isDeath ? 8 : 4;
      const pulse = 1 + Math.sin(time / 400 + food.x * 0.1 + food.y * 0.1) * 0.2;
      const r = baseSize * pulse;

      // Stable color based on position
      const colorIdx = Math.abs(Math.floor(food.x * 7 + food.y * 13)) % FOOD_COLORS.length;
      const color = FOOD_COLORS[colorIdx];

      // Outer glow (like reference food.js but with halo)
      const gradient = ctx.createRadialGradient(sx, sy, 0, sx, sy, r * 3);
      gradient.addColorStop(0, color);
      gradient.addColorStop(0.4, color + "66");
      gradient.addColorStop(1, color + "00");
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(sx, sy, r * 3, 0, Math.PI * 2);
      ctx.fill();

      // Core orb
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  // ─── Arena Boundary ───────────────────────────────

  private drawBoundary(ctx: CanvasRenderingContext2D, W: number, H: number) {
    const cx = this.toScreenX(0);
    const cy = this.toScreenY(0);

    // Only draw if boundary is visible on screen
    const radius = this.arenaRadius;
    if (cx + radius < -100 || cx - radius > W + 100 || cy + radius < -100 || cy - radius > H + 100) return;

    // Outer glow
    ctx.strokeStyle = "rgba(255, 0, 68, 0.15)";
    ctx.lineWidth = 10;
    ctx.beginPath();
    ctx.arc(cx, cy, radius + 10, 0, Math.PI * 2);
    ctx.stroke();

    // Main boundary
    ctx.strokeStyle = "rgba(255, 0, 68, 0.5)";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.stroke();

    // Inner warning
    ctx.strokeStyle = "rgba(255, 0, 68, 0.12)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, radius * 0.95, 0, Math.PI * 2);
    ctx.stroke();
  }

  // ─── Cleanup ──────────────────────────────────────

  destroy() {
    this.destroyed = true;
    cancelAnimationFrame(this.animFrame);
    this.room.leave();
    this.canvas.remove();
  }
}
