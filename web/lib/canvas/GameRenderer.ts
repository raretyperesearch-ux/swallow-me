import * as Colyseus from "colyseus.js";

// ─── Types ──────────────────────────────────────────

interface LocalSnake {
  // Client-generated body segments (follow-the-leader)
  segments: { x: number; y: number }[];
  // Interpolated head
  headX: number;
  headY: number;
  angle: number;
  // Server targets
  serverHeadX: number;
  serverHeadY: number;
  serverAngle: number;
  serverSpeed: number;
  serverLength: number;
  // Metadata
  alive: boolean;
  skinId: number;
  boosting: boolean;
  name: string;
  isBot: boolean;
  kills: number;
  valueUsdc: number;
}

// Segment spacing — must match server SEGMENT_SPACING
const SEGMENT_SPACING = 4;

// Food colors
const FOOD_COLORS = [
  "#FF0000", "#FFFF00", "#00FF00", "#FF00FF",
  "#FFFFFF", "#00FFFF", "#7FFF00", "#FFCC00",
];

const NUM_BODY_SKINS = 13;

// ─── GameRenderer ───────────────────────────────────

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

  // Local state
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

  // ─── Assets ───────────────────────────────────────

  private loadAssets() {
    let loaded = 0;
    const total = 2 + NUM_BODY_SKINS;
    const onLoad = () => { loaded++; if (loaded >= total) this.assetsLoaded = true; };

    this.bgImage = new Image();
    this.bgImage.onload = onLoad;
    this.bgImage.src = "/assets/Map2.png";

    this.headImage = new Image();
    this.headImage.onload = onLoad;
    this.headImage.src = "/assets/head.png";

    for (let i = 0; i < NUM_BODY_SKINS; i++) {
      const img = new Image();
      img.onload = onLoad;
      img.src = `/assets/body/${i}.png`;
      this.bodyImages.push(img);
    }
  }

  // ─── Colyseus Sync (head + metadata only, NO segments) ──

  private setupListeners() {
    this.room.state.snakes.onAdd((snake: any, key: string) => {
      // Initialize local segments behind the head position
      const segs: { x: number; y: number }[] = [];
      const len = snake.length || 50;
      const angle = snake.angle || 0;
      for (let i = 0; i < len; i++) {
        segs.push({
          x: snake.headX - Math.cos(angle) * i * SEGMENT_SPACING,
          y: snake.headY - Math.sin(angle) * i * SEGMENT_SPACING,
        });
      }

      this.localSnakes.set(key, {
        segments: segs,
        headX: snake.headX,
        headY: snake.headY,
        angle: snake.angle,
        serverHeadX: snake.headX,
        serverHeadY: snake.headY,
        serverAngle: snake.angle,
        serverSpeed: snake.speed || 0,
        serverLength: snake.length || 50,
        alive: snake.alive,
        skinId: snake.skinId || 0,
        boosting: snake.boosting || false,
        name: snake.name || key.slice(0, 8),
        isBot: snake.isBot || false,
        kills: snake.kills || 0,
        valueUsdc: snake.valueUsdc || 0,
      });

      snake.onChange(() => {
        const local = this.localSnakes.get(key);
        if (!local) return;
        local.serverHeadX = snake.headX;
        local.serverHeadY = snake.headY;
        local.serverAngle = snake.angle;
        local.serverSpeed = snake.speed;
        local.serverLength = snake.length;
        local.alive = snake.alive;
        local.skinId = snake.skinId;
        local.boosting = snake.boosting;
        local.kills = snake.kills;
        local.valueUsdc = snake.valueUsdc;
      });
    });

    this.room.state.snakes.onRemove((_: any, key: string) => {
      this.localSnakes.delete(key);
    });

    this.room.state.listen("arenaRadius", (value: number) => {
      this.arenaRadius = value;
    });

    this.room.onMessage("death", (data: any) => { this.onDeath?.(data); });
    this.room.onMessage("cashout_success", (data: any) => { this.onCashout?.(data); });
  }

  // ─── Input ────────────────────────────────────────

  private setupInput() {
    window.addEventListener("resize", () => {
      this.canvas.width = window.innerWidth;
      this.canvas.height = window.innerHeight;
    });

    this.canvas.addEventListener("mousemove", (e) => {
      this.mouseX = e.clientX;
      this.mouseY = e.clientY;
      this.sendInput();
    });
    this.canvas.addEventListener("mousedown", () => { this.mouseDown = true; this.sendInput(); });
    this.canvas.addEventListener("mouseup", () => { this.mouseDown = false; this.sendInput(); });

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
    this.canvas.addEventListener("touchend", () => { this.mouseDown = false; this.sendInput(); });
  }

  private sendInput() {
    const now = Date.now();
    if (now < this.inputThrottle) return;
    this.inputThrottle = now + 33;

    const cx = this.canvas.width / 2;
    const cy = this.canvas.height / 2;
    const angle = Math.atan2(this.mouseY - cy, this.mouseX - cx);
    this.room.send("input", { angle, boost: this.mouseDown });
  }

  // ─── Main Loop ────────────────────────────────────

  private loop = () => {
    if (this.destroyed) return;
    this.update();
    this.draw();
    this.animFrame = requestAnimationFrame(this.loop);
  };

  private inputAngle: number = 0;

  private update() {
    // Compute current input angle for client-side prediction
    const cx = this.canvas.width / 2;
    const cy = this.canvas.height / 2;
    this.inputAngle = Math.atan2(this.mouseY - cy, this.mouseX - cx);

    for (const [id, snake] of this.localSnakes) {
      if (!snake.alive) continue;

      const isMe = id === this.mySessionId;

      if (isMe) {
        // Client-side prediction: move head immediately based on input
        const speed = snake.serverSpeed || 4.5;
        snake.headX += Math.cos(this.inputAngle) * speed;
        snake.headY += Math.sin(this.inputAngle) * speed;
        // Correct toward server position
        snake.headX += (snake.serverHeadX - snake.headX) * 0.15;
        snake.headY += (snake.serverHeadY - snake.headY) * 0.15;
      } else {
        // Other snakes: lerp toward server position
        snake.headX += (snake.serverHeadX - snake.headX) * 0.25;
        snake.headY += (snake.serverHeadY - snake.headY) * 0.25;
      }

      // 2. Smooth angle rotation
      const targetAngle = isMe ? this.inputAngle : snake.serverAngle;
      let angleDiff = targetAngle - snake.angle;
      while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
      while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;
      snake.angle += angleDiff * 0.2;

      // 3. Set first segment to head
      if (snake.segments.length > 0) {
        snake.segments[0].x = snake.headX;
        snake.segments[0].y = snake.headY;
      }

      // 4. Follow-the-leader: each segment lerps toward the one ahead
      const LERP_RATE = 0.35;
      for (let i = 1; i < snake.segments.length; i++) {
        const prev = snake.segments[i - 1];
        const curr = snake.segments[i];
        const dx = curr.x - prev.x;
        const dy = curr.y - prev.y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist > SEGMENT_SPACING) {
          curr.x += (prev.x - curr.x) * LERP_RATE;
          curr.y += (prev.y - curr.y) * LERP_RATE;
        }
      }

      // 5. Grow/shrink segments to match server length
      const targetLen = snake.serverLength;
      while (snake.segments.length < targetLen) {
        const last = snake.segments[snake.segments.length - 1];
        snake.segments.push({ x: last.x, y: last.y });
      }
      while (snake.segments.length > targetLen && snake.segments.length > 2) {
        snake.segments.pop();
      }
    }

    // Smooth camera follow
    const me = this.localSnakes.get(this.mySessionId);
    if (me && me.alive) {
      this.camX += (me.headX - this.camX) * 0.12;
      this.camY += (me.headY - this.camY) * 0.12;

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

    // Background
    if (this.bgImage && this.assetsLoaded) {
      const bgW = this.bgImage.width;
      const bgH = this.bgImage.height;
      const srcX = ((this.camX * 0.8) % bgW + bgW) % bgW;
      const srcY = ((this.camY * 0.8) % bgH + bgH) % bgH;
      for (let ox = -1; ox <= 1; ox++) {
        for (let oy = -1; oy <= 1; oy++) {
          ctx.drawImage(this.bgImage, -srcX + ox * bgW, -srcY + oy * bgH, bgW, bgH);
        }
      }
    } else {
      ctx.fillStyle = "#0a0a1a";
      ctx.fillRect(0, 0, W, H);
    }

    // Boundary
    this.drawBoundary(ctx, W, H);

    // Food (only render what's on screen)
    this.drawFood(ctx, W, H);

    // Snakes (our snake drawn last = on top)
    const sortedIds: string[] = [];
    for (const [id] of this.localSnakes) {
      if (id !== this.mySessionId) sortedIds.push(id);
    }
    if (this.localSnakes.has(this.mySessionId)) sortedIds.push(this.mySessionId);

    for (const id of sortedIds) {
      const snake = this.localSnakes.get(id)!;
      if (snake.alive) {
        this.drawSnake(ctx, snake, W, H, id === this.mySessionId);
        this.drawSnakeName(ctx, snake, W, H);
      }
    }
  }

  // ─── Helpers ──────────────────────────────────────

  private toScreenX(wx: number): number { return wx - this.camX + this.canvas.width / 2; }
  private toScreenY(wy: number): number { return wy - this.camY + this.canvas.height / 2; }

  private getSnakeSize(snake: LocalSnake): number {
    // Uniform body size, scales up slightly with length
    const baseSize = 28;
    const scale = Math.pow(snake.serverLength / 50, 0.2);
    return baseSize * Math.min(2.0, scale);
  }

  // ─── Snake Drawing ────────────────────────────────

  private drawSnake(ctx: CanvasRenderingContext2D, snake: LocalSnake, W: number, H: number, isMe: boolean) {
    if (snake.segments.length < 2) return;

    const size = this.getSnakeSize(snake);
    const bodyImg = this.bodyImages[snake.skinId % this.bodyImages.length];

    // Body segments back-to-front — UNIFORM size (no taper)
    for (let i = snake.segments.length - 1; i >= 1; i--) {
      const seg = snake.segments[i];
      const sx = this.toScreenX(seg.x);
      const sy = this.toScreenY(seg.y);

      if (sx < -size || sx > W + size || sy < -size || sy > H + size) continue;

      if (bodyImg && bodyImg.complete) {
        ctx.drawImage(bodyImg, sx - size / 2, sy - size / 2, size, size);
      }
    }

    // Head (rotated to movement angle)
    const headSx = this.toScreenX(snake.headX);
    const headSy = this.toScreenY(snake.headY);
    const headSize = size * 1.3;

    if (this.headImage && this.headImage.complete) {
      ctx.save();
      ctx.translate(headSx, headSy);
      ctx.rotate(snake.angle - Math.PI / 2);
      ctx.drawImage(this.headImage, -headSize / 2, -headSize / 2, headSize, headSize);
      ctx.restore();
    }

    // Boost glow
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

  // ─── Food (only render on-screen) ─────────────────

  private drawFood(ctx: CanvasRenderingContext2D, W: number, H: number) {
    const time = Date.now();

    this.room.state.food.forEach((food: any) => {
      const sx = this.toScreenX(food.x);
      const sy = this.toScreenY(food.y);

      // Viewport culling
      if (sx < -20 || sx > W + 20 || sy < -20 || sy > H + 20) return;

      const isDeath = food.size === 2;
      const baseSize = isDeath ? 8 : 4;
      const pulse = 1 + Math.sin(time / 400 + food.x * 0.1 + food.y * 0.1) * 0.2;
      const r = baseSize * pulse;

      const colorIdx = Math.abs(Math.floor(food.x * 7 + food.y * 13)) % FOOD_COLORS.length;
      const color = FOOD_COLORS[colorIdx];

      // Glow halo
      const gradient = ctx.createRadialGradient(sx, sy, 0, sx, sy, r * 3);
      gradient.addColorStop(0, color);
      gradient.addColorStop(0.4, color + "66");
      gradient.addColorStop(1, color + "00");
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(sx, sy, r * 3, 0, Math.PI * 2);
      ctx.fill();

      // Core
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  // ─── Boundary ─────────────────────────────────────

  private drawBoundary(ctx: CanvasRenderingContext2D, W: number, H: number) {
    const cx = this.toScreenX(0);
    const cy = this.toScreenY(0);
    const radius = this.arenaRadius;

    if (cx + radius < -100 || cx - radius > W + 100 || cy + radius < -100 || cy - radius > H + 100) return;

    ctx.strokeStyle = "rgba(255, 0, 68, 0.15)";
    ctx.lineWidth = 10;
    ctx.beginPath();
    ctx.arc(cx, cy, radius + 10, 0, Math.PI * 2);
    ctx.stroke();

    ctx.strokeStyle = "rgba(255, 0, 68, 0.5)";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.stroke();

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
