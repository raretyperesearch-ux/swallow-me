import { angleDiff } from "./steering";

export interface JoystickOutput {
  angle: number;
  magnitude: number;
  boosting: boolean;
  hasInput: boolean;
}

export interface JoystickConfig {
  deadZone: number;       // normalized 0–1 (0.18 default)
  smoothK: number;        // exponential smoothing rate (18 default)
  decayMs: number;        // release decay time in ms (100 default)
  outerRadius: number;
  knobRadius: number;
  hitbox: number;
}

const DEFAULT_CONFIG: JoystickConfig = {
  deadZone: 0.18,
  smoothK: 18,
  decayMs: 100,
  outerRadius: 70,
  knobRadius: 28,
  hitbox: 150,
};

export class Joystick {
  private cfg: JoystickConfig;

  // Touch state
  private active = false;
  private centerX = 0;
  private centerY = 0;
  private knobX = 0;
  private knobY = 0;
  private touchId: number | null = null;

  // Boost button
  private boostTouchId: number | null = null;
  boosting = false;

  // Smoothed output
  private rawAngle = 0;
  private smoothAngle = 0;
  private rawMagnitude = 0;
  private smoothMagnitude = 0;
  private hasInput = false;

  // Release decay
  private releaseTime = 0;
  private releaseAngle = 0;

  // Last touch position for noise filter
  private lastTouchX = 0;
  private lastTouchY = 0;

  constructor(cfg?: Partial<JoystickConfig>) {
    this.cfg = { ...DEFAULT_CONFIG, ...cfg };
  }

  // ─── Layout ────────────────────────────────────────

  getCenter(cssW: number, cssH: number): { x: number; y: number; outerR: number; knobR: number } {
    const isLandscape = cssW > cssH;
    if (isLandscape) {
      return { x: 90, y: cssH * 0.45, outerR: 55, knobR: 22 };
    }
    return { x: 90, y: cssH - 90, outerR: this.cfg.outerRadius, knobR: this.cfg.knobRadius };
  }

  getBoostCenter(cssW: number, cssH: number): { x: number; y: number; radius: number } {
    const isLandscape = cssW > cssH;
    if (isLandscape) {
      return { x: cssW - 60, y: cssH * 0.45, radius: 32 };
    }
    return { x: cssW - 60, y: cssH - 90, radius: 40 };
  }

  // ─── Touch Handlers ────────────────────────────────

  onTouchStart(touches: TouchList, cssW: number, cssH: number, voicePanelHandler?: (x: number, y: number) => boolean): void {
    for (let i = 0; i < touches.length; i++) {
      const touch = touches[i];
      const tx = touch.clientX;
      const ty = touch.clientY;

      // Voice panel tap
      if (voicePanelHandler && voicePanelHandler(tx, ty)) continue;

      const halfW = cssW * 0.5;

      // Right half = boost zone
      if (tx >= halfW && this.boostTouchId === null) {
        this.boostTouchId = touch.identifier;
        this.boosting = true;
        continue;
      }

      // Left half = joystick zone
      if (tx < halfW && this.touchId === null) {
        const jc = this.getCenter(cssW, cssH);
        const jdx = tx - jc.x;
        const jdy = ty - jc.y;
        const jDist = Math.sqrt(jdx * jdx + jdy * jdy);
        if (jDist < this.cfg.hitbox) {
          this.touchId = touch.identifier;
          this.active = true;
          this.centerX = jc.x;
          this.centerY = jc.y;
          this.lastTouchX = tx;
          this.lastTouchY = ty;
          this.processMove(tx, ty, jc.outerR);
        }
      }
    }
  }

  onTouchMove(touches: TouchList, cssW: number, cssH: number): void {
    for (let i = 0; i < touches.length; i++) {
      const touch = touches[i];
      if (touch.identifier === this.touchId) {
        // Noise filter: ignore sub-pixel movements
        const moveDx = touch.clientX - this.lastTouchX;
        const moveDy = touch.clientY - this.lastTouchY;
        if (moveDx * moveDx + moveDy * moveDy < 1) continue;
        this.lastTouchX = touch.clientX;
        this.lastTouchY = touch.clientY;

        const jc = this.getCenter(cssW, cssH);
        this.processMove(touch.clientX, touch.clientY, jc.outerR);
      }
    }
  }

  onTouchEnd(touches: TouchList, cssW: number, cssH: number): void {
    for (let i = 0; i < touches.length; i++) {
      const tid = touches[i].identifier;
      if (tid === this.touchId) {
        this.active = false;
        this.touchId = null;
        this.releaseTime = Date.now();
        this.releaseAngle = this.smoothAngle;
        // Snap knob back
        const jc = this.getCenter(cssW, cssH);
        this.knobX = jc.x;
        this.knobY = jc.y;
        this.rawMagnitude = 0;
      }
      if (tid === this.boostTouchId) {
        this.boostTouchId = null;
        this.boosting = false;
      }
    }
  }

  onTouchCancel(cssW: number, cssH: number): void {
    this.active = false;
    this.touchId = null;
    const jc = this.getCenter(cssW, cssH);
    this.knobX = jc.x;
    this.knobY = jc.y;
    this.rawMagnitude = 0;
    this.boostTouchId = null;
    this.boosting = false;
  }

  // ─── Core Processing ──────────────────────────────

  private processMove(touchX: number, touchY: number, outerR: number): void {
    const dx = touchX - this.centerX;
    const dy = touchY - this.centerY;
    const dist = Math.sqrt(dx * dx + dy * dy);

    // Compute normalized magnitude
    const deadZonePx = this.cfg.deadZone * outerR;

    if (dist < deadZonePx) {
      // Inside dead zone — don't update angle
      this.knobX = this.centerX;
      this.knobY = this.centerY;
      this.rawMagnitude = 0;
      return;
    }

    // Normalize direction outside dead zone
    this.rawAngle = Math.atan2(dy, dx);
    this.hasInput = true;

    // Intensity scales from dead-zone edge to 1
    this.rawMagnitude = Math.min(1, (dist - deadZonePx) / (outerR - deadZonePx));

    // Clamp knob to outer radius
    if (dist > outerR) {
      this.knobX = this.centerX + (dx / dist) * outerR;
      this.knobY = this.centerY + (dy / dist) * outerR;
    } else {
      this.knobX = touchX;
      this.knobY = touchY;
    }
  }

  // ─── Output (call once per frame) ──────────────────

  update(dt: number): void {
    if (this.active && this.hasInput) {
      // Exponential smoothing: a = 1 - exp(-k * dt)
      const a = 1 - Math.exp(-this.cfg.smoothK * dt);

      // Smooth angle using angular interpolation
      const delta = angleDiff(this.rawAngle, this.smoothAngle);
      this.smoothAngle += delta * a;

      // Smooth magnitude
      this.smoothMagnitude += (this.rawMagnitude - this.smoothMagnitude) * a;
    } else {
      // Decay magnitude toward zero on release
      const elapsed = Date.now() - this.releaseTime;
      const decayT = Math.min(1, elapsed / this.cfg.decayMs);
      this.smoothMagnitude *= (1 - decayT);
      if (this.smoothMagnitude < 0.01) this.smoothMagnitude = 0;
      // Keep angle frozen at release angle
      this.smoothAngle = this.releaseAngle;
    }
  }

  getOutput(): JoystickOutput {
    return {
      angle: this.smoothAngle,
      magnitude: this.smoothMagnitude,
      boosting: this.boosting,
      hasInput: this.active && this.hasInput,
    };
  }

  // ─── Drawing ───────────────────────────────────────

  draw(ctx: CanvasRenderingContext2D, cssW: number, cssH: number): void {
    const jc = this.getCenter(cssW, cssH);

    // Outer ring
    ctx.beginPath();
    ctx.arc(jc.x, jc.y, jc.outerR, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255, 255, 255, 0.15)";
    ctx.fill();
    ctx.strokeStyle = "rgba(255, 255, 255, 0.35)";
    ctx.lineWidth = 3;
    ctx.stroke();

    // Inner knob
    const knobX = this.active ? this.knobX : jc.x;
    const knobY = this.active ? this.knobY : jc.y;
    ctx.beginPath();
    ctx.arc(knobX, knobY, jc.knobR, 0, Math.PI * 2);
    ctx.fillStyle = this.active ? "rgba(255, 255, 255, 0.5)" : "rgba(255, 255, 255, 0.4)";
    ctx.fill();
    ctx.strokeStyle = "rgba(255, 255, 255, 0.6)";
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  isActive(): boolean {
    return this.active;
  }
}
