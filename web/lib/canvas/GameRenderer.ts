import * as Colyseus from "colyseus.js";
import type { VoicePeer } from "../voice/VoiceChat";
import { angleDiff, clamp, lerp, DEFAULT_STEERING, updateHeadingFromTarget, updateBoost, chainConstrain, getBodyRadius } from "./steering";
import type { SnakeMotionState, BoostState } from "./steering";
import { Joystick } from "./joystick";

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
  // Server correction — applied gradually, NOT per-frame blend
  correctionX: number;
  correctionY: number;
  correctionFrames: number;
  // Smooth boost transition
  boostAlpha: number;
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

// Skin patterns: primary + secondary color, alternating every 3 segments
const SKIN_PATTERNS: { primary: string; secondary: string }[] = [
  { primary: "#4488FF", secondary: "#2244AA" },
  { primary: "#FF4466", secondary: "#AA2244" },
  { primary: "#44FF66", secondary: "#22AA44" },
  { primary: "#FFAA00", secondary: "#CC7700" },
  { primary: "#FF44FF", secondary: "#AA22AA" },
  { primary: "#00DDDD", secondary: "#008899" },
  { primary: "#FF6600", secondary: "#CC4400" },
  { primary: "#AA44FF", secondary: "#7722CC" },
  { primary: "#00FF44", secondary: "#00AA22" },
  { primary: "#FFDD00", secondary: "#CCAA00" },
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
    try { localStorage.setItem("swallowme_muted", this._muted ? "1" : "0"); } catch {}
    return this._muted;
  }

  loadMuteState() {
    try {
      const val = localStorage.getItem("swallowme_muted");
      if (val === "1") { this._muted = true; }
    } catch {}
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
  private zoom: number = 0.6;
  private targetZoom: number = 0.6;

  // Local state
  private localSnakes: Map<string, LocalSnake> = new Map();
  private arenaRadius: number = 5000;
  private bgPattern: CanvasPattern | null = null; // unused legacy
  private hexPattern: CanvasPattern | null = null;
  private hexPatternCanvas: HTMLCanvasElement | null = null;
  private bgBaseColor = '#1a1a2e';
  private bgLogoCanvas: HTMLCanvasElement | null = null;

  // Assets
  private bgImage: HTMLImageElement | null = null;
  private assetsLoaded: boolean = false;

  // Pre-rendered food glow caches (one per FOOD_COLOR, built at init)
  private foodGlowSmall: HTMLCanvasElement[] = [];   // radius ~6
  private foodGlowLarge: HTMLCanvasElement[] = [];   // radius ~10 (death food)

  // Death particles (pre-allocated pool — large for full-body explosions)
  private deathPool: PooledParticle[] = createParticlePool(1200);

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

  // Boost speed lines (pooled)
  private speedLines: { active: boolean; x: number; y: number; angle: number; length: number; life: number; maxLife: number }[] = [];
  private speedLineTimer: number = 0;

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

  // Joystick module (mobile only)
  private joystick: Joystick | null = null;
  private touchBoosting: boolean = false;

  // Fixed-step simulation accumulator
  private simAccumulator: number = 0;
  private readonly SIM_DT: number = 1 / 60;

  // Debug overlay toggle
  private debugMode: boolean = false;

  // Boost energy tracking
  private maxLengthReached: number = 40;

  // Input send throttle — only in render loop
  private lastInputSend: number = 0;
  private readonly INPUT_SEND_INTERVAL = 33;  // 30 sends/sec — match server sync rate

  // Loading
  private loadingProgress: number = 0;
  private loadingTotal: number = 1;
  private ready: boolean = false;
  private loadingSnakePhase: number = 0;

  // FPS cap for mobile
  private lastRenderTime: number = 0;
  private targetFrameInterval: number = 0; // 0 = uncapped

  // Death animation state
  private deathAnimating: boolean = false;
  private deathAnimTimer: number = 0;
  private deathAnimData: any = null;
  private deathCamX: number = 0;
  private deathCamY: number = 0;

  // Kill announcement (big centered text)
  private killAnnouncementText: string = "";
  private killAnnouncementTimer: number = 0;

  // Leaderboard cache (updated every 500ms)
  private leaderboardCache: { name: string; valueUsdc: number; isMe: boolean }[] = [];
  private lastLeaderboardUpdate: number = 0;

  // Voice chat state (set externally by SnakeGame component)
  private voicePeers: Map<string, VoicePeer> = new Map();
  private voiceSelfMuted: boolean = false;
  private voiceMuteClickHandler: ((sessionId: string) => void) | null = null;
  // Talking indicator animation: sessionId -> array of arc states
  private talkingArcs: Map<string, { age: number; maxAge: number }[]> = new Map();
  private lastTalkArcSpawn: Map<string, number> = new Map();

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

    // Initialize joystick for touch devices
    if (this.isTouchDevice) {
      this.joystick = new Joystick();
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

    // Pre-allocate speed line pool
    for (let i = 0; i < 20; i++) {
      this.speedLines.push({ active: false, x: 0, y: 0, angle: 0, length: 0, life: 0, maxLife: 0.3 });
    }

    // Pre-render food glow circles (one per color, cached forever)
    // Mobile gets smaller glow radius for perf, desktop gets full size
    const glowRadiusSmall = this.isMobile ? 8 : 16;
    const glowRadiusLarge = this.isMobile ? 14 : 24;
    for (const color of FOOD_COLORS) {
      this.foodGlowSmall.push(createGlowCircle(glowRadiusSmall, color));
      this.foodGlowLarge.push(createGlowCircle(glowRadiusLarge, color));
    }

    // Load persisted mute state
    this.audio.loadMuteState();

    // Pre-render hex tile pattern + logo for background
    this.initHexPattern();
    this.initBgLogo();

    this.preloadAssets().then(() => {
      this.assetsLoaded = true;
      this.ready = true;
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
    // Re-create hex pattern after context reset
    this.initHexPattern();
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
      const initRadius = 6 + Math.pow(Math.max(1, len - 20), 0.35) * 3;
      const initSpacing = Math.max(3, initRadius * 0.7);
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
        correctionX: 0,
        correctionY: 0,
        correctionFrames: 0,
        boostAlpha: 0,
      });

      snake.onChange(() => {
        const local = this.localSnakes.get(key);
        if (!local) return;

        // Calculate how far off our prediction was
        const errorX = snake.headX - local.headX;
        const errorY = snake.headY - local.headY;

        // Spread this correction over 5 frames (not instant, not every frame)
        local.correctionX = errorX;
        local.correctionY = errorY;
        local.correctionFrames = 5;

        // Update server values for reference
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
        // Full-body death explosion along all segments
        const color = SKIN_PATTERNS[snake.skinId % SKIN_PATTERNS.length].primary;
        const step = Math.max(1, Math.floor(snake.segments.length / 300));
        for (let i = 0; i < snake.segments.length; i += step) {
          const seg = snake.segments[i];
          this.emitPool(this.deathPool, seg.x, seg.y, 2, color, 3, 1.5, 4, 10);
        }
        if (key === this.mySessionId) {
          this.shakeLife = 0.2;
        }
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
        // Big centered kill announcement
        this.killAnnouncementText = `ATE ${entry.victimName.toUpperCase()}`;
        this.killAnnouncementTimer = 2.0;
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
      console.log('[DEATH] GameRenderer received server death message:', data);
      this.audio.playDeath();
      // Spawn full-body explosion along all segments
      const me = this.localSnakes.get(this.mySessionId);
      if (me && me.segments.length > 0) {
        const color = SKIN_PATTERNS[me.skinId % SKIN_PATTERNS.length].primary;
        // Emit 2-3 particles per segment along the entire body
        const step = Math.max(1, Math.floor(me.segments.length / 400)); // cap total particles
        for (let i = 0; i < me.segments.length; i += step) {
          const seg = me.segments[i];
          this.emitPool(this.deathPool, seg.x, seg.y, 2, color, 3, 2.0, 4, 10);
        }
        // Lock camera at death position
        this.deathCamX = me.headX;
        this.deathCamY = me.headY;
      }
      this.shakeLife = 0.3;
      // Start death animation — delay showing overlay
      this.deathAnimating = true;
      this.deathAnimTimer = 2.5;
      this.deathAnimData = data;
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
    const color = SKIN_PATTERNS[skinId % SKIN_PATTERNS.length].primary;
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
    const color = SKIN_PATTERNS[snake.skinId % SKIN_PATTERNS.length].primary;
    this.emitPool(this.boostPool, tail.x + (Math.random() - 0.5) * 8, tail.y + (Math.random() - 0.5) * 8, 1, color, 2, 0.8, 2, 5);
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
      this.canvas.addEventListener("mousedown", (e) => {
        if (this.handleVoicePanelClick(e.clientX, e.clientY)) return;
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

    // --- TOUCH INPUT (delegated to Joystick module) ---
    if (this.isTouchDevice && this.joystick) {
      const js = this.joystick;
      this.canvas.addEventListener("touchstart", (e) => {
        e.preventDefault();
        e.stopPropagation();
        js.onTouchStart(e.changedTouches, this.cssW, this.cssH, (x, y) => this.handleVoicePanelClick(x, y));
        this.touchBoosting = js.boosting;
      }, { passive: false });

      this.canvas.addEventListener("touchmove", (e) => {
        e.preventDefault();
        e.stopPropagation();
        js.onTouchMove(e.changedTouches, this.cssW, this.cssH);
      }, { passive: false });

      this.canvas.addEventListener("touchend", (e) => {
        e.preventDefault();
        e.stopPropagation();
        js.onTouchEnd(e.changedTouches, this.cssW, this.cssH);
        this.touchBoosting = js.boosting;
      }, { passive: false });

      this.canvas.addEventListener("touchcancel", (e) => {
        e.preventDefault();
        e.stopPropagation();
        js.onTouchCancel(this.cssW, this.cssH);
        this.touchBoosting = js.boosting;
      }, { passive: false });
    }

    // --- DEBUG TOGGLE ---
    window.addEventListener("keydown", (e) => {
      if (e.key === "`") this.debugMode = !this.debugMode;
    });
  }

  // ─── Boost Button (bottom-right, mobile) ──────────

  private getBoostButtonCenter(): { x: number; y: number; radius: number } {
    const isLandscape = this.cssW > this.cssH;
    if (isLandscape) {
      return { x: this.cssW - 60, y: this.cssH * 0.45, radius: 32 };
    }
    return { x: this.cssW - 60, y: this.cssH - 90, radius: 40 };
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

  // ─── Public: voice chat state ─────────────────────

  public updateVoiceState(peers: Map<string, VoicePeer>, selfMuted: boolean): void {
    this.voicePeers = peers;
    this.voiceSelfMuted = selfMuted;
  }

  public setVoiceMuteClickHandler(handler: (sessionId: string) => void): void {
    this.voiceMuteClickHandler = handler;
  }

  public getLocalSnakes(): Map<string, any> {
    return this.localSnakes;
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
      // Fixed-step simulation — deterministic across all FPS
      this.simAccumulator += Math.min(this.dt, 0.1);
      while (this.simAccumulator >= this.SIM_DT) {
        this.update(this.SIM_DT);
        this.simAccumulator -= this.SIM_DT;
      }
      this.draw();
      // Draw touch controls on main canvas AFTER all game rendering (screen coords)
      if (this.isTouchDevice) {
        if (this.joystick) this.joystick.draw(this.ctx, this.cssW, this.cssH);
        this.drawBoostButton(this.ctx);
      }
      // Debug overlay
      if (this.debugMode) this.drawDebugOverlay();
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

  // ─── Debug Overlay ──────────────────────────────────

  private drawDebugOverlay() {
    const ctx = this.ctx;
    const me = this.localSnakes.get(this.mySessionId);
    if (!me || !me.alive) return;

    // World-to-screen transform
    const toSx = (wx: number) => (wx - this.camX) * this.zoom + this.cssW / 2;
    const toSy = (wy: number) => (wy - this.camY) * this.zoom + this.cssH / 2;

    const hx = toSx(me.headX);
    const hy = toSy(me.headY);

    // Input angle ray (green)
    ctx.beginPath();
    ctx.moveTo(hx, hy);
    ctx.lineTo(hx + Math.cos(this.inputAngle) * 80, hy + Math.sin(this.inputAngle) * 80);
    ctx.strokeStyle = "#00ff00";
    ctx.lineWidth = 2;
    ctx.stroke();

    // Current heading ray (yellow)
    ctx.beginPath();
    ctx.moveTo(hx, hy);
    ctx.lineTo(hx + Math.cos(me.angle) * 60, hy + Math.sin(me.angle) * 60);
    ctx.strokeStyle = "#ffff00";
    ctx.lineWidth = 2;
    ctx.stroke();

    // Server ghost position (faint red circle)
    const sgx = toSx(me.serverHeadX);
    const sgy = toSy(me.serverHeadY);
    ctx.beginPath();
    ctx.arc(sgx, sgy, 8, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(255, 50, 50, 0.6)";
    ctx.lineWidth = 1;
    ctx.stroke();

    // Collision radius circle
    const bodyR = getBodyRadius(me.serverLength || 40) * this.zoom;
    ctx.beginPath();
    ctx.arc(hx, hy, bodyR, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(255, 255, 0, 0.3)";
    ctx.lineWidth = 1;
    ctx.stroke();

    // Text info
    const delta = angleDiff(this.inputAngle, me.angle);
    const smoothSpeed = lerp(240, 480, me.boostAlpha);
    const maxTurn = lerp(DEFAULT_STEERING.turnRateSlow, DEFAULT_STEERING.turnRateFast, me.boostAlpha);

    ctx.font = "12px monospace";
    ctx.fillStyle = "#00ff88";
    ctx.textAlign = "left";
    const drift = Math.sqrt((me.headX - me.serverHeadX) ** 2 + (me.headY - me.serverHeadY) ** 2);
    const lines = [
      `FPS: ${this.fps}`,
      `delta: ${(delta * 180 / Math.PI).toFixed(1)}°`,
      `maxTurn: ${maxTurn.toFixed(2)} rad/s`,
      `drift: ${drift.toFixed(1)} px`,
      `correction: ${me.correctionFrames} frames`,
      `boostAlpha: ${me.boostAlpha.toFixed(2)}`,
      `speed: ${smoothSpeed.toFixed(0)} px/s`,
    ];
    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], 10, 20 + i * 16);
    }
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

    // Update joystick smoothing (dt-based exponential filter)
    if (this.joystick) {
      this.joystick.update(dt);
      const jOut = this.joystick.getOutput();
      if (jOut.hasInput) {
        this.inputAngle = jOut.angle;
      }
      this.touchBoosting = jOut.boosting;
    }

    for (const [id, snake] of this.localSnakes) {
      if (!snake.alive) continue;
      const isMe = id === this.mySessionId;

      if (isMe) {
        // ═══ LOCAL PLAYER — predictive steering with smooth boost ═══
        const isBoosting = this.touchBoosting || this.mouseDown;

        // Smooth boost transition (no instant toggle)
        const boost: BoostState = { boostAlpha: snake.boostAlpha, wantsBoost: isBoosting };
        updateBoost(boost, dt);
        snake.boostAlpha = boost.boostAlpha;

        // Speed derived from smoothed boost alpha
        const speedPxPerSec = lerp(240, 480, snake.boostAlpha); // 8*30=240, 16*30=480

        // Build motion state for steering module
        const motion: SnakeMotionState = {
          heading: snake.angle,
          speed: speedPxPerSec,
          minSpeed: 240,
          maxSpeed: 480,
        };

        // Virtual target point from joystick/mouse angle
        const targetDist = 200;
        const targetX = snake.headX + Math.cos(this.inputAngle) * targetDist;
        const targetY = snake.headY + Math.sin(this.inputAngle) * targetDist;

        updateHeadingFromTarget(motion, snake.headX, snake.headY, targetX, targetY, dt, DEFAULT_STEERING);
        snake.angle = motion.heading;

        // Move forward at smoothed speed
        snake.headX += Math.cos(snake.angle) * speedPxPerSec * dt;
        snake.headY += Math.sin(snake.angle) * speedPxPerSec * dt;

        // Server correction: spread over 5 frames, only set by onChange
        if (snake.correctionFrames > 0) {
          const frac = 1 / snake.correctionFrames;
          snake.headX += snake.correctionX * frac;
          snake.headY += snake.correctionY * frac;
          snake.correctionX -= snake.correctionX * frac;
          snake.correctionY -= snake.correctionY * frac;
          snake.correctionFrames--;
        }

        // Boost sound and particles
        if (isBoosting && !this.wasBoosting) this.audio.startBoost();
        if (!isBoosting && this.wasBoosting) this.audio.stopBoost();
        this.wasBoosting = isBoosting;
        if (snake.boostAlpha > 0.1 && this.boostFrameCounter % 3 === 0) {
          this.spawnBoostParticle(snake);
        }

      } else {
        // ═══ OTHER SNAKES — turn-rate steering with smooth boost ═══
        // Smooth boost transition for others too
        const otherBoost: BoostState = { boostAlpha: snake.boostAlpha, wantsBoost: snake.boosting };
        updateBoost(otherBoost, dt);
        snake.boostAlpha = otherBoost.boostAlpha;

        const delta = angleDiff(snake.serverAngle, snake.angle);
        const otherSpeed = lerp(240, 480, snake.boostAlpha);
        const otherTurnRate = lerp(DEFAULT_STEERING.turnRateSlow, DEFAULT_STEERING.turnRateFast, snake.boostAlpha);
        const maxStep = otherTurnRate * dt;
        snake.angle += clamp(delta, -maxStep, maxStep);

        // Move forward at smoothed speed
        snake.headX += Math.cos(snake.angle) * otherSpeed * dt;
        snake.headY += Math.sin(snake.angle) * otherSpeed * dt;

        // Tight lerp toward server position to reduce visual/server mismatch
        snake.headX += (snake.serverHeadX - snake.headX) * 0.5;
        snake.headY += (snake.serverHeadY - snake.headY) * 0.5;

        // Server correction (residual from onChange spread)
        if (snake.correctionFrames > 0) {
          const frac = 1 / snake.correctionFrames;
          snake.headX += snake.correctionX * frac;
          snake.headY += snake.correctionY * frac;
          snake.correctionX -= snake.correctionX * frac;
          snake.correctionY -= snake.correctionY * frac;
          snake.correctionFrames--;
        }

        if (snake.boostAlpha > 0.1 && this.boostFrameCounter % 3 === 0 && this.isInView(snake.headX, snake.headY, 300)) {
          this.spawnBoostParticle(snake);
        }
      }

      // ═══ SAFETY: hard snap if >200 units from server ═══
      const ex = snake.serverHeadX - snake.headX;
      const ey = snake.serverHeadY - snake.headY;
      if (ex * ex + ey * ey > 40000) {
        snake.headX = snake.serverHeadX;
        snake.headY = snake.serverHeadY;
        snake.correctionFrames = 0;
      }

      // ═══ CHAIN CONSTRAINT (shared utility) ═══
      if (snake.segments.length > 0) {
        snake.segments[0].x = snake.headX;
        snake.segments[0].y = snake.headY;
      }
      chainConstrain(snake.segments, 4);

      // LENGTH
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

    // Screen shake decay — suppress during boost
    const mySnake = this.localSnakes.get(this.mySessionId);
    const isBoosting = this.touchBoosting || this.mouseDown;
    if (isBoosting) {
      // No shake while boosting — speed lines provide the speed feeling
      this.shakeLife = 0;
      this.shakeX = 0;
      this.shakeY = 0;
    } else if (this.shakeLife > 0) {
      this.shakeLife -= dt;
      const intensity = Math.max(0, this.shakeLife / 0.2) * 5;
      this.shakeX = (Math.random() - 0.5) * 2 * intensity;
      this.shakeY = (Math.random() - 0.5) * 2 * intensity;
    } else {
      this.shakeX = 0;
      this.shakeY = 0;
    }

    // Speed line spawning during boost
    if (mySnake && mySnake.alive && mySnake.boostAlpha > 0.3) {
      this.speedLineTimer += dt;
      if (this.speedLineTimer > 2 / 60) { // ~1 line every 2 frames
        this.speedLineTimer = 0;
        for (const sl of this.speedLines) {
          if (sl.active) continue;
          sl.active = true;
          sl.x = mySnake.headX + (Math.random() - 0.5) * 40;
          sl.y = mySnake.headY + (Math.random() - 0.5) * 40;
          sl.angle = mySnake.angle + (Math.random() - 0.5) * (Math.PI / 6); // ±15°
          sl.length = 60 + Math.random() * 60; // 60-120 px
          sl.life = 0.3;
          sl.maxLife = 0.3;
          break;
        }
      }
    }

    // Update speed lines
    for (const sl of this.speedLines) {
      if (!sl.active) continue;
      sl.life -= dt;
      if (sl.life <= 0) sl.active = false;
    }

    // Death animation countdown
    if (this.deathAnimating) {
      this.deathAnimTimer -= dt;
      if (this.deathAnimTimer <= 0) {
        this.deathAnimating = false;
        console.log('[DEATH] GameRenderer animation complete, calling onDeath callback');
        this.onDeath?.(this.deathAnimData);
        this.deathAnimData = null;
      }
    }

    // Kill announcement decay
    if (this.killAnnouncementTimer > 0) {
      this.killAnnouncementTimer -= dt;
    }

    // Leaderboard update (every 500ms)
    const now3 = performance.now();
    if (now3 - this.lastLeaderboardUpdate > 500) {
      this.lastLeaderboardUpdate = now3;
      this.updateLeaderboard();
    }

    // Camera — smooth follow + dynamic zoom (dt-based)
    const camLerp = 1 - Math.pow(0.0001, dt);
    const camMe = this.localSnakes.get(this.mySessionId);
    if (this.deathAnimating || (this.deathAnimData === null && !camMe?.alive && this.deathCamX !== 0)) {
      // Hold camera at death position with shake
      this.camX = this.deathCamX + this.shakeX;
      this.camY = this.deathCamY + this.shakeY;
    } else if (camMe && camMe.alive) {
      this.camX += (camMe.headX - this.camX) * camLerp + this.shakeX;
      this.camY += (camMe.headY - this.camY) * camLerp + this.shakeY;

      // Zoom out as snake grows: length 40→1.0, length 200→0.7, length 500→0.5
      const len = camMe.serverLength || 40;
      this.targetZoom = Math.max(0.3, Math.min(0.6, 0.6 - (len - 40) / 500));
      this.zoom += (this.targetZoom - this.zoom) * Math.min(1, 0.06 * dt * 60);

      // Trail: spawn every frame, bigger on mobile
      const trailColor = SKIN_PATTERNS[camMe.skinId % SKIN_PATTERNS.length].primary;
      const seg1 = camMe.segments[1];
      if (seg1) {
        const trailSizeMin = this.isMobile ? 6 : 4;
        const trailSizeMax = this.isMobile ? 12 : 8;
        this.emitPool(this.trailPool, seg1.x, seg1.y, 1, trailColor, 0.3, 0.5, trailSizeMin, trailSizeMax);
      }

      // Track max length for boost energy arc
      if (camMe.serverLength > this.maxLengthReached) {
        this.maxLengthReached = camMe.serverLength;
      }

      this.onStatsUpdate?.({
        kills: camMe.kills,
        value: camMe.valueUsdc / 1_000_000,
        alive: this.room.state.aliveCount || 0,
        length: camMe.serverLength,
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
        w: (this.cssW / this.zoom) * 1.5,
        h: (this.cssH / this.zoom) * 1.5,
      });
    }
  }

  // ─── Drawing ──────────────────────────────────────

  private draw() {
    const W = this.cssW;
    const H = this.cssH;
    const ctx = this.ctx;

    // Hex background (fills base color + pattern, no clearRect needed)
    this.drawHexBackground(ctx, this.camX, this.camY, this.zoom, W, H);
    this.drawHexLogos(ctx, this.camX, this.camY, this.zoom, W, H);

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
        this.drawSnakeName(ctx, snake, id, W, H);
      }
    }

    // Boost speed lines (behind death particles)
    this.drawSpeedLines(ctx, W, H);

    // Boost head glow (only for local player)
    const meSnake = this.localSnakes.get(this.mySessionId);
    if (meSnake && meSnake.alive && meSnake.boostAlpha > 0.1) {
      this.drawBoostHeadGlow(ctx, meSnake, W, H);
    }

    // Death explosion particles (additive for impact)
    this.drawPool(ctx, this.deathPool, W, H, true);
    this.drawEatPopups(ctx, W, H);

    // HUD elements (screen-space, not affected by zoom)
    this.drawKillFeed(ctx, W, H);
    this.drawMinimap(ctx, W, H);
    this.drawLeaderboard(ctx, W, H);
    this.drawVoicePanel(ctx, W, H);
    this.drawKillAnnouncement(ctx, W, H);
  }

  // ─── Hexagon Background Pattern ─────────────────

  private initHexPattern(): void {
    const r = 40;
    const w = Math.sqrt(3) * r;
    const vStep = 1.5 * r;
    const tileW = w * 2;
    const tileH = vStep * 2;

    const c = document.createElement('canvas');
    c.width = Math.ceil(tileW);
    c.height = Math.ceil(tileH);
    const g = c.getContext('2d')!;

    g.fillStyle = '#1a1a2e';
    g.fillRect(0, 0, c.width, c.height);

    const drawHex = (cx: number, cy: number, radius: number) => {
      g.beginPath();
      for (let i = 0; i < 6; i++) {
        const a = i * (Math.PI / 3) - Math.PI / 6;
        const x = cx + radius * Math.cos(a);
        const y = cy + radius * Math.sin(a);
        if (i === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      g.closePath();
    };

    const centers: Array<[number, number]> = [
      [w * 0.5, r],
      [w * 1.5, r],
      [w * 1.0, r + vStep],
      [w * 2.0, r + vStep],
    ];

    for (const [cx, cy] of centers) {
      drawHex(cx, cy, r - 0.5);
      g.fillStyle = '#141425';
      g.fill();

      drawHex(cx, cy, r - 0.5);
      g.strokeStyle = 'rgba(255,255,255,0.06)';
      g.lineWidth = 1;
      g.stroke();
    }

    this.hexPatternCanvas = c;
    this.hexPattern = this.ctx.createPattern(c, 'repeat');
  }

  private initBgLogo(): void {
    const c = document.createElement('canvas');
    c.width = 200;
    c.height = 100;
    const g = c.getContext('2d')!;

    g.clearRect(0, 0, c.width, c.height);
    g.shadowColor = 'rgba(0, 230, 118, 0.3)';
    g.shadowBlur = 6;
    g.font = '800 48px Inter, Arial, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'top';
    g.fillStyle = '#ffffff';
    g.fillText('BUY', 100, 4);
    g.fillStyle = '#00E676';
    g.fillText('MONEY', 100, 50);

    this.bgLogoCanvas = c;
  }

  private drawHexBackground(
    ctx: CanvasRenderingContext2D,
    camX: number,
    camY: number,
    zoom: number,
    W: number,
    H: number,
  ): void {
    ctx.save();
    ctx.fillStyle = this.bgBaseColor;
    ctx.fillRect(0, 0, W, H);

    if (!this.hexPattern || !this.hexPatternCanvas) {
      ctx.restore();
      return;
    }

    const tw = this.hexPatternCanvas.width;
    const th = this.hexPatternCanvas.height;
    const ox = ((-camX * zoom) % tw + tw) % tw;
    const oy = ((-camY * zoom) % th + th) % th;

    ctx.translate(ox - tw, oy - th);
    ctx.fillStyle = this.hexPattern;
    ctx.fillRect(0, 0, W + tw * 2, H + th * 2);

    ctx.restore();
  }

  private drawHexLogos(
    ctx: CanvasRenderingContext2D,
    camX: number,
    camY: number,
    zoom: number,
    W: number,
    H: number,
  ): void {
    if (!this.bgLogoCanvas) return;

    const r = 40; // must match initHexPattern()
    const w = Math.sqrt(3) * r;
    const vStep = 1.5 * r;

    const margin = r * 2;
    const worldLeft = camX - W / zoom / 2 - margin;
    const worldRight = camX + W / zoom / 2 + margin;
    const worldTop = camY - H / zoom / 2 - margin;
    const worldBottom = camY + H / zoom / 2 + margin;

    const rowStart = Math.floor(worldTop / vStep) - 1;
    const rowEnd = Math.ceil(worldBottom / vStep) + 1;
    const colStart = Math.floor(worldLeft / w) - 1;
    const colEnd = Math.ceil(worldRight / w) + 1;

    ctx.save();
    ctx.globalAlpha = 0.12;

    for (let row = rowStart; row <= rowEnd; row++) {
      for (let col = colStart; col <= colEnd; col++) {
        // deterministic ~1/25 fill rate (no per-frame randomness/flicker)
        const hash = ((row * 7919 + col * 104729) & 0x7fffffff) % 25;
        if (hash !== 0) continue;

        // Match initHexPattern tile offsets exactly:
        // even rows center at x = col*w + w*0.5; odd rows at x = col*w + w*1.0
        const cx = col * w + (row & 1 ? w * 0.5 : 0) + w * 0.5;
        const cy = row * vStep + r;

        const sx = (cx - camX) * zoom + W * 0.5;
        const sy = (cy - camY) * zoom + H * 0.5;
        if (sx < -r * zoom || sy < -r * zoom || sx > W + r * zoom || sy > H + r * zoom) continue;

        const logoW = (w * 0.9) * zoom;
        const logoH = logoW * 0.5; // 200x100 source aspect

        ctx.drawImage(this.bgLogoCanvas, sx - logoW * 0.5, sy - logoH * 0.5, logoW, logoH);
      }
    }

    ctx.restore();
  }

  // ─── Coordinate helpers (zoom-aware) ──────────────

  private toScreenX(wx: number): number { return (wx - this.camX) * this.zoom + this.cssW / 2; }
  private toScreenY(wy: number): number { return (wy - this.camY) * this.zoom + this.cssH / 2; }

  // ─── Boost Speed Lines ───────────────────────────

  private drawSpeedLines(ctx: CanvasRenderingContext2D, W: number, H: number): void {
    for (const sl of this.speedLines) {
      if (!sl.active) continue;
      const t = sl.life / sl.maxLife; // 1→0

      // World to screen
      const sx = (sl.x - this.camX) * this.zoom + W / 2;
      const sy = (sl.y - this.camY) * this.zoom + H / 2;
      if (sx < -200 || sx > W + 200 || sy < -200 || sy > H + 200) continue;

      const len = sl.length * this.zoom;
      const ex = sx - Math.cos(sl.angle) * len; // lines trail behind
      const ey = sy - Math.sin(sl.angle) * len;

      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(ex, ey);
      ctx.strokeStyle = `rgba(255, 255, 255, ${0.15 * t})`;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  // ─── Boost Head Glow ────────────────────────────

  private drawBoostHeadGlow(ctx: CanvasRenderingContext2D, snake: LocalSnake, W: number, H: number): void {
    const hx = (snake.headX - this.camX) * this.zoom + W / 2;
    const hy = (snake.headY - this.camY) * this.zoom + H / 2;
    const bodyR = getBodyRadius(snake.serverLength || 40) * this.zoom;
    const glowR = bodyR * 3;

    // Alpha pulses with sin
    const pulseAlpha = 0.1 + 0.15 * Math.abs(Math.sin(performance.now() / 1000 * 8));
    const alpha = pulseAlpha * snake.boostAlpha;

    const grad = ctx.createRadialGradient(hx, hy, bodyR * 0.5, hx, hy, glowR);
    grad.addColorStop(0, `rgba(255, 255, 255, ${alpha})`);
    grad.addColorStop(1, "rgba(255, 255, 255, 0)");

    ctx.beginPath();
    ctx.arc(hx, hy, glowR, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();
  }

  // ─── Snake Drawing ────────────────────────────────

  private drawSnake(ctx: CanvasRenderingContext2D, snake: LocalSnake, W: number, H: number, isMe: boolean) {
    if (!snake.alive || snake.segments.length < 2) return;

    const bodyRadius = (6 + Math.pow(Math.max(1, snake.serverLength - 20), 0.35) * 3) * this.zoom;
    const skinIdx = snake.skinId % SKIN_PATTERNS.length;
    const skin = SKIN_PATTERNS[skinIdx];
    const snakeColor = skin.primary;
    const secondaryColor = skin.secondary;
    const outlineColor = darkenColor(snakeColor, 0.4);

    ctx.globalAlpha = 1.0;
    const segCount = snake.segments.length;

    // --- PASS 1: Dark outline (slightly larger circles, batched) ---
    ctx.fillStyle = outlineColor;
    ctx.beginPath();
    for (let i = segCount - 1; i >= 0; i--) {
      const seg = snake.segments[i];
      if (!this.isInView(seg.x, seg.y, 200)) continue;
      const sx = this.toScreenX(seg.x);
      const sy = this.toScreenY(seg.y);
      ctx.moveTo(sx + bodyRadius + 2, sy);
      ctx.arc(sx, sy, bodyRadius + 2, 0, Math.PI * 2);
    }
    ctx.fill();

    // --- PASS 2: Patterned body (primary/secondary alternating every 3 segments) ---
    // Batch primary segments
    ctx.fillStyle = snakeColor;
    ctx.beginPath();
    for (let i = segCount - 1; i >= 0; i--) {
      if (Math.floor(i / 3) % 2 !== 0) continue;
      const seg = snake.segments[i];
      if (!this.isInView(seg.x, seg.y, 200)) continue;
      const sx = this.toScreenX(seg.x);
      const sy = this.toScreenY(seg.y);
      ctx.moveTo(sx + bodyRadius, sy);
      ctx.arc(sx, sy, bodyRadius, 0, Math.PI * 2);
    }
    ctx.fill();

    // Batch secondary segments
    ctx.fillStyle = secondaryColor;
    ctx.beginPath();
    for (let i = segCount - 1; i >= 0; i--) {
      if (Math.floor(i / 3) % 2 === 0) continue;
      const seg = snake.segments[i];
      if (!this.isInView(seg.x, seg.y, 200)) continue;
      const sx = this.toScreenX(seg.x);
      const sy = this.toScreenY(seg.y);
      ctx.moveTo(sx + bodyRadius, sy);
      ctx.arc(sx, sy, bodyRadius, 0, Math.PI * 2);
    }
    ctx.fill();

    // --- PASS 3: Center highlight for 3D tube illusion (no directional offset) ---
    const highlightColor = lightenColor(snakeColor, 0.3);
    ctx.fillStyle = highlightColor;
    ctx.globalAlpha = 0.25;
    ctx.beginPath();
    for (let i = segCount - 1; i >= 0; i--) {
      const seg = snake.segments[i];
      if (!this.isInView(seg.x, seg.y, 200)) continue;
      const sx = this.toScreenX(seg.x);
      const sy = this.toScreenY(seg.y);
      ctx.moveTo(sx + bodyRadius * 0.4, sy);
      ctx.arc(sx, sy, bodyRadius * 0.4, 0, Math.PI * 2);
    }
    ctx.fill();
    ctx.globalAlpha = 1.0;

    // --- HEAD (seamless with body + eyes on top) ---
    const head = snake.segments[0];
    if (!this.isInView(head.x, head.y, 200)) return;

    const hsx = this.toScreenX(head.x);
    const hsy = this.toScreenY(head.y);
    ctx.save();
    ctx.translate(hsx, hsy);
    ctx.rotate(snake.angle);

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

  private drawSnakeName(ctx: CanvasRenderingContext2D, snake: LocalSnake, snakeId: string, W: number, H: number) {
    if (!this.isInView(snake.headX, snake.headY, 200)) return;
    const sx = this.toScreenX(snake.headX);
    const sy = this.toScreenY(snake.headY);
    const bodyRadius = (6 + Math.pow(Math.max(1, snake.serverLength - 20), 0.35) * 3) * this.zoom;

    // Voice talking indicator (sound wave arcs above head)
    const voicePeer = this.voicePeers.get(snakeId);
    if (voicePeer && voicePeer.isTalking && !voicePeer.isMutedByMe) {
      this.drawTalkingIndicator(ctx, sx, sy, bodyRadius);
    }

    // USDC value above everything
    const value = snake.valueUsdc / 1_000_000;
    if (value > 0) {
      const valueOffset = bodyRadius + (this.isMobile ? 28 : 34);
      const valueFontSize = Math.max(8, Math.round((this.isMobile ? 10 : 12) * this.zoom));
      ctx.font = `bold ${valueFontSize}px Arial, sans-serif`;
      ctx.textAlign = "center";
      ctx.strokeStyle = "#000000";
      ctx.lineWidth = 3;
      const valueText = `$${value.toFixed(2)}`;
      ctx.strokeText(valueText, sx, sy - valueOffset);
      ctx.fillStyle = "#22cc44";
      ctx.fillText(valueText, sx, sy - valueOffset);
    }

    // Name below the value
    const nameOffset = bodyRadius + (this.isMobile ? 16 : 20);
    const fontSize = Math.max(9, Math.round((this.isMobile ? 11 : 13) * this.zoom));
    ctx.font = `bold ${fontSize}px Arial, sans-serif`;
    ctx.textAlign = "center";
    ctx.strokeStyle = "#000000";
    ctx.lineWidth = 3;
    ctx.strokeText(snake.name, sx, sy - nameOffset);
    ctx.fillStyle = "#ffffff";
    ctx.fillText(snake.name, sx, sy - nameOffset);
  }

  private drawTalkingIndicator(ctx: CanvasRenderingContext2D, sx: number, sy: number, bodyRadius: number) {
    const now = Date.now();
    const arcCount = 3;
    const cycleTime = 900; // ms for full cycle
    const phase = (now % cycleTime) / cycleTime;

    ctx.save();
    ctx.lineWidth = 2;
    for (let i = 0; i < arcCount; i++) {
      const arcPhase = (phase + i / arcCount) % 1;
      const radius = bodyRadius + 8 + arcPhase * 18;
      const alpha = 0.5 * (1 - arcPhase);
      if (alpha <= 0) continue;
      ctx.strokeStyle = `rgba(255, 255, 255, ${alpha.toFixed(2)})`;
      ctx.beginPath();
      ctx.arc(sx, sy - bodyRadius - 6, radius * 0.5, -Math.PI * 0.8, -Math.PI * 0.2);
      ctx.stroke();
    }
    ctx.restore();
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
      const baseSize = (isDeath ? 14 : 6) * this.zoom;
      const pulseAmp = isDeath ? 0.3 : 0.2;
      const pulse = 1 + Math.sin(time / 400 + food.x * 0.1 + food.y * 0.1) * pulseAmp;
      const r = baseSize * pulse;
      const colorIdx = Math.abs(Math.floor(food.x * 7 + food.y * 13)) % FOOD_COLORS.length;

      // Draw pre-rendered glow circle (GPU-accelerated drawImage)
      if (drawGlow) {
        const glowImg = isDeath ? this.foodGlowLarge[colorIdx] : this.foodGlowSmall[colorIdx];
        if (glowImg) {
          const glowMult = isDeath ? 6 : 4;
          const glowSize = r * glowMult;
          ctx.globalAlpha = isDeath ? 0.5 : glowAlpha;
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

    const centerX = mx + SIZE / 2;
    const centerY = my + SIZE / 2;
    const arenaR = this.arenaRadius * scale;

    // Subtle circular background matching the arena shape
    ctx.beginPath();
    ctx.arc(centerX, centerY, arenaR + 4, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(0, 0, 0, 0.4)";
    ctx.fill();

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

  // ─── Leaderboard ────────────────────────────────────

  private updateLeaderboard() {
    const entries: { name: string; valueUsdc: number; isMe: boolean }[] = [];
    for (const [id, snake] of this.localSnakes) {
      if (!snake.alive) continue;
      entries.push({ name: snake.name, valueUsdc: snake.valueUsdc, isMe: id === this.mySessionId });
    }
    entries.sort((a, b) => b.valueUsdc - a.valueUsdc);
    this.leaderboardCache = entries.slice(0, 5);
  }

  private drawLeaderboard(ctx: CanvasRenderingContext2D, W: number, H: number) {
    if (this.leaderboardCache.length === 0) return;

    const fontSize = this.isMobile ? 9 : 13;
    const lineH = this.isMobile ? 16 : 24;
    const padding = this.isMobile ? 6 : 10;
    const panelW = this.isMobile ? 120 : 170;
    const headerH = lineH + 2;
    const panelH = headerH + this.leaderboardCache.length * lineH + padding;
    const px = 12;
    const py = this.isMobile ? 80 : 100;

    // Panel background
    ctx.globalAlpha = 0.6;
    ctx.fillStyle = "#000000";
    ctx.beginPath();
    ctx.roundRect(px, py, panelW, panelH, 8);
    ctx.fill();
    ctx.globalAlpha = 1.0;

    // Header
    ctx.font = `bold ${fontSize}px Arial, sans-serif`;
    ctx.textAlign = "left";
    ctx.fillStyle = "#888888";
    ctx.fillText("TOP SNAKES", px + padding, py + fontSize + 4);

    // Entries
    ctx.font = `${fontSize}px Arial, sans-serif`;
    for (let i = 0; i < this.leaderboardCache.length; i++) {
      const entry = this.leaderboardCache[i];
      const ey = py + headerH + i * lineH + fontSize;

      // Rank + Name
      ctx.fillStyle = entry.isMe ? "#00FF66" : "#cccccc";
      const rank = `${i + 1}. `;
      ctx.fillText(rank, px + padding, ey);
      const rankW = ctx.measureText(rank).width;

      // Name (truncated)
      const valueStr = `$${(entry.valueUsdc / 1_000_000).toFixed(2)}`;
      const valueW = ctx.measureText(valueStr).width;
      const maxNameW = panelW - padding * 2 - rankW - valueW - 6;
      let name = entry.name;
      while (ctx.measureText(name).width > maxNameW && name.length > 3) {
        name = name.slice(0, -1);
      }
      ctx.fillText(name, px + padding + rankW, ey);

      // USDC value
      ctx.textAlign = "right";
      ctx.fillStyle = entry.isMe ? "#00FF66" : "#22CC66";
      ctx.fillText(valueStr, px + panelW - padding, ey);
      ctx.textAlign = "left";
    }
  }

  // ─── Voice Chat Panel ────────────────────────────────

  private drawVoicePanel(ctx: CanvasRenderingContext2D, W: number, H: number) {
    if (this.voicePeers.size === 0) return;

    const fontSize = this.isMobile ? 9 : 12;
    const lineH = this.isMobile ? 16 : 22;
    const padding = this.isMobile ? 6 : 10;
    const panelW = this.isMobile ? 110 : 150;
    const headerH = lineH + 2;

    // Position below leaderboard
    const leaderboardEntries = this.leaderboardCache.length;
    const leaderboardH = leaderboardEntries > 0
      ? headerH + leaderboardEntries * (this.isMobile ? 16 : 24) + padding
      : 0;
    const px = 12;
    const py = (this.isMobile ? 80 : 100) + leaderboardH + 8;

    const entries = Array.from(this.voicePeers.values());
    const panelH = headerH + entries.length * lineH + padding;

    // Panel background
    ctx.globalAlpha = 0.6;
    ctx.fillStyle = "#000000";
    ctx.beginPath();
    ctx.roundRect(px, py, panelW, panelH, 8);
    ctx.fill();
    ctx.globalAlpha = 1.0;

    // Header
    ctx.font = `bold ${fontSize}px Arial, sans-serif`;
    ctx.textAlign = "left";
    ctx.fillStyle = "#888888";
    const micIcon = this.voiceSelfMuted ? "\u{1F507}" : "\u{1F3A4}";
    ctx.fillText(`${micIcon} VOICE`, px + padding, py + fontSize + 4);

    // Entries
    ctx.font = `${fontSize}px Arial, sans-serif`;
    for (let i = 0; i < entries.length; i++) {
      const peer = entries[i];
      const ey = py + headerH + i * lineH + fontSize;

      // Status circle: green pulsing = talking, gray = silent, red = muted by me
      const circleX = px + padding + 5;
      const circleY = ey - fontSize / 2 + 2;
      const circleR = 4;

      ctx.beginPath();
      ctx.arc(circleX, circleY, circleR, 0, Math.PI * 2);
      if (peer.isMutedByMe) {
        ctx.fillStyle = "#cc3333";
      } else if (peer.isTalking) {
        const pulse = 0.7 + Math.sin(Date.now() / 150) * 0.3;
        ctx.fillStyle = `rgba(0, 255, 100, ${pulse.toFixed(2)})`;
      } else {
        ctx.fillStyle = "#555555";
      }
      ctx.fill();

      // Name (truncated to 8 chars)
      let name = peer.name;
      if (name.length > 8) name = name.slice(0, 7) + "\u2026";
      ctx.fillStyle = peer.isMutedByMe ? "#666666" : "#cccccc";
      ctx.fillText(name, circleX + 10, ey);

      // Strikethrough if muted by me
      if (peer.isMutedByMe) {
        const nameW = ctx.measureText(name).width;
        ctx.strokeStyle = "#cc3333";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(circleX + 10, ey - fontSize / 2 + 2);
        ctx.lineTo(circleX + 10 + nameW, ey - fontSize / 2 + 2);
        ctx.stroke();
      }

      // Volume bar (tiny horizontal bar showing proximity volume)
      const barX = px + panelW - padding - 24;
      const barY = ey - fontSize / 2;
      const barW = 20;
      const barH = 4;
      ctx.fillStyle = "#333333";
      ctx.fillRect(barX, barY, barW, barH);
      ctx.fillStyle = peer.isMutedByMe ? "#cc3333" : "#22cc66";
      ctx.fillRect(barX, barY, barW * peer.volume, barH);
    }
  }

  // Voice panel click handling (called from mouse/touch input)
  private handleVoicePanelClick(clientX: number, clientY: number): boolean {
    if (this.voicePeers.size === 0 || !this.voiceMuteClickHandler) return false;

    const fontSize = this.isMobile ? 9 : 12;
    const lineH = this.isMobile ? 16 : 22;
    const padding = this.isMobile ? 6 : 10;
    const panelW = this.isMobile ? 110 : 150;
    const headerH = lineH + 2;

    const leaderboardEntries = this.leaderboardCache.length;
    const leaderboardH = leaderboardEntries > 0
      ? headerH + leaderboardEntries * (this.isMobile ? 16 : 24) + padding
      : 0;
    const px = 12;
    const py = (this.isMobile ? 80 : 100) + leaderboardH + 8;

    // Check if click is within panel bounds
    const entries = Array.from(this.voicePeers.values());
    const panelH = headerH + entries.length * lineH + padding;

    if (clientX < px || clientX > px + panelW || clientY < py || clientY > py + panelH) return false;

    // Determine which entry was clicked
    const entryIndex = Math.floor((clientY - py - headerH) / lineH);
    if (entryIndex >= 0 && entryIndex < entries.length) {
      const peer = entries[entryIndex];
      this.voiceMuteClickHandler(peer.sessionId);
      return true;
    }

    return false;
  }

  // ─── Kill Announcement (big center text) ───────────

  private drawKillAnnouncement(ctx: CanvasRenderingContext2D, W: number, H: number) {
    if (this.killAnnouncementTimer <= 0) return;

    const alpha = Math.min(1, this.killAnnouncementTimer / 0.5); // fade out in last 0.5s
    const scale = 1 + (1 - Math.min(1, this.killAnnouncementTimer / 1.8)) * 0.15; // slight grow
    const fontSize = this.isMobile ? 28 : 42;

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = `bold ${Math.round(fontSize * scale)}px Arial, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    // Shadow
    ctx.fillStyle = "#000000";
    ctx.fillText(this.killAnnouncementText, W / 2 + 2, H * 0.35 + 2);

    // Main text (red)
    ctx.fillStyle = "#FF4444";
    ctx.fillText(this.killAnnouncementText, W / 2, H * 0.35);

    ctx.textBaseline = "alphabetic";
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
