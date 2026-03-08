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

const SEGMENT_SPACING = 4;

const FOOD_COLORS = [
  "#FF0000", "#FFFF00", "#00FF00", "#FF00FF",
  "#FFFFFF", "#00FFFF", "#7FFF00", "#FFCC00",
];

const NUM_BODY_SKINS = 13;

const SKIN_COLORS = [
  "#FF4444", "#44FF44", "#4444FF", "#FFFF44",
  "#FF44FF", "#44FFFF", "#FF8844", "#88FF44",
  "#4488FF", "#FF4488", "#44FF88", "#8844FF",
  "#FFAA44",
];

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
  private cssW: number = 0; // CSS pixel dimensions (for drawing coords)
  private cssH: number = 0;

  // Camera
  private camX: number = 0;
  private camY: number = 0;

  // Local state
  private localSnakes: Map<string, LocalSnake> = new Map();
  private arenaRadius: number = 3000;
  private bgPattern: CanvasPattern | null = null;

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
  private inputAngle: number = 0;

  // Mobile joystick
  private isTouchDevice: boolean = false;
  private joystickActive: boolean = false;
  private joystickCenterX: number = 0;
  private joystickCenterY: number = 0;
  private joystickKnobX: number = 0;
  private joystickKnobY: number = 0;
  private joystickTouchId: number | null = null;
  private joystickCanvas: HTMLCanvasElement | null = null;
  private joystickCtx: CanvasRenderingContext2D | null = null;

  private readonly JOYSTICK_OUTER_R = 60;
  private readonly JOYSTICK_INNER_R = 25;
  private readonly JOYSTICK_MARGIN = 40;
  private readonly BOOST_THRESHOLD = 0.7;

  // Callbacks
  public onDeath?: (data: any) => void;
  public onCashout?: (data: any) => void;
  public onStatsUpdate?: (stats: { kills: number; value: number; alive: number }) => void;

  constructor(container: HTMLDivElement, room: Colyseus.Room) {
    this.room = room;
    this.mySessionId = room.sessionId;

    this.canvas = document.createElement("canvas");
    this.canvas.style.display = "block";
    this.canvas.style.width = "100%";
    this.canvas.style.height = "100%";
    this.canvas.style.touchAction = "none";
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext("2d")!;

    this.isTouchDevice =
      navigator.maxTouchPoints > 0 ||
      "ontouchstart" in window;

    this.resizeCanvas();
    this.loadAssets();
    this.setupListeners();
    this.setupInput();

    if (this.isTouchDevice) {
      this.setupJoystick(container);
    }

    this.loop();
  }

  // ─── DPI-aware canvas sizing ────────────────────────

  private resizeCanvas() {
    this.dpr = window.devicePixelRatio || 1;
    this.cssW = this.canvas.clientWidth || window.innerWidth;
    this.cssH = this.canvas.clientHeight || window.innerHeight;
    this.canvas.width = this.cssW * this.dpr;
    this.canvas.height = this.cssH * this.dpr;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.ctx.imageSmoothingEnabled = true;
    this.ctx.imageSmoothingQuality = "high";
    // Rebuild bg pattern at new resolution
    if (this.bgImage && this.bgImage.complete) {
      this.bgPattern = this.ctx.createPattern(this.bgImage, "repeat");
    }
  }

  // ─── Assets ───────────────────────────────────────

  private loadAssets() {
    let loaded = 0;
    const total = 2 + NUM_BODY_SKINS;
    const onLoad = () => {
      loaded++;
      if (loaded >= total) {
        this.assetsLoaded = true;
        if (this.bgImage) {
          this.bgPattern = this.ctx.createPattern(this.bgImage, "repeat");
        }
      }
    };

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

  // ─── Colyseus Sync ────────────────────────────────

  private setupListeners() {
    this.room.state.snakes.onAdd((snake: any, key: string) => {
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
      this.resizeCanvas();
      if (this.joystickCanvas) {
        this.resizeJoystickCanvas();
        this.updateJoystickCenter();
      }
    });

    // Desktop mouse
    this.canvas.addEventListener("mousemove", (e) => {
      if (this.isTouchDevice) return;
      this.mouseX = e.clientX;
      this.mouseY = e.clientY;
      this.sendInput();
    });
    this.canvas.addEventListener("mousedown", (e) => {
      if (this.isTouchDevice) return;
      this.mouseDown = true;
      this.sendInput();
    });
    this.canvas.addEventListener("mouseup", () => {
      if (this.isTouchDevice) return;
      this.mouseDown = false;
      this.sendInput();
    });

    // Non-joystick touch fallback (for devices detected as non-touch but having touch)
    if (!this.isTouchDevice) {
      this.canvas.addEventListener("touchmove", (e) => {
        e.preventDefault();
        this.mouseX = e.touches[0].clientX;
        this.mouseY = e.touches[0].clientY;
        this.sendInput();
      }, { passive: false });
      this.canvas.addEventListener("touchstart", (e) => {
        e.preventDefault();
        this.mouseDown = true;
        this.mouseX = e.touches[0].clientX;
        this.mouseY = e.touches[0].clientY;
        this.sendInput();
      }, { passive: false });
      this.canvas.addEventListener("touchend", (e) => {
        e.preventDefault();
        this.mouseDown = false;
        this.sendInput();
      }, { passive: false });
    }
  }

  // ─── Mobile Joystick ──────────────────────────────

  private setupJoystick(container: HTMLDivElement) {
    this.joystickCanvas = document.createElement("canvas");
    this.joystickCanvas.style.position = "absolute";
    this.joystickCanvas.style.top = "0";
    this.joystickCanvas.style.left = "0";
    this.joystickCanvas.style.width = "100%";
    this.joystickCanvas.style.height = "100%";
    this.joystickCanvas.style.pointerEvents = "auto";
    this.joystickCanvas.style.zIndex = "10";
    this.joystickCanvas.style.touchAction = "none";
    container.appendChild(this.joystickCanvas);
    this.joystickCtx = this.joystickCanvas.getContext("2d")!;
    this.resizeJoystickCanvas();
    this.updateJoystickCenter();

    this.joystickCanvas.addEventListener("touchstart", (e) => {
      e.preventDefault();
      for (let i = 0; i < e.changedTouches.length; i++) {
        const touch = e.changedTouches[i];
        const dx = touch.clientX - this.joystickCenterX;
        const dy = touch.clientY - this.joystickCenterY;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist < this.JOYSTICK_OUTER_R * 2.5) {
          this.joystickTouchId = touch.identifier;
          this.joystickActive = true;
          this.updateJoystickKnob(touch.clientX, touch.clientY);
          return;
        }
      }
      // Non-joystick touch = direction from screen center
      const touch = e.changedTouches[0];
      this.mouseX = touch.clientX;
      this.mouseY = touch.clientY;
      this.sendDesktopStyleInput();
    }, { passive: false });

    this.joystickCanvas.addEventListener("touchmove", (e) => {
      e.preventDefault();
      for (let i = 0; i < e.changedTouches.length; i++) {
        const touch = e.changedTouches[i];
        if (touch.identifier === this.joystickTouchId) {
          this.updateJoystickKnob(touch.clientX, touch.clientY);
          return;
        }
      }
    }, { passive: false });

    this.joystickCanvas.addEventListener("touchend", (e) => {
      e.preventDefault();
      for (let i = 0; i < e.changedTouches.length; i++) {
        const touch = e.changedTouches[i];
        if (touch.identifier === this.joystickTouchId) {
          this.joystickActive = false;
          this.joystickTouchId = null;
          this.joystickKnobX = this.joystickCenterX;
          this.joystickKnobY = this.joystickCenterY;
          this.mouseDown = false;
          this.sendInput();
          return;
        }
      }
    }, { passive: false });

    this.joystickCanvas.addEventListener("touchcancel", (e) => {
      e.preventDefault();
      this.joystickActive = false;
      this.joystickTouchId = null;
      this.joystickKnobX = this.joystickCenterX;
      this.joystickKnobY = this.joystickCenterY;
      this.mouseDown = false;
    }, { passive: false });
  }

  private resizeJoystickCanvas() {
    if (!this.joystickCanvas || !this.joystickCtx) return;
    const dpr = window.devicePixelRatio || 1;
    const w = this.joystickCanvas.clientWidth || window.innerWidth;
    const h = this.joystickCanvas.clientHeight || window.innerHeight;
    this.joystickCanvas.width = w * dpr;
    this.joystickCanvas.height = h * dpr;
    this.joystickCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  private updateJoystickCenter() {
    this.joystickCenterX = this.JOYSTICK_MARGIN + this.JOYSTICK_OUTER_R;
    this.joystickCenterY = (this.joystickCanvas?.clientHeight || window.innerHeight) - this.JOYSTICK_MARGIN - this.JOYSTICK_OUTER_R;
    this.joystickKnobX = this.joystickCenterX;
    this.joystickKnobY = this.joystickCenterY;
  }

  private updateJoystickKnob(touchX: number, touchY: number) {
    const dx = touchX - this.joystickCenterX;
    const dy = touchY - this.joystickCenterY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const maxDist = this.JOYSTICK_OUTER_R;

    if (dist > maxDist) {
      this.joystickKnobX = this.joystickCenterX + (dx / dist) * maxDist;
      this.joystickKnobY = this.joystickCenterY + (dy / dist) * maxDist;
    } else {
      this.joystickKnobX = touchX;
      this.joystickKnobY = touchY;
    }

    const normalizedDist = Math.min(dist, maxDist) / maxDist;
    if (normalizedDist > 0.1) {
      this.inputAngle = Math.atan2(dy, dx);
      this.mouseDown = normalizedDist > this.BOOST_THRESHOLD;
      this.sendJoystickInput();
    }
  }

  private sendJoystickInput() {
    const now = Date.now();
    if (now < this.inputThrottle) return;
    this.inputThrottle = now + 33; // ~30 events/sec
    this.room.send("input", { angle: this.inputAngle, boost: this.mouseDown });
  }

  private sendDesktopStyleInput() {
    const now = Date.now();
    if (now < this.inputThrottle) return;
    this.inputThrottle = now + 33;
    const cx = this.cssW / 2;
    const cy = this.cssH / 2;
    const angle = Math.atan2(this.mouseY - cy, this.mouseX - cx);
    this.room.send("input", { angle, boost: false });
  }

  private drawJoystick() {
    if (!this.joystickCtx || !this.joystickCanvas) return;
    const ctx = this.joystickCtx;
    const w = this.joystickCanvas.clientWidth || window.innerWidth;
    const h = this.joystickCanvas.clientHeight || window.innerHeight;
    ctx.clearRect(0, 0, w, h);

    // Outer ring
    ctx.beginPath();
    ctx.arc(this.joystickCenterX, this.joystickCenterY, this.JOYSTICK_OUTER_R, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255, 255, 255, 0.08)";
    ctx.fill();
    ctx.strokeStyle = "rgba(255, 255, 255, 0.25)";
    ctx.lineWidth = 2;
    ctx.stroke();

    // Inner knob
    const knobColor = this.joystickActive
      ? (this.mouseDown ? "rgba(100, 255, 100, 0.6)" : "rgba(255, 255, 255, 0.5)")
      : "rgba(255, 255, 255, 0.3)";
    ctx.beginPath();
    ctx.arc(this.joystickKnobX, this.joystickKnobY, this.JOYSTICK_INNER_R, 0, Math.PI * 2);
    ctx.fillStyle = knobColor;
    ctx.fill();
    ctx.strokeStyle = "rgba(255, 255, 255, 0.4)";
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  private sendInput() {
    const now = Date.now();
    if (now < this.inputThrottle) return;
    this.inputThrottle = now + 33;

    const cx = this.cssW / 2;
    const cy = this.cssH / 2;
    const angle = Math.atan2(this.mouseY - cy, this.mouseX - cx);
    this.room.send("input", { angle, boost: this.mouseDown });
  }

  // ─── Main Loop ────────────────────────────────────

  private loop = () => {
    if (this.destroyed) return;
    this.update();
    this.draw();
    if (this.isTouchDevice) this.drawJoystick();
    this.animFrame = requestAnimationFrame(this.loop);
  };

  private update() {
    // Compute input angle (use CSS pixel dimensions, not canvas pixel dimensions)
    if (!this.isTouchDevice || !this.joystickActive) {
      const cx = this.cssW / 2;
      const cy = this.cssH / 2;
      this.inputAngle = Math.atan2(this.mouseY - cy, this.mouseX - cx);
    }

    for (const [id, snake] of this.localSnakes) {
      if (!snake.alive) continue;
      const isMe = id === this.mySessionId;

      if (isMe) {
        const speed = snake.serverSpeed || 4.5;
        snake.headX += Math.cos(this.inputAngle) * speed;
        snake.headY += Math.sin(this.inputAngle) * speed;
        snake.headX += (snake.serverHeadX - snake.headX) * 0.15;
        snake.headY += (snake.serverHeadY - snake.headY) * 0.15;
      } else {
        snake.headX += (snake.serverHeadX - snake.headX) * 0.25;
        snake.headY += (snake.serverHeadY - snake.headY) * 0.25;
      }

      // Smooth angle lerp at 0.15
      const targetAngle = isMe ? this.inputAngle : snake.serverAngle;
      let angleDiff = targetAngle - snake.angle;
      while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
      while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;
      snake.angle += angleDiff * 0.15;

      if (snake.segments.length > 0) {
        snake.segments[0].x = snake.headX;
        snake.segments[0].y = snake.headY;
      }

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

      const targetLen = snake.serverLength;
      while (snake.segments.length < targetLen) {
        const last = snake.segments[snake.segments.length - 1];
        snake.segments.push({ x: last.x, y: last.y });
      }
      while (snake.segments.length > targetLen && snake.segments.length > 2) {
        snake.segments.pop();
      }
    }

    // Smooth camera — lerp at 0.08 for premium feel
    const me = this.localSnakes.get(this.mySessionId);
    if (me && me.alive) {
      this.camX += (me.headX - this.camX) * 0.08;
      this.camY += (me.headY - this.camY) * 0.08;

      this.onStatsUpdate?.({
        kills: me.kills,
        value: me.valueUsdc / 1_000_000,
        alive: this.room.state.aliveCount || 0,
      });
    }
  }

  // ─── Drawing (all coords in CSS pixels) ───────────

  private draw() {
    const W = this.cssW;
    const H = this.cssH;
    const ctx = this.ctx;

    ctx.clearRect(0, 0, W, H);

    // Background — tiled with pattern + parallax
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

    // Snakes — draw ours last (on top)
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

    this.drawMinimap(ctx, W, H);
  }

  // ─── Coordinate helpers (CSS pixels) ───────────────

  private toScreenX(wx: number): number { return wx - this.camX + this.cssW / 2; }
  private toScreenY(wy: number): number { return wy - this.camY + this.cssH / 2; }

  private getSnakeSize(snake: LocalSnake): number {
    const baseSize = 28;
    const scale = Math.pow(snake.serverLength / 50, 0.2);
    return baseSize * Math.min(2.0, scale);
  }

  // ─── Snake Drawing (3D worm look) ─────────────────

  private drawSnake(ctx: CanvasRenderingContext2D, snake: LocalSnake, W: number, H: number, isMe: boolean) {
    if (snake.segments.length < 2) return;

    const size = this.getSnakeSize(snake);
    const bodyImg = this.bodyImages[snake.skinId % this.bodyImages.length];
    const skinColor = SKIN_COLORS[snake.skinId % SKIN_COLORS.length];
    const r = size / 2;

    // Subtle shadow under entire snake
    ctx.save();
    ctx.shadowColor = "rgba(0, 0, 0, 0.35)";
    ctx.shadowBlur = 8;
    ctx.shadowOffsetX = 2;
    ctx.shadowOffsetY = 2;

    // Body segments back-to-front
    for (let i = snake.segments.length - 1; i >= 1; i--) {
      const seg = snake.segments[i];
      const sx = this.toScreenX(seg.x);
      const sy = this.toScreenY(seg.y);

      if (sx < -size || sx > W + size || sy < -size || sy > H + size) continue;

      if (bodyImg && bodyImg.complete) {
        ctx.drawImage(bodyImg, sx - r, sy - r, size, size);
      } else {
        // Fallback: 3D gradient circle
        const grad = ctx.createRadialGradient(sx - r * 0.3, sy - r * 0.3, 0, sx, sy, r);
        grad.addColorStop(0, "#ffffff66");
        grad.addColorStop(0.4, skinColor);
        grad.addColorStop(1, "#00000044");
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(sx, sy, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    ctx.restore(); // clear shadow

    // Outline on body segments for definition
    ctx.strokeStyle = "rgba(0, 0, 0, 0.2)";
    ctx.lineWidth = 1;
    for (let i = snake.segments.length - 1; i >= 1; i--) {
      const seg = snake.segments[i];
      const sx = this.toScreenX(seg.x);
      const sy = this.toScreenY(seg.y);
      if (sx < -size || sx > W + size || sy < -size || sy > H + size) continue;
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Head
    const headSx = this.toScreenX(snake.headX);
    const headSy = this.toScreenY(snake.headY);
    const headSize = size * 1.3;

    if (this.headImage && this.headImage.complete) {
      ctx.save();
      ctx.shadowColor = "rgba(0, 0, 0, 0.4)";
      ctx.shadowBlur = 6;
      ctx.translate(headSx, headSy);
      ctx.rotate(snake.angle - Math.PI / 2);
      ctx.drawImage(this.headImage, -headSize / 2, -headSize / 2, headSize, headSize);
      ctx.restore();
    } else {
      // Procedural head fallback
      ctx.save();
      ctx.translate(headSx, headSy);
      ctx.rotate(snake.angle - Math.PI / 2);
      const hR = headSize / 2;
      const grad = ctx.createRadialGradient(-hR * 0.2, -hR * 0.2, 0, 0, 0, hR);
      grad.addColorStop(0, "#ffffff88");
      grad.addColorStop(0.5, skinColor);
      grad.addColorStop(1, "#00000055");
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.ellipse(0, 0, hR, hR * 1.15, 0, 0, Math.PI * 2);
      ctx.fill();
      // Eyes
      ctx.fillStyle = "#fff";
      ctx.beginPath();
      ctx.arc(-hR * 0.35, -hR * 0.5, hR * 0.22, 0, Math.PI * 2);
      ctx.arc(hR * 0.35, -hR * 0.5, hR * 0.22, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#000";
      ctx.beginPath();
      ctx.arc(-hR * 0.35, -hR * 0.5, hR * 0.1, 0, Math.PI * 2);
      ctx.arc(hR * 0.35, -hR * 0.5, hR * 0.1, 0, Math.PI * 2);
      ctx.fill();
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

  // ─── Food (glow + solid core) ─────────────────────

  private drawFood(ctx: CanvasRenderingContext2D, W: number, H: number) {
    const time = Date.now();

    this.room.state.food.forEach((food: any) => {
      const sx = this.toScreenX(food.x);
      const sy = this.toScreenY(food.y);

      if (sx < -30 || sx > W + 30 || sy < -30 || sy > H + 30) return;

      const isDeath = food.size === 2;
      const baseSize = isDeath ? 8 : 4;
      const pulse = 1 + Math.sin(time / 400 + food.x * 0.1 + food.y * 0.1) * 0.2;
      const r = baseSize * pulse;

      const colorIdx = Math.abs(Math.floor(food.x * 7 + food.y * 13)) % FOOD_COLORS.length;
      const color = FOOD_COLORS[colorIdx];

      // Glow halo
      ctx.globalAlpha = 0.3;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(sx, sy, r * 2.5, 0, Math.PI * 2);
      ctx.fill();

      // Solid core
      ctx.globalAlpha = 1.0;
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

  // ─── Minimap ──────────────────────────────────────

  private drawMinimap(ctx: CanvasRenderingContext2D, W: number, H: number) {
    const SIZE = 200;
    const PADDING = 15;
    const mx = W - SIZE - PADDING;
    const my = H - SIZE - PADDING;
    const scale = (SIZE - 20) / (this.arenaRadius * 2);

    ctx.save();
    const r = 12;
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
        dotSize = 4;
      } else if (snake.isBot) {
        color = "#888888";
        dotSize = 2.5;
      } else {
        color = SKIN_COLORS[snake.skinId % SKIN_COLORS.length];
        dotSize = 3;
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
    this.room.leave();
    this.canvas.remove();
    if (this.joystickCanvas) {
      this.joystickCanvas.remove();
    }
  }
}
