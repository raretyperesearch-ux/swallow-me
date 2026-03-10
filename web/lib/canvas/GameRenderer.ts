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

// Unified pooled particle — pre-allocated, never created/destroyed in hot path
interface PooledParticle {
  active: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
  color: string;
  life: number;
  maxLife: number;
  size: number;
}

interface EatPopup {
  active: boolean;
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

const FOOD_COLORS = [
  "#FF3333", "#FFFF44", "#33FF55", "#FF44FF",
  "#FFFFFF", "#44FFFF", "#88FF22", "#FFDD22",
];

// Solid snake body colors — one color per snake, clean look
const SNAKE_COLORS: string[] = [
  "#4488FF",  // blue (player default)
  "#FF4466",  // pink/red
  "#44FF66",  // green
  "#FFAA00",  // gold
  "#FF44FF",  // magenta
  "#00DDDD",  // cyan
  "#FF6600",  // orange
  "#AA44FF",  // purple
  "#00FF44",  // neon green
  "#FFDD00",  // yellow
];

function darkenColor(hex: string, factor: number): string {
  const r = Math.max(0, Math.floor(parseInt(hex.slice(1, 3), 16) * (1 - factor)));
  const g = Math.max(0, Math.floor(parseInt(hex.slice(3, 5), 16) * (1 - factor)));
  const b = Math.max(0, Math.floor(parseInt(hex.slice(5, 7), 16) * (1 - factor)));
  return `rgb(${r},${g},${b})`;
}

function lightenColor(hex: string, amount: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgb(${Math.min(255, Math.floor(r + (255 - r) * amount))},${Math.min(255, Math.floor(g + (255 - g) * amount))},${Math.min(255, Math.floor(b + (255 - b) * amount))})`;
}

// Pre-allocate a particle pool — zero allocations in render loop
function createParticlePool(size: number): PooledParticle[] {
  const pool: PooledParticle[] = new Array(size);
  for (let i = 0; i < size; i++) {
    pool[i] = { active: false, x: 0, y: 0, vx: 0, vy: 0, color: '', life: 0, maxLife: 0, size: 0 };
  }
  return pool;
}

function createEatPopupPool(size: number): EatPopup[] {
  const pool: EatPopup[] = new Array(size);
  for (let i = 0; i < size; i++) {
    pool[i] = { active: false, x: 0, y: 0, life: 0, text: '' };
  }
  return pool;
}

// Pre-render glow circle to offscreen canvas (cached at init, drawn via drawImage)
function createGlowCircle(radius: number, color: string): HTMLCanvasElement {
  const size = Math.ceil(radius * 2 + 4);
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const octx = c.getContext('2d')!;
  const cx = size / 2;
  const grad = octx.createRadialGradient(cx, cx, radius * 0.1, cx, cx, radius);
  grad.addColorStop(0, color);
  grad.addColorStop(0.6, color);
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  octx.fillStyle = grad;
  octx.beginPath();
  octx.arc(cx, cx, radius, 0, Math.PI * 2);
  octx.fill();
  return c;
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

  // Camera (with zoom)
  private camX: number = 0;
  private camY: number = 0;
  private zoom: number = 1;
  private targetZoom: number = 1;

  // Local state
  private localSnakes: Map<string, LocalSnake> = new Map();
  private arenaRadius: number = 5000;
  private bgPattern: CanvasPattern | null = null;

  // Assets
  private bgImage: HTMLImageElement | null = null;
  private assetsLoaded: boolean = false;

  // Pre-rendered food glow caches (one per FOOD_COLOR, built at init)
  private foodGlowSmall: HTMLCanvasElement[] = [];   // radius ~6
  private foodGlowLarge: HTMLCanvasElement[] = [];   // radius ~10 (death food)

  // Death particles (pre-allocated pool)
  private deathPool: PooledParticle[] = createParticlePool(400);

  // Boost particles (pre-allocated pool)
  private boostPool: PooledParticle[] = createParticlePool(200);
  private boostFrameCounter: number = 0;

  // Trail particles (pre-allocated pool, additive blending)
  private trailPool: PooledParticle[] = createParticlePool(100);

  // Eat popups (pre-allocated pool)
  private eatPopups: EatPopup[] = createEatPopupPool(30);

  // Track food IDs eaten via broadcast for immediate removal
  private eatenFoodIds: Set<string> = new Set();

  // Pre-allocated food batch arrays (reused each frame — no allocation in render loop)
  private foodBatchCounts: number[] = new Array(FOOD_COLORS.length).fill(0);
  private foodBatchData: { sx: number; sy: number; r: number }[][] = FOOD_COLORS.map(() => {
    const arr: { sx: number; sy: number; r: number }[] = [];
    for (let j = 0; j < 300; j++) arr.push({ sx: 0, sy: 0, r: 0 });
    return arr;
  });

  // Kill feed
  private killFeed: KillFeedItem[] = [];

  // Sound
  private audio = new GameAudio();

  // Boost tracking (for sound)
  private wasBoosting: boolean = false;
  // Food count tracking (for eat sound)
  private lastFoodCount: number = -1;

  // Frame timing (dt-based movement)
  private lastFrameTime: number = 0;
  private dt: number = 1 / 60; // seconds, capped
  private fps: number = 0;
  private fpsFrames: number = 0;
  private fpsLastUpdate: number = 0;

  // Screen shake
  private shakeX: number = 0;
  private shakeY: number = 0;
  private shakeLife: number = 0; // seconds remaining

  // Low-end device detection
  private isLowEnd: boolean = false;

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

  // Mobile joystick — STATIC always-visible at bottom-left
  private joystickActive: boolean = false;
  private joystickCenterX: number = 0;
  private joystickCenterY: number = 0;
  private joystickKnobX: number = 0;
  private joystickKnobY: number = 0;
  private joystickTouchId: number | null = null;

  private readonly JOYSTICK_RADIUS = 70;
  private readonly KNOB_RADIUS = 28;
  private readonly DEAD_ZONE = 8;
  private readonly JOYSTICK_HITBOX = 150;

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
  private loadingTotal: number = 1;
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

    // Only cap truly low-end devices (≤2 cores) to 30fps
    this.isLowEnd = (navigator.hardwareConcurrency || 4) <= 2;
    if (this.isLowEnd) {
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

    // Pre-render food glow circles (one per color, cached forever)
    // Mobile gets smaller glow radius for perf, desktop gets full size
    const glowRadiusSmall = this.isMobile ? 8 : 16;
    const glowRadiusLarge = this.isMobile ? 14 : 24;
    for (const color of FOOD_COLORS) {
      this.foodGlowSmall.push(createGlowCircle(glowRadiusSmall, color));
      this.foodGlowLarge.push(createGlowCircle(glowRadiusLarge, color));
    }

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
    const allPaths = ["/assets/Map2.png"];
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
  }

  // ─── Colyseus Sync ────────────────────────────────

  private setupListeners() {
    this.room.state.snakes.onAdd((snake: any, key: string) => {
      const segs: { x: number; y: number }[] = [];
      const len = snake.length || 40;
      const angle = snake.angle || 0;
      const initRadius = 8 + Math.log2(Math.max(40, len)) * 2.5;
      const initSpacing = Math.max(4, initRadius * 0.35);
      for (let i = 0; i < len; i++) {
        segs.push({
          x: snake.headX - Math.cos(angle) * i * initSpacing,
          y: snake.headY - Math.sin(angle) * i * initSpacing,
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
      if (snake && snake.alive && this.isInView(snake.headX, snake.headY, 200)) {
        this.spawnDeathParticles(snake.headX, snake.headY, snake.skinId, key === this.mySessionId);
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
        this.shakeLife = 0.2;
      }
      const maxFeed = this.isMobile ? 3 : 5;
      while (this.killFeed.length > maxFeed) this.killFeed.shift();
    });

    // Handle food_eaten broadcast for immediate client-side removal
    this.room.onMessage("food_eaten", (data: { ids: string[]; eaterId: string }) => {
      const isMe = data.eaterId === this.mySessionId;
      if (isMe) {
        this.audio.playEat();
      }
      // Track eaten food IDs so drawFood skips them immediately
      for (const id of data.ids) {
        this.eatenFoodIds.add(id);
        // Only show "+1" popup for my own eats
        if (isMe) {
          const food = this.room.state.food.get(id);
          if (food) {
            this.spawnEatPopup(food.x, food.y);
          }
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

  // ─── Death Particles (object pool) ──────────────────

  private emitPool(pool: PooledParticle[], x: number, y: number, count: number, color: string, speed: number, life: number, sizeMin: number, sizeMax: number) {
    let emitted = 0;
    for (const p of pool) {
      if (p.active || emitted >= count) continue;
      p.active = true;
      p.x = x;
      p.y = y;
      const angle = Math.random() * Math.PI * 2;
      const spd = speed * (0.3 + Math.random() * 0.7);
      p.vx = Math.cos(angle) * spd;
      p.vy = Math.sin(angle) * spd;
      p.color = color;
      p.life = life;
      p.maxLife = life;
      p.size = sizeMin + Math.random() * (sizeMax - sizeMin);
      emitted++;
      if (emitted >= count) break;
    }
  }

  private spawnDeathParticles(worldX: number, worldY: number, skinId: number, shakeScreen: boolean) {
    const color = SNAKE_COLORS[skinId % SNAKE_COLORS.length];
    this.emitPool(this.deathPool, worldX, worldY, 50, color, 6, 1.5, 4, 12);
    if (shakeScreen) {
      this.shakeLife = 0.2;
    }
  }

  private updatePool(pool: PooledParticle[], friction: number, lifeDrain: number) {
    for (const p of pool) {
      if (!p.active) continue;
      p.x += p.vx;
      p.y += p.vy;
      p.vx *= friction;
      p.vy *= friction;
      p.life -= lifeDrain;
      if (p.life <= 0) p.active = false;
    }
  }

  private drawPool(ctx: CanvasRenderingContext2D, pool: PooledParticle[], W: number, H: number, additive: boolean = false) {
    if (additive) ctx.globalCompositeOperation = 'lighter';
    for (const p of pool) {
      if (!p.active) continue;
      if (!this.isInView(p.x, p.y, 30)) continue;
      const sx = this.toScreenX(p.x);
      const sy = this.toScreenY(p.y);
      const alpha = p.life / p.maxLife;
      ctx.globalAlpha = alpha;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(sx, sy, p.size * alpha, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1.0;
    if (additive) ctx.globalCompositeOperation = 'source-over';
  }

  // ─── Boost Particles (object pool) ──────────────────

  private spawnBoostParticle(snake: LocalSnake) {
    if (snake.segments.length < 3) return;
    const tail = snake.segments[snake.segments.length - 1];
    const color = SNAKE_COLORS[snake.skinId % SNAKE_COLORS.length];
    this.emitPool(this.boostPool, tail.x + (Math.random() - 0.5) * 8, tail.y + (Math.random() - 0.5) * 8, 1, color, 2, 0.8, 2, 5);
  }

  // Whoosh trail: wider, brighter particles during boost
  private spawnBoostParticleLarge(snake: LocalSnake) {
    if (snake.segments.length < 3) return;
    const tail = snake.segments[snake.segments.length - 1];
    const color = SNAKE_COLORS[snake.skinId % SNAKE_COLORS.length];
    this.emitPool(this.boostPool, tail.x + (Math.random() - 0.5) * 14, tail.y + (Math.random() - 0.5) * 14, 1, color, 3, 1.0, 3, 8);
  }

  // ─── Eat Popups (object pool) ──────────────────────

  private spawnEatPopup(x: number, y: number) {
    for (const p of this.eatPopups) {
      if (p.active) continue;
      p.active = true;
      p.x = x;
      p.y = y;
      p.life = 1.0;
      p.text = "+1";
      return;
    }
  }

  private updateEatPopups() {
    for (const p of this.eatPopups) {
      if (!p.active) continue;
      p.life -= 1 / 30;
      p.y -= 0.5;
      if (p.life <= 0) p.active = false;
    }
  }

  private drawEatPopups(ctx: CanvasRenderingContext2D, W: number, H: number) {
    ctx.font = "bold 14px Arial, sans-serif";
    ctx.textAlign = "center";
    for (const p of this.eatPopups) {
      if (!p.active) continue;
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

  // ─── Kill Feed Drawing (top-right, 3s fade) ────────

  private drawKillFeed(ctx: CanvasRenderingContext2D, W: number, H: number) {
    const now = Date.now();
    const FEED_DURATION = 3000; // 3 second fade
    this.killFeed = this.killFeed.filter((e) => now - e.timestamp < FEED_DURATION);
    if (this.killFeed.length === 0) return;

    const fontSize = this.isMobile ? 10 : 12;
    ctx.font = `${fontSize}px Arial, sans-serif`;
    ctx.textAlign = "right";
    const ph = this.isMobile ? 20 : 24;
    const padding = 10;
    // Below minimap: minimap ends at roughly my + SIZE, start below that
    let y = this.isMobile ? (this.cssW > this.cssH ? 160 : 180) : 280;

    for (let i = 0; i < this.killFeed.length; i++) {
      const entry = this.killFeed[i];
      const age = now - entry.timestamp;
      // Smooth ease-out fade: fast at start, slow at end
      const t = age / FEED_DURATION;
      const alpha = Math.max(0, 1 - t * t);
      // Slide in from right
      const slideOffset = Math.max(0, 1 - age / 200) * 30;

      const text = `${entry.killerName} ate ${entry.victimName} +$${entry.amount.toFixed(2)}`;
      const metrics = ctx.measureText(text);
      const pw = metrics.width + 16;
      const rx = W - padding + slideOffset;

      ctx.globalAlpha = alpha * 0.65;
      ctx.fillStyle = "#000000";
      ctx.beginPath();
      ctx.roundRect(rx - pw, y, pw, ph, 6);
      ctx.fill();

      ctx.globalAlpha = alpha;
      ctx.fillStyle = "#ffffff";
      ctx.fillText(text, rx - 8, y + ph - 6);

      y += ph + 3;
    }
    ctx.globalAlpha = 1.0;
    ctx.textAlign = "left";
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
          const halfW = this.cssW * 0.5;

          // Right half of screen = boost zone
          if (tx >= halfW && this.boostTouchId === null) {
            this.boostTouchId = touch.identifier;
            this.touchBoosting = true;
            continue;
          }

          // Left half of screen = joystick zone
          if (tx < halfW && this.joystickTouchId === null) {
            // Check if touch is within hitbox of the static joystick center
            const jcx = 90;
            const jcy = this.cssH - 90;
            const jdx = tx - jcx;
            const jdy = ty - jcy;
            const jDist = Math.sqrt(jdx * jdx + jdy * jdy);
            if (jDist < this.JOYSTICK_HITBOX) {
              this.joystickTouchId = touch.identifier;
              this.joystickActive = true;
              this.handleJoystickMove(tx, ty);
            }
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
            // Snap knob back to center
            this.joystickKnobX = 90;
            this.joystickKnobY = this.cssH - 90;
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
        this.joystickKnobX = 90;
        this.joystickKnobY = this.cssH - 90;
        this.boostTouchId = null;
        this.touchBoosting = false;
      }, { passive: false });
    }
  }

  // ─── Joystick Logic (no separate canvas) ──────────

  private handleJoystickMove(touchX: number, touchY: number) {
    // Static joystick center — always bottom-left
    const cx = 90;
    const cy = this.cssH - 90;
    this.joystickCenterX = cx;
    this.joystickCenterY = cy;

    const dx = touchX - cx;
    const dy = touchY - cy;
    const dist = Math.sqrt(dx * dx + dy * dy);

    // Dead zone — ignore tiny movements
    if (dist < this.DEAD_ZONE) {
      this.joystickKnobX = cx;
      this.joystickKnobY = cy;
      return;
    }

    // Clamp knob to joystick radius
    if (dist > this.JOYSTICK_RADIUS) {
      this.joystickKnobX = cx + (dx / dist) * this.JOYSTICK_RADIUS;
      this.joystickKnobY = cy + (dy / dist) * this.JOYSTICK_RADIUS;
    } else {
      this.joystickKnobX = touchX;
      this.joystickKnobY = touchY;
    }

    // Update angle from center
    this.inputAngle = Math.atan2(dy, dx);

    // Joystick is direction ONLY — no boost from joystick
  }

  // Draw joystick on MAIN canvas — ALWAYS visible at bottom-left
  private drawJoystick(ctx: CanvasRenderingContext2D) {
    // Static position — always bottom-left
    const cx = 90;
    const cy = this.cssH - 90;

    // Outer ring — filled + stroked
    ctx.beginPath();
    ctx.arc(cx, cy, this.JOYSTICK_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255, 255, 255, 0.15)";
    ctx.fill();
    ctx.strokeStyle = "rgba(255, 255, 255, 0.35)";
    ctx.lineWidth = 3;
    ctx.stroke();

    // Inner knob — snaps back to center when not active
    const knobX = this.joystickActive ? this.joystickKnobX : cx;
    const knobY = this.joystickActive ? this.joystickKnobY : cy;

    ctx.beginPath();
    ctx.arc(knobX, knobY, this.KNOB_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = this.joystickActive ? "rgba(255, 255, 255, 0.5)" : "rgba(255, 255, 255, 0.4)";
    ctx.fill();
    ctx.strokeStyle = "rgba(255, 255, 255, 0.6)";
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // ─── Boost Button (bottom-right, mobile) ──────────

  private getBoostButtonCenter(): { x: number; y: number; radius: number } {
    const r = 40;
    return {
      x: this.cssW - 60,
      y: this.cssH - 90,
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

    // Main circle — brighter default state
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    if (this.touchBoosting && canBoost) {
      ctx.fillStyle = "rgba(0, 255, 100, 0.3)";
      ctx.strokeStyle = "rgba(0, 255, 100, 0.9)";
    } else if (!canBoost) {
      ctx.fillStyle = "rgba(255, 50, 50, 0.1)";
      ctx.strokeStyle = "rgba(255, 50, 50, 0.4)";
    } else {
      ctx.fillStyle = "rgba(0, 255, 100, 0.12)";
      ctx.strokeStyle = "rgba(0, 255, 100, 0.5)";
    }
    ctx.fill();
    ctx.lineWidth = 2;
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

    // Compute delta time in seconds, capped to prevent spiral of death
    const rawDt = (now - this.lastFrameTime) / 1000;
    this.dt = Math.min(rawDt, 1 / 15); // cap at ~15fps worth of dt
    this.lastFrameTime = now;

    this.fpsFrames++;
    if (now - this.fpsLastUpdate > 1000) {
      this.fps = this.fpsFrames;
      this.fpsFrames = 0;
      this.fpsLastUpdate = now;
    }

    if (!this.ready) {
      this.drawLoadingScreen();
    } else {
      this.update(this.dt);
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
    const snakeColors = SNAKE_COLORS;

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

  // ─── Viewport culling helper (zoom-aware) ──────────

  private isInView(wx: number, wy: number, margin: number = 200): boolean {
    const sx = (wx - this.camX) * this.zoom + this.cssW / 2;
    const sy = (wy - this.camY) * this.zoom + this.cssH / 2;
    return sx > -margin && sx < this.cssW + margin &&
           sy > -margin && sy < this.cssH + margin;
  }

  private update(dt: number) {
    // dt = seconds since last frame (capped in loop)

    this.boostFrameCounter++;

    // Exponential smoothing factors — frame-rate independent
    // turnRate: ~8 rad/sec → at 60fps=0.13/frame, at 30fps=0.27/frame
    const turnLerp = 1 - Math.exp(-8 * dt);
    // Server position blend: converge in ~6 frames at 60fps
    const serverBlend = 1 - Math.pow(0.001, dt);
    // Other player lerp: faster convergence
    const otherBlend = 1 - Math.pow(0.0001, dt);

    for (const [id, snake] of this.localSnakes) {
      if (!snake.alive) continue;
      const isMe = id === this.mySessionId;

      // --- CLIENT-SIDE PREDICTION ---
      if (isMe) {
        // Smooth angle toward mouse target (dt-based)
        let angleDiff = this.inputAngle - snake.angle;
        while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
        while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;
        snake.angle += angleDiff * turnLerp;

        // Move head locally at predicted speed (dt-based)
        const speed = snake.boosting ? 16.0 : 8.0;
        const moveDist = speed * dt * 60; // normalize to 60fps baseline
        snake.headX += Math.cos(snake.angle) * moveDist;
        snake.headY += Math.sin(snake.angle) * moveDist;

        // Blend toward server position (exponential smoothing, dt-based)
        snake.headX += (snake.serverHeadX - snake.headX) * serverBlend;
        snake.headY += (snake.serverHeadY - snake.headY) * serverBlend;

        // Boost sound
        if (snake.boosting && !this.wasBoosting) this.audio.startBoost();
        if (!snake.boosting && this.wasBoosting) this.audio.stopBoost();
        this.wasBoosting = snake.boosting;

        // Boost particles: when boosting, emit more (whoosh trail)
        if (snake.boosting) {
          if (this.boostFrameCounter % 2 === 0) {
            this.spawnBoostParticle(snake);
            // Extra whoosh: 1.5x size particles
            this.spawnBoostParticleLarge(snake);
          }
        } else if (this.boostFrameCounter % 3 === 0) {
          // Normal non-boost: no particles
        }
      } else {
        // Other players: lerp toward server position (dt-based)
        snake.headX += (snake.serverHeadX - snake.headX) * otherBlend;
        snake.headY += (snake.serverHeadY - snake.headY) * otherBlend;

        // Smooth angle for others (dt-based)
        const targetAngle = snake.serverAngle;
        let angleDiff = targetAngle - snake.angle;
        while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
        while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;
        snake.angle += angleDiff * turnLerp;

        // Boost particles for others too (visible)
        if (snake.boosting && this.boostFrameCounter % 3 === 0 && this.isInView(snake.headX, snake.headY, 300)) {
          this.spawnBoostParticle(snake);
        }
      }

      // --- CHAIN CONSTRAINT (no gaps) ---
      if (snake.segments.length > 0) {
        snake.segments[0].x = snake.headX;
        snake.segments[0].y = snake.headY;
      }

      const snakeBodyRadius = 8 + Math.log2(Math.max(40, snake.serverLength)) * 2.5;
      const spacing = Math.max(4, snakeBodyRadius * 0.35);
      for (let i = 1; i < snake.segments.length; i++) {
        const prev = snake.segments[i - 1];
        const curr = snake.segments[i];
        const dx = curr.x - prev.x;
        const dy = curr.y - prev.y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist > spacing) {
          const angle = Math.atan2(dy, dx);
          curr.x = prev.x + Math.cos(angle) * spacing;
          curr.y = prev.y + Math.sin(angle) * spacing;
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

    // Update particle pools (dt-normalized drain rates)
    this.updatePool(this.deathPool, Math.pow(0.04, dt), dt);
    this.updatePool(this.boostPool, Math.pow(0.06, dt), dt * 1.5);
    this.updatePool(this.trailPool, Math.pow(0.02, dt), dt * 2);
    this.updateEatPopups();

    // Screen shake decay
    if (this.shakeLife > 0) {
      this.shakeLife -= dt;
      const intensity = Math.max(0, this.shakeLife / 0.2) * 5;
      this.shakeX = (Math.random() - 0.5) * 2 * intensity;
      this.shakeY = (Math.random() - 0.5) * 2 * intensity;
    } else {
      this.shakeX = 0;
      this.shakeY = 0;
    }

    // Camera — smooth follow + dynamic zoom (dt-based)
    const camLerp = 1 - Math.pow(0.0001, dt);
    const me = this.localSnakes.get(this.mySessionId);
    if (me && me.alive) {
      this.camX += (me.headX - this.camX) * camLerp + this.shakeX;
      this.camY += (me.headY - this.camY) * camLerp + this.shakeY;

      // Zoom out as snake grows: length 40→1.0, length 200→0.7, length 500→0.5
      const len = me.serverLength || 40;
      this.targetZoom = Math.max(0.5, Math.min(1.0, 1.0 - (len - 40) / 900));
      this.zoom += (this.targetZoom - this.zoom) * Math.min(1, 0.06 * dt * 60);

      // Trail: spawn every frame, bigger on mobile
      const trailColor = SNAKE_COLORS[me.skinId % SNAKE_COLORS.length];
      const seg1 = me.segments[1];
      if (seg1) {
        const trailSizeMin = this.isMobile ? 6 : 4;
        const trailSizeMax = this.isMobile ? 12 : 8;
        this.emitPool(this.trailPool, seg1.x, seg1.y, 1, trailColor, 0.3, 0.5, trailSizeMin, trailSizeMax);
      }

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
        w: this.cssW / this.zoom,
        h: this.cssH / this.zoom,
      });
    }
  }

  // ─── Drawing ──────────────────────────────────────

  private draw() {
    const W = this.cssW;
    const H = this.cssH;
    const ctx = this.ctx;

    ctx.clearRect(0, 0, W, H);

    // Dark background
    ctx.fillStyle = "#0a0a1a";
    ctx.fillRect(0, 0, W, H);

    // Scrolling grid background (zoom-aware)
    this.drawGrid(ctx, W, H);

    this.drawBoundary(ctx, W, H);
    this.drawFood(ctx, W, H);

    // Boost particles
    this.drawPool(ctx, this.boostPool, W, H);

    // Trail effect (additive blending for glow)
    this.drawPool(ctx, this.trailPool, W, H, true);

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

    // Death explosion particles (additive for impact)
    this.drawPool(ctx, this.deathPool, W, H, true);
    this.drawEatPopups(ctx, W, H);

    // HUD elements (screen-space, not affected by zoom)
    this.drawKillFeed(ctx, W, H);
    this.drawMinimap(ctx, W, H);
  }

  // ─── Scrolling Grid Background ────────────────────

  private drawGrid(ctx: CanvasRenderingContext2D, W: number, H: number) {
    const gridSize = 80;
    ctx.strokeStyle = this.isMobile ? "rgba(255, 255, 255, 0.07)" : "rgba(255, 255, 255, 0.04)";
    ctx.lineWidth = 1;
    ctx.beginPath();

    // Calculate visible world bounds
    const halfW = (W / 2) / this.zoom;
    const halfH = (H / 2) / this.zoom;
    const worldLeft = this.camX - halfW;
    const worldRight = this.camX + halfW;
    const worldTop = this.camY - halfH;
    const worldBottom = this.camY + halfH;

    const startX = Math.floor(worldLeft / gridSize) * gridSize;
    const startY = Math.floor(worldTop / gridSize) * gridSize;

    for (let wx = startX; wx <= worldRight; wx += gridSize) {
      const sx = this.toScreenX(wx);
      ctx.moveTo(sx, 0);
      ctx.lineTo(sx, H);
    }
    for (let wy = startY; wy <= worldBottom; wy += gridSize) {
      const sy = this.toScreenY(wy);
      ctx.moveTo(0, sy);
      ctx.lineTo(W, sy);
    }
    ctx.stroke();
  }

  // ─── Coordinate helpers (zoom-aware) ──────────────

  private toScreenX(wx: number): number { return (wx - this.camX) * this.zoom + this.cssW / 2; }
  private toScreenY(wy: number): number { return (wy - this.camY) * this.zoom + this.cssH / 2; }

  // ─── Snake Drawing ────────────────────────────────

  private drawSnake(ctx: CanvasRenderingContext2D, snake: LocalSnake, W: number, H: number, isMe: boolean) {
    if (!snake.alive || snake.segments.length < 2) return;

    const bodyRadius = (8 + Math.log2(Math.max(40, snake.serverLength)) * 2.5) * this.zoom;
    const snakeColor = SNAKE_COLORS[snake.skinId % SNAKE_COLORS.length];
    const outlineColor = darkenColor(snakeColor, 0.4);

    // --- BODY PASS: gradient for all platforms (batch fallback only for 200+ segments) ---
    ctx.globalAlpha = 1.0;
    const segCount = snake.segments.length;
    if (segCount > 200) {
      // Very long snakes: batched flat fill for performance
      ctx.fillStyle = outlineColor;
      ctx.beginPath();
      for (let i = segCount - 1; i >= 1; i--) {
        const seg = snake.segments[i];
        if (!this.isInView(seg.x, seg.y, 200)) continue;
        const sx = this.toScreenX(seg.x);
        const sy = this.toScreenY(seg.y);
        ctx.moveTo(sx + bodyRadius + 2, sy);
        ctx.arc(sx, sy, bodyRadius + 2, 0, Math.PI * 2);
      }
      ctx.fill();
      ctx.fillStyle = snakeColor;
      ctx.beginPath();
      for (let i = segCount - 1; i >= 1; i--) {
        const seg = snake.segments[i];
        if (!this.isInView(seg.x, seg.y, 200)) continue;
        const sx = this.toScreenX(seg.x);
        const sy = this.toScreenY(seg.y);
        ctx.moveTo(sx + bodyRadius, sy);
        ctx.arc(sx, sy, bodyRadius, 0, Math.PI * 2);
      }
      ctx.fill();
    } else {
      // Per-segment dark outline + radial gradient (same on mobile & desktop)
      for (let i = segCount - 1; i >= 1; i--) {
        const seg = snake.segments[i];
        if (!this.isInView(seg.x, seg.y, 200)) continue;
        const sx = this.toScreenX(seg.x);
        const sy = this.toScreenY(seg.y);

        // Dark outline
        ctx.beginPath();
        ctx.arc(sx, sy, bodyRadius + 2, 0, Math.PI * 2);
        ctx.fillStyle = outlineColor;
        ctx.fill();

        // 3D gradient fill
        const grad = ctx.createRadialGradient(sx - 2, sy - 2, 0, sx, sy, bodyRadius);
        grad.addColorStop(0, lightenColor(snakeColor, 0.3));
        grad.addColorStop(1, snakeColor);
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(sx, sy, bodyRadius, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // --- HEAD (oval + big eyes with shine) ---
    const head = snake.segments[0];
    if (!this.isInView(head.x, head.y, 200)) return;

    const hsx = this.toScreenX(head.x);
    const hsy = this.toScreenY(head.y);
    ctx.save();
    ctx.translate(hsx, hsy);
    ctx.rotate(snake.angle);

    // Circle head shape (same size as body — slither.io style)
    ctx.beginPath();
    ctx.arc(0, 0, bodyRadius + 2, 0, Math.PI * 2);
    ctx.fillStyle = outlineColor;
    ctx.fill();

    if (segCount <= 200) {
      const headGrad = ctx.createRadialGradient(-2, -2, 0, 0, 0, bodyRadius);
      headGrad.addColorStop(0, lightenColor(snakeColor, 0.3));
      headGrad.addColorStop(1, snakeColor);
      ctx.fillStyle = headGrad;
    } else {
      ctx.fillStyle = snakeColor;
    }
    ctx.beginPath();
    ctx.arc(0, 0, bodyRadius, 0, Math.PI * 2);
    ctx.fill();

    // Eye parameters (scaled to fit inside bodyRadius)
    const eyeOffsetX = bodyRadius * 0.25;
    const eyeOffsetY = bodyRadius * 0.35;
    const eyeRadius = bodyRadius * 0.3;
    const pupilRadius = bodyRadius * 0.15;

    // Left eye (top side when angle=0)
    ctx.beginPath();
    ctx.arc(eyeOffsetX, -eyeOffsetY, eyeRadius, 0, Math.PI * 2);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    ctx.strokeStyle = "#333333";
    ctx.lineWidth = 1;
    ctx.stroke();

    // Left pupil
    ctx.beginPath();
    ctx.arc(eyeOffsetX + pupilRadius * 0.3, -eyeOffsetY, pupilRadius, 0, Math.PI * 2);
    ctx.fillStyle = "#000000";
    ctx.fill();

    // Left eye shine
    ctx.beginPath();
    ctx.arc(eyeOffsetX + pupilRadius * 0.1, -eyeOffsetY - pupilRadius * 0.3, pupilRadius * 0.3, 0, Math.PI * 2);
    ctx.fillStyle = "#ffffff";
    ctx.fill();

    // Right eye (bottom side when angle=0)
    ctx.beginPath();
    ctx.arc(eyeOffsetX, eyeOffsetY, eyeRadius, 0, Math.PI * 2);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    ctx.strokeStyle = "#333333";
    ctx.lineWidth = 1;
    ctx.stroke();

    // Right pupil
    ctx.beginPath();
    ctx.arc(eyeOffsetX + pupilRadius * 0.3, eyeOffsetY, pupilRadius, 0, Math.PI * 2);
    ctx.fillStyle = "#000000";
    ctx.fill();

    // Right eye shine
    ctx.beginPath();
    ctx.arc(eyeOffsetX + pupilRadius * 0.1, eyeOffsetY - pupilRadius * 0.3, pupilRadius * 0.3, 0, Math.PI * 2);
    ctx.fillStyle = "#ffffff";
    ctx.fill();

    ctx.restore();

    // Boost glow (behind head, in world coords, additive)
    if (snake.boosting && isMe) {
      ctx.globalCompositeOperation = 'lighter';
      const gradient = ctx.createRadialGradient(hsx, hsy, 0, hsx, hsy, bodyRadius * 4);
      gradient.addColorStop(0, "rgba(255, 255, 100, 0.12)");
      gradient.addColorStop(1, "rgba(255, 255, 100, 0)");
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(hsx, hsy, bodyRadius * 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
    }
  }

  private drawSnakeName(ctx: CanvasRenderingContext2D, snake: LocalSnake, W: number, H: number) {
    if (!this.isInView(snake.headX, snake.headY, 200)) return;
    const sx = this.toScreenX(snake.headX);
    const sy = this.toScreenY(snake.headY);
    const nameBodyRadius = 8 + Math.log2(Math.max(40, snake.serverLength)) * 2.5;
    const nameOffset = (nameBodyRadius + 8) * this.zoom;
    const fontSize = Math.max(9, Math.round((this.isMobile ? 11 : 13) * this.zoom));

    ctx.font = `bold ${fontSize}px Arial, sans-serif`;
    ctx.textAlign = "center";
    ctx.strokeStyle = "#000000";
    ctx.lineWidth = 3;
    ctx.strokeText(snake.name, sx, sy - nameOffset);
    ctx.fillStyle = "#ffffff";
    ctx.fillText(snake.name, sx, sy - nameOffset);
  }

  // ─── Food ─────────────────────────────────────────

  private drawFood(ctx: CanvasRenderingContext2D, W: number, H: number) {
    const time = Date.now();
    // On mobile, only render food within tight margin for performance
    const foodViewMargin = this.isMobile ? -100 : 50;
    const drawGlow = this.foodGlowSmall.length > 0;
    const glowAlpha = this.isMobile ? 0.2 : 0.35;

    // Reset pre-allocated batch counts (zero allocation)
    for (let i = 0; i < FOOD_COLORS.length; i++) this.foodBatchCounts[i] = 0;

    this.room.state.food.forEach((food: any, foodId: string) => {
      if (this.eatenFoodIds.has(foodId)) return;
      if (!this.isInView(food.x, food.y, foodViewMargin)) return;

      const sx = this.toScreenX(food.x);
      const sy = this.toScreenY(food.y);
      const isDeath = food.size === 2;
      const baseSize = (isDeath ? 10 : 6) * this.zoom;
      const pulse = 1 + Math.sin(time / 400 + food.x * 0.1 + food.y * 0.1) * 0.2;
      const r = baseSize * pulse;
      const colorIdx = Math.abs(Math.floor(food.x * 7 + food.y * 13)) % FOOD_COLORS.length;

      // Draw pre-rendered glow circle (desktop only, GPU-accelerated drawImage)
      if (drawGlow) {
        const glowImg = isDeath ? this.foodGlowLarge[colorIdx] : this.foodGlowSmall[colorIdx];
        if (glowImg) {
          const glowSize = r * 4;
          ctx.globalAlpha = glowAlpha;
          ctx.drawImage(glowImg, sx - glowSize / 2, sy - glowSize / 2, glowSize, glowSize);
        }
      }

      // Write into pre-allocated batch slot
      const idx = this.foodBatchCounts[colorIdx];
      if (idx < this.foodBatchData[colorIdx].length) {
        const slot = this.foodBatchData[colorIdx][idx];
        slot.sx = sx; slot.sy = sy; slot.r = r;
        this.foodBatchCounts[colorIdx]++;
      }
    });

    // Draw solid food, batched by color
    ctx.globalAlpha = 1.0;
    for (let i = 0; i < FOOD_COLORS.length; i++) {
      const count = this.foodBatchCounts[i];
      if (count === 0) continue;
      ctx.fillStyle = FOOD_COLORS[i];
      ctx.beginPath();
      const batch = this.foodBatchData[i];
      for (let j = 0; j < count; j++) {
        const item = batch[j];
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
    const radius = this.arenaRadius * this.zoom;
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
        color = SNAKE_COLORS[snake.skinId % SNAKE_COLORS.length];
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
