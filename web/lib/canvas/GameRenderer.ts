import * as Colyseus from "colyseus.js";

// ─── Types ──────────────────────────────────────────

interface LocalSnake {
  segments: { x: number; y: number }[];
  headX: number;
  headY: number;
  angle: number;
  serverHeadX: number;
  serverHeadY: number;
  serverAngle: number;
  serverSpeed: number;
  serverLength: number;
  alive: boolean;
  skinId: number;
  boosting: boolean;
  name: string;
  isBot: boolean;
  kills: number;
  valueUsdc: number;
}

interface DeathParticle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  color: string;
  life: number;
  size: number;
}

interface BoostParticle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  color: string;
  life: number;
  size: number;
}

interface EatPopup {
  x: number;
  y: number;
  life: number;
  text: string;
}

interface KillFeedItem {
  killerName: string;
  victimName: string;
  amount: number;
  timestamp: number;
}

const SEGMENT_SPACING = 4;

const FOOD_COLORS = [
  "#FF3333", "#FFFF44", "#33FF55", "#FF44FF",
  "#FFFFFF", "#44FFFF", "#88FF22", "#FFDD22",
];

const NUM_BODY_SKINS = 13;

// Multi-color skin palettes for alternating body bands
const SKIN_PALETTES: string[][] = [
  ["#4488ff", "#66aaff", "#ffffff", "#66aaff"],  // blue
  ["#ff4466", "#ff6688", "#ffaacc", "#ff6688"],  // pink
  ["#44ff66", "#88ff88", "#ffffff", "#88ff88"],  // green
  ["#ffaa00", "#ffcc44", "#ffffff", "#ffcc44"],  // gold
  ["#ff0000", "#ff8800", "#ffff00", "#00ff00", "#0088ff", "#8800ff"], // rainbow
  ["#ff44ff", "#ff88ff", "#ffffff", "#ff88ff"],  // magenta
  ["#00ffff", "#44ffff", "#ffffff", "#44ffff"],  // cyan
  ["#ff6600", "#ff8844", "#ffcc88", "#ff8844"],  // orange
  ["#aa44ff", "#cc88ff", "#ffffff", "#cc88ff"],  // purple
  ["#ff4444", "#44ff44", "#4444ff", "#ffff44"],  // multi
];

function darkenColor(hex: string, factor: number): string {
  const r = Math.max(0, Math.floor(parseInt(hex.slice(1, 3), 16) * (1 - factor)));
  const g = Math.max(0, Math.floor(parseInt(hex.slice(3, 5), 16) * (1 - factor)));
  const b = Math.max(0, Math.floor(parseInt(hex.slice(5, 7), 16) * (1 - factor)));
  return `rgb(${r},${g},${b})`;
}

function detectMobile(): boolean {
  return (
    navigator.maxTouchPoints > 0 ||
    "ontouchstart" in window ||
    /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
  );
}

// ─── Sound Engine (Web Audio oscillators, no files) ──

class GameAudio {
  private ctx: AudioContext | null = null;
  private boostOsc: OscillatorNode | null = null;
  private boostGain: GainNode | null = null;
  private _muted: boolean = false;

  get muted() { return this._muted; }

  private ensureCtx() {
    if (!this.ctx) {
      this.ctx = new AudioContext();
    }
    if (this.ctx.state === "suspended") {
      this.ctx.resume();
    }
    return this.ctx;
  }

  toggleMute() {
    this._muted = !this._muted;
    if (this._muted) this.stopBoost();
    return this._muted;
  }

  playEat() {
    if (this._muted) return;
    const ctx = this.ensureCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = 800;
    gain.gain.value = 0.08;
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.05);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.05);
  }

  playKill() {
    if (this._muted) return;
    const ctx = this.ensureCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(600, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(200, ctx.currentTime + 0.2);
    gain.gain.value = 0.12;
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.2);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.2);
  }

  playDeath() {
    if (this._muted) return;
    const ctx = this.ensureCtx();
    const len = ctx.sampleRate * 0.1;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * 0.3;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const gain = ctx.createGain();
    gain.gain.value = 0.15;
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.1);
    src.connect(gain).connect(ctx.destination);
    src.start();
  }

  startBoost() {
    if (this._muted || this.boostOsc) return;
    const ctx = this.ensureCtx();
    this.boostOsc = ctx.createOscillator();
    this.boostGain = ctx.createGain();
    this.boostOsc.type = "sine";
    this.boostOsc.frequency.value = 150;
    this.boostGain.gain.value = 0.06;
    this.boostOsc.connect(this.boostGain).connect(ctx.destination);
    this.boostOsc.start();
  }

  stopBoost() {
    if (this.boostOsc) {
      try { this.boostOsc.stop(); } catch {}
      this.boostOsc.disconnect();
      this.boostOsc = null;
    }
    if (this.boostGain) {
      this.boostGain.disconnect();
      this.boostGain = null;
    }
  }

  destroy() {
    this.stopBoost();
    if (this.ctx) {
      this.ctx.close();
      this.ctx = null;
    }
  }
}

// ─── Asset Preloader ────────────────────────────────

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

// ─── GameRenderer ───────────────────────────────────

export class GameRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private room: Colyseus.Room;
  private mySessionId: string;
  private animFrame: number = 0;
  private destroyed: boolean = false;

  // DPI
  private dpr: number = 1;
  private cssW: number = 0;
  private cssH: number = 0;

  // Camera
  private camX: number = 0;
  private camY: number = 0;

  // Local state
  private localSnakes: Map<string, LocalSnake> = new Map();
  private arenaRadius: number = 5000;
  private bgPattern: CanvasPattern | null = null;

  // Assets
  private bgImage: HTMLImageElement | null = null;
  private headImage: HTMLImageElement | null = null;
  private bodyImages: HTMLImageElement[] = [];
  private assetsLoaded: boolean = false;

  // Death particles
  private particles: DeathParticle[] = [];

  // Boost particles
  private boostParticles: BoostParticle[] = [];
  private boostFrameCounter: number = 0;

  // Eat popups (+1 text)
  private eatPopups: EatPopup[] = [];

  // Track food IDs eaten via broadcast for immediate removal
  private eatenFoodIds: Set<string> = new Set();

  // Kill feed
  private killFeed: KillFeedItem[] = [];

  // Sound
  private audio = new GameAudio();

  // Boost tracking (for sound)
  private wasBoosting: boolean = false;
  // Food count tracking (for eat sound)
  private lastFoodCount: number = -1;

  // FPS counter
  private lastFrameTime: number = 0;
  private fps: number = 0;
  private fpsFrames: number = 0;
  private fpsLastUpdate: number = 0;

  // Viewport reporting
  private lastViewportSend: number = 0;

  // Input
  private mouseX: number = 0;
  private mouseY: number = 0;
  private mouseDown: boolean = false;
  private inputAngle: number = 0;

  // Mobile detection
  private isMobile: boolean = false;
  private isTouchDevice: boolean = false;

  // Mobile joystick — floating, appears at touch point (direction ONLY)
  private joystickActive: boolean = false;
  private joystickCenterX: number = 0;
  private joystickCenterY: number = 0;
  private joystickKnobX: number = 0;
  private joystickKnobY: number = 0;
  private joystickTouchId: number | null = null;

  private readonly JOYSTICK_RADIUS = 60;
  private readonly KNOB_RADIUS = 25;
  private readonly DEAD_ZONE = 8;

  // Boost button (bottom-right, mobile)
  private boostTouchId: number | null = null;
  private touchBoosting: boolean = false;

  // Boost energy tracking
  private maxLengthReached: number = 40;

  // Input send throttle — only in render loop
  private lastInputSend: number = 0;
  private readonly INPUT_SEND_INTERVAL = 50;  // 20 sends/sec max

  // Loading
  private loadingProgress: number = 0;
  private loadingTotal: number = 2 + NUM_BODY_SKINS;
  private ready: boolean = false;
  private loadingSnakePhase: number = 0;

  // FPS cap for mobile
  private lastRenderTime: number = 0;
  private targetFrameInterval: number = 0; // 0 = uncapped

  // Callbacks
  public onDeath?: (data: any) => void;
  public onCashout?: (data: any) => void;
  public onStatsUpdate?: (stats: { kills: number; value: number; alive: number; length: number; muted: boolean }) => void;

  constructor(container: HTMLDivElement, room: Colyseus.Room) {
    this.room = room;
    this.mySessionId = room.sessionId;

    this.isMobile = detectMobile();
    this.isTouchDevice =
      navigator.maxTouchPoints > 0 ||
      "ontouchstart" in window;

    // Cap mobile to ~30fps
    if (this.isMobile) {
      this.targetFrameInterval = 1000 / 30;
    }

    this.canvas = document.createElement("canvas");
    this.canvas.style.display = "block";
    this.canvas.style.width = "100%";
    this.canvas.style.height = "100%";
    this.canvas.style.touchAction = "none";
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext("2d")!;

    this.resizeCanvas();
    this.setupInput();

    this.preloadAssets().then(() => {
      this.assetsLoaded = true;
      this.ready = true;
      if (this.bgImage) {
        this.bgPattern = this.ctx.createPattern(this.bgImage, "repeat");
      }
      this.setupListeners();
    });

    this.loop();
  }

  // ─── DPI-aware canvas sizing ────────────────────────

  private resizeCanvas() {
    this.dpr = window.devicePixelRatio || 1;
    // On mobile, cap DPR to 2 for performance
    if (this.isMobile && this.dpr > 2) {
      this.dpr = 2;
    }
    this.cssW = this.canvas.clientWidth || window.innerWidth;
    this.cssH = this.canvas.clientHeight || window.innerHeight;
    this.canvas.width = this.cssW * this.dpr;
    this.canvas.height = this.cssH * this.dpr;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.ctx.imageSmoothingEnabled = true;
    this.ctx.imageSmoothingQuality = this.isMobile ? "medium" : "high";
    if (this.bgImage && this.bgImage.complete) {
      this.bgPattern = this.ctx.createPattern(this.bgImage, "repeat");
    }
  }

  // ─── Asset Preloading ─────────────────────────────

  private async preloadAssets() {
    const bodyPaths = Array.from({ length: NUM_BODY_SKINS }, (_, i) => `/assets/body/${i}.png`);
    const allPaths = ["/assets/Map2.png", "/assets/head.png", ...bodyPaths];
    this.loadingTotal = allPaths.length;
    this.loadingProgress = 0;

    const results = await Promise.all(
      allPaths.map((src) =>
        loadImage(src).then((img) => {
          this.loadingProgress++;
          return img;
        }).catch(() => {
          this.loadingProgress++;
          return null;
        })
      )
    );

    this.bgImage = results[0];
    this.headImage = results[1];
    this.bodyImages = results.slice(2).filter((img): img is HTMLImageElement => img !== null);
  }

  // ─── Colyseus Sync ────────────────────────────────

  private setupListeners() {
    this.room.state.snakes.onAdd((snake: any, key: string) => {
      const segs: { x: number; y: number }[] = [];
      const len = snake.length || 40;
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
        serverLength: snake.length || 40,
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
      const snake = this.localSnakes.get(key);
      if (snake) {
        this.spawnDeathParticles(snake.headX, snake.headY, snake.skinId);
      }
      this.localSnakes.delete(key);
    });

    this.room.state.listen("arenaRadius", (value: number) => {
      this.arenaRadius = value;
    });

    // Kill feed from Colyseus state
    this.room.state.killFeed.onAdd((entry: any) => {
      this.killFeed.push({
        killerName: entry.killerName,
        victimName: entry.victimName,
        amount: entry.amount,
        timestamp: Date.now(),
      });
      const me = this.localSnakes.get(this.mySessionId);
      if (me && entry.killerName === me.name) {
        this.audio.playKill();
      }
      const maxFeed = this.isMobile ? 3 : 5;
      while (this.killFeed.length > maxFeed) this.killFeed.shift();
    });

    // Handle food_eaten broadcast for immediate client-side removal
    this.room.onMessage("food_eaten", (data: { ids: string[] }) => {
      this.audio.playEat();
      // Track eaten food IDs so drawFood skips them immediately
      for (const id of data.ids) {
        this.eatenFoodIds.add(id);
        // Spawn "+1" popup at food position (if we can find it in state)
        const food = this.room.state.food.get(id);
        if (food) {
          this.eatPopups.push({
            x: food.x,
            y: food.y,
            life: 1.0,
            text: "+1",
          });
        }
        // Auto-clear from tracking set after 2 seconds (state sync will have caught up)
        setTimeout(() => this.eatenFoodIds.delete(id), 2000);
      }
    });

    this.room.onMessage("death", (data: any) => {
      this.audio.playDeath();
      this.onDeath?.(data);
    });
    this.room.onMessage("cashout_success", (data: any) => { this.onCashout?.(data); });
  }

  // ─── Death Particles ──────────────────────────────

  private spawnDeathParticles(worldX: number, worldY: number, skinId: number) {
    const palette = SKIN_PALETTES[skinId % SKIN_PALETTES.length];
    for (let i = 0; i < 20; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 1 + Math.random() * 4;
      this.particles.push({
        x: worldX,
        y: worldY,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        color: palette[Math.floor(Math.random() * palette.length)],
        life: 1.0,
        size: 3 + Math.random() * 5,
      });
    }
  }

  private updateParticles() {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.x += p.vx;
      p.y += p.vy;
      p.vx *= 0.96;
      p.vy *= 0.96;
      p.life -= 1 / 60;
      if (p.life <= 0) {
        this.particles.splice(i, 1);
      }
    }
  }

  private drawParticles(ctx: CanvasRenderingContext2D, W: number, H: number) {
    for (const p of this.particles) {
      const sx = this.toScreenX(p.x);
      const sy = this.toScreenY(p.y);
      if (sx < -20 || sx > W + 20 || sy < -20 || sy > H + 20) continue;

      ctx.globalAlpha = Math.max(0, p.life);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(sx, sy, p.size * p.life, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1.0;
  }

  // ─── Boost Particles ──────────────────────────────

  private spawnBoostParticle(snake: LocalSnake) {
    if (snake.segments.length < 3) return;
    const tail = snake.segments[snake.segments.length - 1];
    const palette = SKIN_PALETTES[snake.skinId % SKIN_PALETTES.length];
    const angle = Math.random() * Math.PI * 2;
    const speed = 0.5 + Math.random() * 1.5;
    this.boostParticles.push({
      x: tail.x + (Math.random() - 0.5) * 8,
      y: tail.y + (Math.random() - 0.5) * 8,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      color: palette[Math.floor(Math.random() * palette.length)],
      life: 1.0,
      size: 2 + Math.random() * 4,
    });
  }

  private updateBoostParticles() {
    for (let i = this.boostParticles.length - 1; i >= 0; i--) {
      const p = this.boostParticles[i];
      p.x += p.vx;
      p.y += p.vy;
      p.vx *= 0.94;
      p.vy *= 0.94;
      p.life -= 1 / 30; // fade over ~30 frames
      p.size *= 0.97;
      if (p.life <= 0 || p.size < 0.5) {
        this.boostParticles.splice(i, 1);
      }
    }
  }

  private drawBoostParticles(ctx: CanvasRenderingContext2D, W: number, H: number) {
    if (this.boostParticles.length === 0) return;
    for (const p of this.boostParticles) {
      const sx = this.toScreenX(p.x);
      const sy = this.toScreenY(p.y);
      if (sx < -20 || sx > W + 20 || sy < -20 || sy > H + 20) continue;

      ctx.globalAlpha = Math.max(0, p.life * 0.8);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(sx, sy, p.size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1.0;
  }

  // ─── Eat Popups (+1 text) ──────────────────────────

  private updateEatPopups() {
    for (let i = this.eatPopups.length - 1; i >= 0; i--) {
      const p = this.eatPopups[i];
      p.life -= 1 / 30; // fade over ~0.5 seconds (30 frames at 60fps ≈ 0.5s)
      p.y -= 0.5; // float upward in world coords
      if (p.life <= 0) {
        this.eatPopups.splice(i, 1);
      }
    }
  }

  private drawEatPopups(ctx: CanvasRenderingContext2D, W: number, H: number) {
    if (this.eatPopups.length === 0) return;
    ctx.font = "bold 14px Arial, sans-serif";
    ctx.textAlign = "center";
    for (const p of this.eatPopups) {
      if (!this.isInView(p.x, p.y, 50)) continue;
      const sx = this.toScreenX(p.x);
      const sy = this.toScreenY(p.y);
      ctx.globalAlpha = Math.max(0, p.life);
      ctx.fillStyle = "#44ff44";
      ctx.strokeStyle = "#000000";
      ctx.lineWidth = 2;
      ctx.strokeText(p.text, sx, sy - 15);
      ctx.fillText(p.text, sx, sy - 15);
    }
    ctx.globalAlpha = 1.0;
  }

  // ─── Kill Feed Drawing ────────────────────────────

  private drawKillFeed(ctx: CanvasRenderingContext2D, W: number, H: number) {
    const now = Date.now();
    this.killFeed = this.killFeed.filter((e) => now - e.timestamp < 5000);
    if (this.killFeed.length === 0) return;

    // On mobile, position above joystick area (bottom-left, ~160px from bottom)
    const safeBottom = this.isMobile ? 160 : 20;
    const x = 15;
    let y = H - safeBottom;
    ctx.font = this.isMobile ? "10px Arial, sans-serif" : "12px Arial, sans-serif";
    ctx.textAlign = "left";

    for (let i = this.killFeed.length - 1; i >= 0; i--) {
      const entry = this.killFeed[i];
      const age = now - entry.timestamp;
      const alpha = Math.max(0, 1 - age / 5000);

      const text = `${entry.killerName} swallowed ${entry.victimName} +$${entry.amount.toFixed(2)}`;
      const metrics = ctx.measureText(text);
      const pw = metrics.width + 16;
      const ph = 22;

      ctx.globalAlpha = alpha * 0.7;
      ctx.fillStyle = "#000000";
      const pr = 6;
      ctx.beginPath();
      ctx.moveTo(x + pr, y - ph);
      ctx.lineTo(x + pw - pr, y - ph);
      ctx.quadraticCurveTo(x + pw, y - ph, x + pw, y - ph + pr);
      ctx.lineTo(x + pw, y - pr);
      ctx.quadraticCurveTo(x + pw, y, x + pw - pr, y);
      ctx.lineTo(x + pr, y);
      ctx.quadraticCurveTo(x, y, x, y - pr);
      ctx.lineTo(x, y - ph + pr);
      ctx.quadraticCurveTo(x, y - ph, x + pr, y - ph);
      ctx.closePath();
      ctx.fill();

      ctx.globalAlpha = alpha;
      ctx.fillStyle = "#ffffff";
      ctx.fillText(text, x + 8, y - 6);

      y -= ph + 4;
    }
    ctx.globalAlpha = 1.0;
  }

  // ─── Input ────────────────────────────────────────

  private setupInput() {
    window.addEventListener("resize", () => {
      this.resizeCanvas();
    });

    // --- DESKTOP MOUSE (only on non-touch devices) ---
    if (!this.isTouchDevice) {
      this.canvas.addEventListener("mousemove", (e) => {
        const cx = this.cssW / 2;
        const cy = this.cssH / 2;
        this.inputAngle = Math.atan2(e.clientY - cy, e.clientX - cx);
      });
      this.canvas.addEventListener("mousedown", () => {
        this.mouseDown = true;
      });
      this.canvas.addEventListener("mouseup", () => {
        this.mouseDown = false;
      });
    }

    // --- DESKTOP KEYBOARD (spacebar = boost) ---
    window.addEventListener("keydown", (e) => {
      if (e.code === "Space" || e.key === " ") {
        e.preventDefault();
        this.mouseDown = true;
      }
    });
    window.addEventListener("keyup", (e) => {
      if (e.code === "Space" || e.key === " ") {
        e.preventDefault();
        this.mouseDown = false;
      }
    });

    // --- TOUCH INPUT (multi-touch: joystick + boost button) ---
    if (this.isTouchDevice) {
      this.canvas.addEventListener("touchstart", (e) => {
        e.preventDefault();
        e.stopPropagation();
        for (let i = 0; i < e.changedTouches.length; i++) {
          const touch = e.changedTouches[i];
          const tx = touch.clientX;
          const ty = touch.clientY;

          // Check boost button first — hitbox is radius + 15px for easier tapping
          const btn = this.getBoostButtonCenter();
          const bdx = tx - btn.x;
          const bdy = ty - btn.y;
          const bDist = Math.sqrt(bdx * bdx + bdy * bdy);
          const hitRadius = btn.radius + 15;

          if (bDist < hitRadius && this.boostTouchId === null) {
            this.boostTouchId = touch.identifier;
            this.touchBoosting = true;
            continue;
          }

          // Also catch zone-based: bottom-right quadrant = boost
          if (tx > this.cssW * 0.7 && ty > this.cssH * 0.7 && this.boostTouchId === null) {
            this.boostTouchId = touch.identifier;
            this.touchBoosting = true;
            continue;
          }

          // Everything else = joystick (direction only)
          if (this.joystickTouchId === null) {
            this.joystickCenterX = tx;
            this.joystickCenterY = ty;
            this.joystickKnobX = tx;
            this.joystickKnobY = ty;
            this.joystickTouchId = touch.identifier;
            this.joystickActive = true;
          }
        }
      }, { passive: false });

      this.canvas.addEventListener("touchmove", (e) => {
        e.preventDefault();
        e.stopPropagation();
        for (let i = 0; i < e.changedTouches.length; i++) {
          const touch = e.changedTouches[i];
          if (touch.identifier === this.joystickTouchId) {
            this.handleJoystickMove(touch.clientX, touch.clientY);
          }
        }
      }, { passive: false });

      this.canvas.addEventListener("touchend", (e) => {
        e.preventDefault();
        e.stopPropagation();
        for (let i = 0; i < e.changedTouches.length; i++) {
          const tid = e.changedTouches[i].identifier;
          if (tid === this.joystickTouchId) {
            this.joystickActive = false;
            this.joystickTouchId = null;
          }
          if (tid === this.boostTouchId) {
            this.boostTouchId = null;
            this.touchBoosting = false;
          }
        }
      }, { passive: false });

      this.canvas.addEventListener("touchcancel", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.joystickActive = false;
        this.joystickTouchId = null;
        this.boostTouchId = null;
        this.touchBoosting = false;
      }, { passive: false });
    }
  }

  // ─── Joystick Logic (no separate canvas) ──────────

  private handleJoystickMove(touchX: number, touchY: number) {
    const dx = touchX - this.joystickCenterX;
    const dy = touchY - this.joystickCenterY;
    const dist = Math.sqrt(dx * dx + dy * dy);

    // Dead zone — ignore tiny movements
    if (dist < this.DEAD_ZONE) return;

    // Clamp knob to joystick radius
    if (dist > this.JOYSTICK_RADIUS) {
      this.joystickKnobX = this.joystickCenterX + (dx / dist) * this.JOYSTICK_RADIUS;
      this.joystickKnobY = this.joystickCenterY + (dy / dist) * this.JOYSTICK_RADIUS;
    } else {
      this.joystickKnobX = touchX;
      this.joystickKnobY = touchY;
    }

    // Update angle from center
    this.inputAngle = Math.atan2(dy, dx);

    // Joystick is direction ONLY — no boost from joystick
  }

  // Draw joystick on MAIN canvas in SCREEN coordinates (after all game rendering)
  private drawJoystick(ctx: CanvasRenderingContext2D) {
    if (!this.joystickActive) return;

    // Outer ring
    ctx.beginPath();
    ctx.arc(this.joystickCenterX, this.joystickCenterY, this.JOYSTICK_RADIUS, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(255, 255, 255, 0.2)";
    ctx.lineWidth = 3;
    ctx.stroke();

    // Inner knob — always white, no boost coloring
    ctx.beginPath();
    ctx.arc(this.joystickKnobX, this.joystickKnobY, this.KNOB_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255, 255, 255, 0.3)";
    ctx.fill();
    ctx.strokeStyle = "rgba(255, 255, 255, 0.5)";
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // ─── Boost Button (bottom-right, mobile) ──────────

  private getBoostButtonCenter(): { x: number; y: number; radius: number } {
    const isLandscape = this.cssW > this.cssH;
    const r = isLandscape ? 30 : 35;
    return {
      x: this.cssW - r - 20,
      y: this.cssH - r - 35,
      radius: r,
    };
  }

  private drawBoostButton(ctx: CanvasRenderingContext2D) {
    if (!this.isTouchDevice) return;

    const { x, y, radius } = this.getBoostButtonCenter();
    const me = this.localSnakes.get(this.mySessionId);
    const canBoost = me && me.alive && me.serverLength > 15;

    // Energy arc around the outside
    this.drawBoostEnergyArc(ctx, x, y, radius + 5);

    // Main circle
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    if (this.touchBoosting && canBoost) {
      ctx.fillStyle = "rgba(0, 255, 100, 0.2)";
      ctx.strokeStyle = "rgba(0, 255, 100, 0.8)";
    } else if (!canBoost) {
      ctx.fillStyle = "rgba(255, 50, 50, 0.1)";
      ctx.strokeStyle = "rgba(255, 50, 50, 0.4)";
    } else {
      ctx.fillStyle = "rgba(255, 255, 255, 0.05)";
      ctx.strokeStyle = "rgba(255, 255, 255, 0.3)";
    }
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.stroke();

    // Lightning bolt emoji
    ctx.font = `${Math.floor(radius * 0.7)}px Arial, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = this.touchBoosting && canBoost ? "#ffffff" : "rgba(255, 255, 255, 0.6)";
    ctx.fillText("\u26A1", x, y + 1);
    ctx.textBaseline = "alphabetic";
  }

  private drawBoostEnergyArc(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number) {
    const me = this.localSnakes.get(this.mySessionId);
    if (!me || !me.alive) return;

    const currentLen = me.serverLength;
    const minLen = 15;
    const maxLen = this.maxLengthReached;
    const available = Math.max(0, currentLen - minLen);
    const total = Math.max(1, maxLen - minLen);
    const pct = Math.min(1, available / total);

    if (pct <= 0) return;

    const startAngle = -Math.PI / 2;
    const endAngle = startAngle + Math.PI * 2 * pct;

    let arcColor: string;
    if (pct > 0.5) arcColor = "#22cc44";
    else if (pct > 0.2) arcColor = "#ddaa00";
    else arcColor = "#ff3333";

    ctx.beginPath();
    ctx.arc(cx, cy, r, startAngle, endAngle);
    ctx.strokeStyle = arcColor;
    ctx.lineWidth = 4;
    ctx.lineCap = "round";
    ctx.stroke();
    ctx.lineCap = "butt";
  }

  // Throttled input send — called from render loop, NOT from touch events
  private sendThrottledInput() {
    const now = Date.now();
    if (now - this.lastInputSend < this.INPUT_SEND_INTERVAL) return;
    this.lastInputSend = now;

    // Touch: boost button only. Desktop: mouseDown or spacebar (both set mouseDown)
    const boost = this.touchBoosting || this.mouseDown;
    this.room.send("input", { angle: this.inputAngle, boost });
  }

  // ─── Public: toggle mute ──────────────────────────

  public toggleMute(): boolean {
    return this.audio.toggleMute();
  }

  public isMuted(): boolean {
    return this.audio.muted;
  }

  // ─── Main Loop ────────────────────────────────────

  private loop = () => {
    if (this.destroyed) return;

    const now = performance.now();

    // FPS cap for mobile
    if (this.targetFrameInterval > 0) {
      const elapsed = now - this.lastRenderTime;
      if (elapsed < this.targetFrameInterval) {
        this.animFrame = requestAnimationFrame(this.loop);
        return;
      }
      this.lastRenderTime = now;
    }

    this.fpsFrames++;
    if (now - this.fpsLastUpdate > 1000) {
      this.fps = this.fpsFrames;
      this.fpsFrames = 0;
      this.fpsLastUpdate = now;
    }
    this.lastFrameTime = now;

    if (!this.ready) {
      this.drawLoadingScreen();
    } else {
      this.update();
      this.draw();
      // Draw touch controls on main canvas AFTER all game rendering (screen coords)
      if (this.isTouchDevice) {
        this.drawJoystick(this.ctx);
        this.drawBoostButton(this.ctx);
      }
      // Send input at throttled rate from render loop
      this.sendThrottledInput();
    }

    this.animFrame = requestAnimationFrame(this.loop);
  };

  // ─── Loading Screen ───────────────────────────────

  private drawLoadingScreen() {
    const W = this.cssW;
    const H = this.cssH;
    const ctx = this.ctx;

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#0a0a1a";
    ctx.fillRect(0, 0, W, H);

    // Animated snake wave icon
    this.loadingSnakePhase += 0.05;
    const snakeY = H / 2 - 80;
    const numDots = 8;
    const dotSpacing = 14;
    const startX = W / 2 - (numDots * dotSpacing) / 2;
    const waveAmplitude = 12;
    const snakeColors = SKIN_PALETTES[4]; // rainbow

    for (let i = 0; i < numDots; i++) {
      const x = startX + i * dotSpacing;
      const y = snakeY + Math.sin(this.loadingSnakePhase + i * 0.6) * waveAmplitude;
      const colorIdx = i % snakeColors.length;
      ctx.fillStyle = snakeColors[colorIdx];
      ctx.beginPath();
      ctx.arc(x, y, 6, 0, Math.PI * 2);
      ctx.fill();
    }

    // Title
    ctx.font = "bold 42px Arial, sans-serif";
    ctx.textAlign = "center";
    ctx.fillStyle = "#ffffff";
    ctx.fillText("SWALLOW ME", W / 2, H / 2 - 20);

    // Subtitle
    ctx.font = "14px Arial, sans-serif";
    ctx.fillStyle = "#666";
    ctx.fillText("Stake. Eat. Cash Out.", W / 2, H / 2 + 5);

    // Progress bar
    const barW = Math.min(300, W * 0.7);
    const barH = 6;
    const barX = (W - barW) / 2;
    const barY = H / 2 + 30;
    const progress = this.loadingTotal > 0 ? this.loadingProgress / this.loadingTotal : 0;

    ctx.fillStyle = "#222";
    ctx.beginPath();
    ctx.roundRect(barX, barY, barW, barH, 3);
    ctx.fill();

    // Gradient progress bar
    const gradient = ctx.createLinearGradient(barX, 0, barX + barW, 0);
    gradient.addColorStop(0, "#22c55e");
    gradient.addColorStop(1, "#4ade80");
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.roundRect(barX, barY, barW * progress, barH, 3);
    ctx.fill();

    ctx.font = "13px Arial, sans-serif";
    ctx.fillStyle = "#888";
    const statusText = progress < 1 ? "Loading assets..." : "Connecting to server...";
    ctx.fillText(statusText, W / 2, barY + 28);
  }

  // ─── Viewport culling helper ──────────────────────

  private isInView(wx: number, wy: number, margin: number = 200): boolean {
    const sx = wx - this.camX + this.cssW / 2;
    const sy = wy - this.camY + this.cssH / 2;
    return sx > -margin && sx < this.cssW + margin &&
           sy > -margin && sy < this.cssH + margin;
  }

  private update() {
    // inputAngle is already set by mouse/touch event handlers — no recalculation needed

    this.boostFrameCounter++;

    for (const [id, snake] of this.localSnakes) {
      if (!snake.alive) continue;
      const isMe = id === this.mySessionId;

      // --- CLIENT-SIDE PREDICTION ---
      if (isMe) {
        // Smooth angle toward mouse target
        let angleDiff = this.inputAngle - snake.angle;
        while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
        while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;
        snake.angle += angleDiff * 0.12; // smooth turning

        // Move head locally at predicted speed
        const speed = snake.boosting ? 8.0 : 4.0;
        snake.headX += Math.cos(snake.angle) * speed;
        snake.headY += Math.sin(snake.angle) * speed;

        // Blend toward server position to prevent drift
        snake.headX += (snake.serverHeadX - snake.headX) * 0.1;
        snake.headY += (snake.serverHeadY - snake.headY) * 0.1;

        // Boost sound
        if (snake.boosting && !this.wasBoosting) this.audio.startBoost();
        if (!snake.boosting && this.wasBoosting) this.audio.stopBoost();
        this.wasBoosting = snake.boosting;

        // Spawn boost particles every 3 frames
        if (snake.boosting && this.boostFrameCounter % 3 === 0) {
          this.spawnBoostParticle(snake);
        }
      } else {
        // Other players: lerp toward server position
        snake.headX += (snake.serverHeadX - snake.headX) * 0.2;
        snake.headY += (snake.serverHeadY - snake.headY) * 0.2;

        // Smooth angle for others
        const targetAngle = snake.serverAngle;
        let angleDiff = targetAngle - snake.angle;
        while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
        while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;
        snake.angle += angleDiff * 0.15;

        // Boost particles for others too (visible)
        if (snake.boosting && this.boostFrameCounter % 3 === 0 && this.isInView(snake.headX, snake.headY, 300)) {
          this.spawnBoostParticle(snake);
        }
      }

      // --- CHAIN CONSTRAINT (no gaps) ---
      // Head is segment 0
      if (snake.segments.length > 0) {
        snake.segments[0].x = snake.headX;
        snake.segments[0].y = snake.headY;
      }

      for (let i = 1; i < snake.segments.length; i++) {
        const prev = snake.segments[i - 1];
        const curr = snake.segments[i];
        const dx = curr.x - prev.x;
        const dy = curr.y - prev.y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist > SEGMENT_SPACING) {
          // HARD constraint — segment is EXACTLY spacing distance behind previous
          const angle = Math.atan2(dy, dx);
          curr.x = prev.x + Math.cos(angle) * SEGMENT_SPACING;
          curr.y = prev.y + Math.sin(angle) * SEGMENT_SPACING;
        }
      }

      // Grow/shrink to match server length
      const targetLen = snake.serverLength || 40;
      while (snake.segments.length < targetLen) {
        const last = snake.segments[snake.segments.length - 1];
        snake.segments.push({ x: last.x, y: last.y });
      }
      while (snake.segments.length > targetLen && snake.segments.length > 2) {
        snake.segments.pop();
      }
    }

    // Update particles
    this.updateParticles();
    this.updateBoostParticles();
    this.updateEatPopups();

    // Camera — smooth follow
    const me = this.localSnakes.get(this.mySessionId);
    if (me && me.alive) {
      this.camX += (me.headX - this.camX) * 0.08;
      this.camY += (me.headY - this.camY) * 0.08;

      // Track max length for boost energy arc
      if (me.serverLength > this.maxLengthReached) {
        this.maxLengthReached = me.serverLength;
      }

      this.onStatsUpdate?.({
        kills: me.kills,
        value: me.valueUsdc / 1_000_000,
        alive: this.room.state.aliveCount || 0,
        length: me.serverLength,
        muted: this.audio.muted,
      });
    }

    // Send viewport to server for interest management (every 500ms)
    const now2 = performance.now();
    if (now2 - this.lastViewportSend > 500) {
      this.lastViewportSend = now2;
      this.room.send("viewport", {
        x: this.camX,
        y: this.camY,
        w: this.cssW,
        h: this.cssH,
      });
    }
  }

  // ─── Drawing ──────────────────────────────────────

  private draw() {
    const W = this.cssW;
    const H = this.cssH;
    const ctx = this.ctx;

    ctx.clearRect(0, 0, W, H);

    if (this.bgPattern && this.assetsLoaded) {
      ctx.save();
      const offsetX = -(this.camX * 0.8);
      const offsetY = -(this.camY * 0.8);
      ctx.translate(offsetX, offsetY);
      ctx.fillStyle = this.bgPattern;
      ctx.fillRect(-offsetX, -offsetY, W, H);
      ctx.restore();
    } else {
      ctx.fillStyle = "#0a0a1a";
      ctx.fillRect(0, 0, W, H);
    }

    this.drawBoundary(ctx, W, H);
    this.drawFood(ctx, W, H);
    this.drawBoostParticles(ctx, W, H);

    // Sort snakes so local player draws on top
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

    this.drawParticles(ctx, W, H);
    this.drawEatPopups(ctx, W, H);
    this.drawKillFeed(ctx, W, H);
    this.drawMinimap(ctx, W, H);
  }

  // ─── Coordinate helpers ───────────────────────────

  private toScreenX(wx: number): number { return wx - this.camX + this.cssW / 2; }
  private toScreenY(wy: number): number { return wy - this.camY + this.cssH / 2; }

  // ─── Snake Drawing ────────────────────────────────

  private drawSnake(ctx: CanvasRenderingContext2D, snake: LocalSnake, W: number, H: number, isMe: boolean) {
    if (!snake.alive || snake.segments.length < 2) return;

    const bodyRadius = 12; // increased from 10 for 60%+ overlap with spacing=4
    const headRadius = 14;
    const palette = SKIN_PALETTES[snake.skinId % SKIN_PALETTES.length];
    const bodyImg = this.bodyImages[snake.skinId % this.bodyImages.length];
    const hasSprite = bodyImg && bodyImg.complete;
    const skipOutline = this.isMobile; // skip outline on mobile for performance

    // Draw from tail to head (head renders on top)
    // --- OUTLINE PASS (2px larger darker circle behind each segment) ---
    if (!hasSprite && !skipOutline) {
      ctx.beginPath();
      for (let i = snake.segments.length - 1; i >= 1; i--) {
        const seg = snake.segments[i];
        if (!this.isInView(seg.x, seg.y, 200)) continue;
        const sx = this.toScreenX(seg.x);
        const sy = this.toScreenY(seg.y);
        ctx.moveTo(sx + bodyRadius + 2, sy);
        ctx.arc(sx, sy, bodyRadius + 2, 0, Math.PI * 2);
      }
      ctx.fillStyle = "rgba(0,0,0,0.45)";
      ctx.fill();
    }

    // --- BODY PASS ---
    if (hasSprite) {
      const size = bodyRadius * 2;
      for (let i = snake.segments.length - 1; i >= 1; i--) {
        const seg = snake.segments[i];
        if (!this.isInView(seg.x, seg.y, 200)) continue;
        const sx = this.toScreenX(seg.x);
        const sy = this.toScreenY(seg.y);
        ctx.drawImage(bodyImg, sx - bodyRadius, sy - bodyRadius, size, size);
      }
    } else {
      // Batch by color band for fewer state changes
      const colorBands = new Map<string, { sx: number; sy: number }[]>();
      for (let i = snake.segments.length - 1; i >= 1; i--) {
        const seg = snake.segments[i];
        if (!this.isInView(seg.x, seg.y, 200)) continue;
        const colorIndex = Math.floor(i / 3) % palette.length;
        const color = palette[colorIndex];
        if (!colorBands.has(color)) colorBands.set(color, []);
        colorBands.get(color)!.push({
          sx: this.toScreenX(seg.x),
          sy: this.toScreenY(seg.y),
        });
      }

      // Boost pulse: vary alpha between 0.8 and 1.0
      if (snake.boosting) {
        const pulseAlpha = 0.8 + Math.sin(Date.now() / 80) * 0.2;
        ctx.globalAlpha = pulseAlpha;
      }

      for (const [color, segs] of colorBands) {
        ctx.fillStyle = color;
        ctx.beginPath();
        for (const s of segs) {
          ctx.moveTo(s.sx + bodyRadius, s.sy);
          ctx.arc(s.sx, s.sy, bodyRadius, 0, Math.PI * 2);
        }
        ctx.fill();
      }

      if (snake.boosting) {
        ctx.globalAlpha = 1.0;
      }
    }

    // --- HEAD ---
    const head = snake.segments[0];
    if (!this.isInView(head.x, head.y, 200)) return;

    const hsx = this.toScreenX(head.x);
    const hsy = this.toScreenY(head.y);

    // Head outline
    if (!skipOutline) {
      ctx.fillStyle = "rgba(0,0,0,0.45)";
      ctx.beginPath();
      ctx.arc(hsx, hsy, headRadius + 2, 0, Math.PI * 2);
      ctx.fill();
    }

    if (this.headImage && this.headImage.complete) {
      const headSize = headRadius * 2.6;
      ctx.save();
      ctx.translate(hsx, hsy);
      ctx.rotate(snake.angle - Math.PI / 2);
      ctx.drawImage(this.headImage, -headSize / 2, -headSize / 2, headSize, headSize);
      ctx.restore();
    } else {
      // Flat head with eyes
      ctx.fillStyle = palette[0];
      ctx.beginPath();
      ctx.arc(hsx, hsy, headRadius, 0, Math.PI * 2);
      ctx.fill();

      // Eyes
      const eyeOffset = headRadius * 0.5;
      const angle = snake.angle;
      const eyeAngle1 = angle + 0.4;
      const eyeAngle2 = angle - 0.4;

      // White
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.arc(hsx + Math.cos(eyeAngle1) * eyeOffset, hsy + Math.sin(eyeAngle1) * eyeOffset, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(hsx + Math.cos(eyeAngle2) * eyeOffset, hsy + Math.sin(eyeAngle2) * eyeOffset, 4, 0, Math.PI * 2);
      ctx.fill();

      // Pupils
      ctx.fillStyle = "#000000";
      ctx.beginPath();
      ctx.arc(hsx + Math.cos(eyeAngle1) * (eyeOffset + 2), hsy + Math.sin(eyeAngle1) * (eyeOffset + 2), 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(hsx + Math.cos(eyeAngle2) * (eyeOffset + 2), hsy + Math.sin(eyeAngle2) * (eyeOffset + 2), 2, 0, Math.PI * 2);
      ctx.fill();
    }

    // Boost glow
    if (snake.boosting && isMe) {
      const gradient = ctx.createRadialGradient(hsx, hsy, 0, hsx, hsy, headRadius * 5);
      gradient.addColorStop(0, "rgba(255, 255, 100, 0.15)");
      gradient.addColorStop(1, "rgba(255, 255, 100, 0)");
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(hsx, hsy, headRadius * 5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private drawSnakeName(ctx: CanvasRenderingContext2D, snake: LocalSnake, W: number, H: number) {
    if (!this.isInView(snake.headX, snake.headY, 200)) return;
    const sx = this.toScreenX(snake.headX);
    const sy = this.toScreenY(snake.headY);

    ctx.font = this.isMobile ? "bold 11px Arial, sans-serif" : "bold 13px Arial, sans-serif";
    ctx.textAlign = "center";
    ctx.strokeStyle = "#000000";
    ctx.lineWidth = 3;
    ctx.strokeText(snake.name, sx, sy - 22);
    ctx.fillStyle = "#ffffff";
    ctx.fillText(snake.name, sx, sy - 22);
  }

  // ─── Food ─────────────────────────────────────────

  private drawFood(ctx: CanvasRenderingContext2D, W: number, H: number) {
    const time = Date.now();
    // On mobile, only render food within tight margin for performance
    const foodViewMargin = this.isMobile ? -100 : 50;

    // Batch food by color — one path per color reduces state changes
    const glowBatches = new Map<string, { sx: number; sy: number; r: number }[]>();
    const solidBatches = new Map<string, { sx: number; sy: number; r: number }[]>();

    this.room.state.food.forEach((food: any, foodId: string) => {
      // Skip food that was eaten (broadcast arrived before state sync)
      if (this.eatenFoodIds.has(foodId)) return;
      if (!this.isInView(food.x, food.y, foodViewMargin)) return;
      const sx = this.toScreenX(food.x);
      const sy = this.toScreenY(food.y);

      const isDeath = food.size === 2;
      const baseSize = isDeath ? 10 : 6; // increased from 8/4
      const pulse = 1 + Math.sin(time / 400 + food.x * 0.1 + food.y * 0.1) * 0.2;
      const r = baseSize * pulse;

      const colorIdx = Math.abs(Math.floor(food.x * 7 + food.y * 13)) % FOOD_COLORS.length;
      const color = FOOD_COLORS[colorIdx];

      if (!this.isMobile) {
        if (!glowBatches.has(color)) glowBatches.set(color, []);
        glowBatches.get(color)!.push({ sx, sy, r: r * 2.5 });
      }

      if (!solidBatches.has(color)) solidBatches.set(color, []);
      solidBatches.get(color)!.push({ sx, sy, r });
    });

    // Draw glow halos (skip on mobile)
    if (!this.isMobile) {
      ctx.globalAlpha = 0.2;
      for (const [color, items] of glowBatches) {
        ctx.fillStyle = color;
        ctx.beginPath();
        for (const item of items) {
          ctx.moveTo(item.sx + item.r, item.sy);
          ctx.arc(item.sx, item.sy, item.r, 0, Math.PI * 2);
        }
        ctx.fill();
      }
    }

    // Draw solid food
    ctx.globalAlpha = 1.0;
    for (const [color, items] of solidBatches) {
      ctx.fillStyle = color;
      ctx.beginPath();
      for (const item of items) {
        ctx.moveTo(item.sx + item.r, item.sy);
        ctx.arc(item.sx, item.sy, item.r, 0, Math.PI * 2);
      }
      ctx.fill();
    }
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

  // ─── Minimap ──────────────────────────────────────

  private drawMinimap(ctx: CanvasRenderingContext2D, W: number, H: number) {
    const isLandscape = W > H;
    const SIZE = this.isMobile ? (isLandscape ? 100 : 120) : 200;
    const PADDING = 10;
    const mx = W - SIZE - PADDING;
    // Top-right, below HUD bar
    const my = this.isMobile ? 50 : 70;
    const scale = (SIZE - 20) / (this.arenaRadius * 2);

    ctx.save();
    const r = this.isMobile ? 8 : 12;
    ctx.beginPath();
    ctx.moveTo(mx + r, my);
    ctx.lineTo(mx + SIZE - r, my);
    ctx.quadraticCurveTo(mx + SIZE, my, mx + SIZE, my + r);
    ctx.lineTo(mx + SIZE, my + SIZE - r);
    ctx.quadraticCurveTo(mx + SIZE, my + SIZE, mx + SIZE - r, my + SIZE);
    ctx.lineTo(mx + r, my + SIZE);
    ctx.quadraticCurveTo(mx, my + SIZE, mx, my + SIZE - r);
    ctx.lineTo(mx, my + r);
    ctx.quadraticCurveTo(mx, my, mx + r, my);
    ctx.closePath();
    ctx.fillStyle = "rgba(0, 0, 0, 0.6)";
    ctx.fill();
    ctx.clip();

    const centerX = mx + SIZE / 2;
    const centerY = my + SIZE / 2;
    const arenaR = this.arenaRadius * scale;

    ctx.strokeStyle = "rgba(255, 0, 68, 0.5)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(centerX, centerY, arenaR, 0, Math.PI * 2);
    ctx.stroke();

    for (const [id, snake] of this.localSnakes) {
      if (!snake.alive) continue;
      const dotX = centerX + snake.headX * scale;
      const dotY = centerY + snake.headY * scale;

      let color: string;
      let dotSize: number;

      if (id === this.mySessionId) {
        color = "#00FF66";
        dotSize = this.isMobile ? 3 : 4;
      } else if (snake.isBot) {
        color = "#888888";
        dotSize = this.isMobile ? 2 : 2.5;
      } else {
        color = SKIN_PALETTES[snake.skinId % SKIN_PALETTES.length][0];
        dotSize = this.isMobile ? 2.5 : 3;
      }

      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(dotX, dotY, dotSize, 0, Math.PI * 2);
      ctx.fill();

      if (id === this.mySessionId) {
        ctx.strokeStyle = "rgba(0, 255, 102, 0.4)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(dotX, dotY, dotSize + 3, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    ctx.restore();
  }

  // ─── Cleanup ──────────────────────────────────────

  destroy() {
    this.destroyed = true;
    cancelAnimationFrame(this.animFrame);
    this.audio.destroy();
    this.room.leave();
    this.canvas.remove();
  }
}
