import { angleDiff } from "./steering";

export interface JoystickOutput {
  angle: number;
  magnitude: number;
  boosting: boolean;
  hasInput: boolean;
}

export interface JoystickConfig {
  activationDeadZone: number; // normalized 0–1, used when idle (0.18)
  directionalDeadZone: number; // normalized 0–1, used after activation (0.05)
  smoothK: number;            // exponential smoothing rate for intensity (18)
  decayMs: number;            // release decay time in ms (100)
  outerRadius: number;
  knobRadius: number;
  hitbox: number;
}

const DEFAULT_CONFIG: JoystickConfig = {
  activationDeadZone: 0.18,
  directionalDeadZone: 0.05,
  smoothK: 24,
  decayMs: 60,
  outerRadius: 70,
  knobRadius: 28,
  hitbox: 150,
};

export class Joystick {
  private cfg: JoystickConfig;

  // Touch state
  private active = false;
  private activated = false; // true once finger crosses activation dead zone
  private centerX = 0;
  private centerY = 0;
  private knobX = 0;
  private knobY = 0;
  private touchId: number | null = null;

  // Boost button
  private boostTouchId: number | null = null;
  boosting = false;

  // Raw direction (unsmoothed — angle comes from raw touch vector)
  private rawX = 0;
  private rawY = 0;
  private rawAngle = 0;
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

      if (voicePanelHandler && voicePanelHandler(tx, ty)) continue;

      const halfW = cssW * 0.5;

      if (tx >= halfW && this.boostTouchId === null) {
        this.boostTouchId = touch.identifier;
        this.boosting = true;
        continue;
      }

      if (tx < halfW && this.touchId === null) {
        const jc = this.getCenter(cssW, cssH);
        const jdx = tx - jc.x;
        const jdy = ty - jc.y;
        const jDist = Math.sqrt(jdx * jdx + jdy * jdy);
        if (jDist < this.cfg.hitbox) {
          this.touchId = touch.identifier;
          this.active = true;
          this.activated = false; // reset until crossing activation dead zone
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
        this.activated = false;
        this.touchId = null;
        this.releaseTime = Date.now();
        this.releaseAngle = this.rawAngle;
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
    this.activated = false;
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
    const normalized = dist / outerR;

    // Use activation dead zone if not yet activated, directional dead zone if activated
    const deadZone = this.activated ? this.cfg.directionalDeadZone : this.cfg.activationDeadZone;

    if (normalized < deadZone) {
      this.knobX = this.centerX;
      this.knobY = this.centerY;
      this.rawMagnitude = 0;
      return;
    }

    // Once we cross activation dead zone, switch to directional dead zone
    this.activated = true;

    // RAW angle from touch vector — no smoothing on angle
    this.rawX = dx / dist;
    this.rawY = dy / dist;
    this.rawAngle = Math.atan2(dy, dx);
    this.hasInput = true;

    // Intensity scales from dead-zone edge to 1
    this.rawMagnitude = Math.min(1, (normalized - deadZone) / (1 - deadZone));

    // Clamp knob visual
    if (dist > outerR) {
      this.knobX = this.centerX + (dx / dist) * outerR;
      this.knobY = this.centerY + (dy / dist) * outerR;
    } else {
      this.knobX = touchX;
      this.knobY = touchY;
    }
  }

  // ─── Output (call once per sim tick) ───────────────

  update(dt: number): void {
    if (this.active && this.hasInput) {
      // Smooth INTENSITY only (not angle — angle is raw)
      const a = 1 - Math.exp(-this.cfg.smoothK * dt);
      this.smoothMagnitude += (this.rawMagnitude - this.smoothMagnitude) * a;
    } else {
      // Decay magnitude toward zero on release
      const elapsed = Date.now() - this.releaseTime;
      const decayT = Math.min(1, elapsed / this.cfg.decayMs);
      this.smoothMagnitude *= (1 - decayT);
      if (this.smoothMagnitude < 0.01) this.smoothMagnitude = 0;
    }
  }

  getOutput(): JoystickOutput {
    return {
      angle: this.rawAngle, // RAW angle — no smoothing on direction
      magnitude: this.smoothMagnitude,
      boosting: this.boosting,
      hasInput: this.active && this.hasInput,
    };
  }

  // ─── Drawing ───────────────────────────────────────

  draw(ctx: CanvasRenderingContext2D, cssW: number, cssH: number): void {
    const jc = this.getCenter(cssW, cssH);

    ctx.beginPath();
    ctx.arc(jc.x, jc.y, jc.outerR, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255, 255, 255, 0.15)";
    ctx.fill();
    ctx.strokeStyle = "rgba(255, 255, 255, 0.35)";
    ctx.lineWidth = 3;
    ctx.stroke();

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
