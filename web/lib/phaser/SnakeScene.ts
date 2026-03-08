import Phaser from "phaser";
import * as Colyseus from "colyseus.js";

interface SnakeSprite {
  graphics: Phaser.GameObjects.Graphics;
  nameText: Phaser.GameObjects.Text;
  segments: { x: number; y: number }[];
  // Interpolation targets
  targetSegments: { x: number; y: number }[];
  headX: number;
  headY: number;
  targetHeadX: number;
  targetHeadY: number;
  angle: number;
  targetAngle: number;
  length: number;
  alive: boolean;
  skinId: number;
  boosting: boolean;
  speed: number;
}

// Slither.io-style skin palettes — each skin has 2 alternating colors
const SKIN_PALETTES: [number, number][] = [
  [0x00ff88, 0x00cc66], // green
  [0xff4488, 0xcc2266], // pink
  [0x44aaff, 0x2288dd], // blue
  [0xffaa00, 0xdd8800], // orange
  [0xff00ff, 0xcc00cc], // magenta
  [0x00ffff, 0x00cccc], // cyan
  [0xff6600, 0xdd4400], // red-orange
  [0xaaff00, 0x88dd00], // lime
  [0xff0044, 0xcc0033], // red
  [0x8844ff, 0x6622dd], // purple
];

// Food colors — bright and varied like slither.io
const FOOD_COLORS = [
  0xff3333, 0xffee33, 0x33ff66, 0x3366ff,
  0xff33ff, 0xffffff, 0x33ffcc, 0xff8833,
];

export class SnakeScene extends Phaser.Scene {
  public room: Colyseus.Room | null = null;
  public mySessionId: string = "";
  private snakeSprites: Map<string, SnakeSprite> = new Map();
  private foodGraphics: Phaser.GameObjects.Graphics | null = null;
  private boundaryGraphics: Phaser.GameObjects.Graphics | null = null;
  private gridGraphics: Phaser.GameObjects.Graphics | null = null;
  private boostTrailGraphics: Phaser.GameObjects.Graphics | null = null;
  private inputThrottle: number = 0;
  private arenaRadius: number = 3000;
  private lastSyncTime: number = 0;
  private gridTexture: Phaser.GameObjects.TileSprite | null = null;

  // Callbacks to React layer
  public onDeath?: (data: any) => void;
  public onCashout?: (data: any) => void;
  public onKillFeedUpdate?: (feed: any[]) => void;
  public onStatsUpdate?: (stats: { kills: number; value: number; alive: number }) => void;

  constructor() {
    super({ key: "SnakeScene" });
  }

  // room and mySessionId are set directly on the instance before Phaser boots
  init() {}

  create() {
    if (!this.room) return;

    // Dark background
    this.cameras.main.setBackgroundColor(0x0a0a1a);

    // Draw hexagonal grid
    this.gridGraphics = this.add.graphics();
    this.drawHexGrid();

    // Draw arena boundary
    this.boundaryGraphics = this.add.graphics();
    this.drawBoundary();

    // Boost trail layer (behind snakes)
    this.boostTrailGraphics = this.add.graphics();

    // Food layer
    this.foodGraphics = this.add.graphics();

    // Camera setup
    this.cameras.main.setZoom(0.85);

    // ─── State Sync Listeners ─────────────────────────

    this.room.state.snakes.onAdd((snake: any, key: string) => {
      this.addSnake(key, snake);

      snake.onChange(() => {
        this.updateSnake(key, snake);
      });
    });

    this.room.state.snakes.onRemove((_: any, key: string) => {
      this.removeSnake(key);
    });

    this.room.state.listen("arenaRadius", (value: number) => {
      this.arenaRadius = value;
      this.drawBoundary();
    });

    // Listen for death message
    this.room.onMessage("death", (data: any) => {
      this.onDeath?.(data);
    });

    this.room.onMessage("cashout_success", (data: any) => {
      this.onCashout?.(data);
    });

    // ─── Input Handling ───────────────────────────────

    this.input.on("pointermove", (pointer: Phaser.Input.Pointer) => {
      if (!this.room || Date.now() < this.inputThrottle) return;
      this.inputThrottle = Date.now() + 33; // ~30 inputs/sec

      const worldPoint = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
      const mySnake = this.snakeSprites.get(this.mySessionId);
      if (!mySnake) return;

      const angle = Phaser.Math.Angle.Between(
        mySnake.headX,
        mySnake.headY,
        worldPoint.x,
        worldPoint.y
      );

      const boost = pointer.isDown || this.input.keyboard?.addKey("SPACE").isDown || false;
      this.room.send("input", { angle, boost });
    });

    // Boost on mouse down
    this.input.on("pointerdown", () => {
      if (!this.room) return;
      const mySnake = this.snakeSprites.get(this.mySessionId);
      if (!mySnake) return;
      const worldPoint = this.cameras.main.getWorldPoint(this.input.activePointer.x, this.input.activePointer.y);
      const angle = Phaser.Math.Angle.Between(mySnake.headX, mySnake.headY, worldPoint.x, worldPoint.y);
      this.room.send("input", { angle, boost: true });
    });

    this.input.on("pointerup", () => {
      if (!this.room) return;
      const mySnake = this.snakeSprites.get(this.mySessionId);
      if (!mySnake) return;
      const worldPoint = this.cameras.main.getWorldPoint(this.input.activePointer.x, this.input.activePointer.y);
      const angle = Phaser.Math.Angle.Between(mySnake.headX, mySnake.headY, worldPoint.x, worldPoint.y);
      this.room.send("input", { angle, boost: false });
    });
  }

  update(_time: number, delta: number) {
    const lerpFactor = Math.min(1, delta / 50); // Smooth at ~20fps sync rate

    // Interpolate and render all snakes
    for (const [id, sprite] of this.snakeSprites) {
      this.interpolateSnake(sprite, lerpFactor);
      this.renderSnake(id, sprite);
    }

    // Render food
    this.renderFood();

    // Smooth camera follow
    const mySnake = this.snakeSprites.get(this.mySessionId);
    if (mySnake && mySnake.alive) {
      const cam = this.cameras.main;

      // Smooth camera position
      const camX = cam.scrollX + cam.width / 2;
      const camY = cam.scrollY + cam.height / 2;
      const newCamX = Phaser.Math.Linear(camX, mySnake.headX, lerpFactor * 0.8);
      const newCamY = Phaser.Math.Linear(camY, mySnake.headY, lerpFactor * 0.8);
      cam.centerOn(newCamX, newCamY);

      // Zoom out slightly as snake grows
      const targetZoom = Math.max(0.45, 0.85 - (mySnake.length - 30) * 0.0008);
      cam.zoom = Phaser.Math.Linear(cam.zoom, targetZoom, 0.02);

      // Update stats callback
      const stateSnake = this.room?.state.snakes.get(this.mySessionId);
      if (stateSnake) {
        this.onStatsUpdate?.({
          kills: stateSnake.kills,
          value: stateSnake.valueUsdc / 1_000_000,
          alive: this.room?.state.aliveCount || 0,
        });
      }
    }
  }

  // ─── Interpolation ────────────────────────────────

  private interpolateSnake(sprite: SnakeSprite, factor: number) {
    // Lerp head position
    sprite.headX = Phaser.Math.Linear(sprite.headX, sprite.targetHeadX, factor);
    sprite.headY = Phaser.Math.Linear(sprite.headY, sprite.targetHeadY, factor);

    // Lerp angle (handle wraparound)
    sprite.angle = Phaser.Math.Angle.RotateTo(sprite.angle, sprite.targetAngle, 0.15);

    // Lerp segments toward targets
    if (sprite.targetSegments.length > 0) {
      // Ensure segments array matches target length
      while (sprite.segments.length < sprite.targetSegments.length) {
        const last = sprite.segments[sprite.segments.length - 1] || { x: sprite.headX, y: sprite.headY };
        sprite.segments.push({ x: last.x, y: last.y });
      }
      while (sprite.segments.length > sprite.targetSegments.length) {
        sprite.segments.pop();
      }

      // Interpolate each segment
      for (let i = 0; i < sprite.segments.length; i++) {
        const target = sprite.targetSegments[i];
        if (target) {
          sprite.segments[i].x = Phaser.Math.Linear(sprite.segments[i].x, target.x, factor);
          sprite.segments[i].y = Phaser.Math.Linear(sprite.segments[i].y, target.y, factor);
        }
      }
    }
  }

  // ─── Snake Management ──────────────────────────────

  private addSnake(id: string, data: any) {
    const graphics = this.add.graphics();
    const nameText = this.add.text(0, 0, data.name || id.slice(0, 8), {
      fontSize: "13px",
      fontFamily: "Arial, sans-serif",
      color: "#ffffff",
      stroke: "#000000",
      strokeThickness: 3,
    }).setOrigin(0.5, 1).setDepth(100);

    const segs: { x: number; y: number }[] = [];
    if (data.segments) {
      for (let i = 0; i < data.segments.length; i++) {
        segs.push({ x: data.segments[i].x, y: data.segments[i].y });
      }
    }

    this.snakeSprites.set(id, {
      graphics,
      nameText,
      segments: [...segs],
      targetSegments: [...segs],
      headX: data.headX,
      headY: data.headY,
      targetHeadX: data.headX,
      targetHeadY: data.headY,
      angle: data.angle,
      targetAngle: data.angle,
      length: data.length,
      alive: data.alive,
      skinId: data.skinId || 0,
      boosting: data.boosting || false,
      speed: data.speed || 0,
    });
  }

  private updateSnake(id: string, data: any) {
    const sprite = this.snakeSprites.get(id);
    if (!sprite) return;

    // Set interpolation targets (don't snap)
    sprite.targetHeadX = data.headX;
    sprite.targetHeadY = data.headY;
    sprite.targetAngle = data.angle;
    sprite.length = data.length;
    sprite.alive = data.alive;
    sprite.skinId = data.skinId;
    sprite.boosting = data.boosting;
    sprite.speed = data.speed;

    // Update target segments
    sprite.targetSegments = [];
    if (data.segments) {
      for (let i = 0; i < data.segments.length; i++) {
        const seg = data.segments[i];
        sprite.targetSegments.push({ x: seg.x, y: seg.y });
      }
    }

    this.lastSyncTime = Date.now();
  }

  private removeSnake(id: string) {
    const sprite = this.snakeSprites.get(id);
    if (sprite) {
      sprite.graphics.destroy();
      sprite.nameText.destroy();
      this.snakeSprites.delete(id);
    }
  }

  // ─── Snake Rendering (slither.io style) ───────────

  private renderSnake(id: string, sprite: SnakeSprite) {
    const g = sprite.graphics;
    g.clear();

    if (!sprite.alive || sprite.segments.length < 2) {
      sprite.nameText.setVisible(false);
      return;
    }

    sprite.nameText.setVisible(true);

    const palette = SKIN_PALETTES[sprite.skinId % SKIN_PALETTES.length];
    const isMe = id === this.mySessionId;
    const baseRadius = 12;
    // Scale radius slightly with length
    const sizeScale = Math.min(1.8, 1.0 + (sprite.length - 30) * 0.003);
    const bodyRadius = baseRadius * sizeScale;
    const headRadius = bodyRadius * 1.5;

    // Draw body segments back-to-front with alternating color bands
    for (let i = sprite.segments.length - 1; i >= 1; i--) {
      const seg = sprite.segments[i];

      // Taper toward tail
      const t = i / sprite.segments.length;
      const taper = 0.4 + t * 0.6; // 40% at tail, 100% at head
      const r = bodyRadius * taper;

      // Alternating stripe pattern (every 3 segments)
      const colorIndex = Math.floor(i / 3) % 2;
      const color = palette[colorIndex];

      // Dark outline for depth
      g.fillStyle(0x000000, 0.4);
      g.fillCircle(seg.x, seg.y, r + 1.5);

      // Body segment
      g.fillStyle(color, isMe ? 1.0 : 0.85);
      g.fillCircle(seg.x, seg.y, r);
    }

    // Boost glow effect
    if (sprite.boosting && isMe) {
      g.fillStyle(palette[0], 0.08);
      g.fillCircle(sprite.headX, sprite.headY, headRadius * 4);
      g.fillStyle(palette[0], 0.05);
      g.fillCircle(sprite.headX, sprite.headY, headRadius * 6);
    }

    // Head outline
    g.fillStyle(0x000000, 0.4);
    g.fillCircle(sprite.headX, sprite.headY, headRadius + 2);

    // Head (solid primary color)
    g.fillStyle(palette[0], 1.0);
    g.fillCircle(sprite.headX, sprite.headY, headRadius);

    // Slight highlight on top of head
    g.fillStyle(0xffffff, 0.12);
    g.fillCircle(
      sprite.headX - Math.cos(sprite.angle) * headRadius * 0.15,
      sprite.headY - Math.sin(sprite.angle) * headRadius * 0.15 - headRadius * 0.2,
      headRadius * 0.6
    );

    // ─── Eyes ───────────────────────────────────────
    const eyeSpread = 0.45;
    const eyeForward = headRadius * 0.35;
    const eyeRadius = headRadius * 0.38;
    const pupilRadius = eyeRadius * 0.55;

    for (const side of [-1, 1]) {
      const eyeAngle = sprite.angle + side * eyeSpread;
      const ex = sprite.headX + Math.cos(eyeAngle) * eyeForward + Math.cos(sprite.angle) * headRadius * 0.2;
      const ey = sprite.headY + Math.sin(eyeAngle) * eyeForward + Math.sin(sprite.angle) * headRadius * 0.2;

      // White of eye
      g.fillStyle(0xffffff, 1);
      g.fillCircle(ex, ey, eyeRadius);

      // Pupil — points in movement direction
      const pupilOffsetX = Math.cos(sprite.angle) * pupilRadius * 0.4;
      const pupilOffsetY = Math.sin(sprite.angle) * pupilRadius * 0.4;
      g.fillStyle(0x000000, 1);
      g.fillCircle(ex + pupilOffsetX, ey + pupilOffsetY, pupilRadius);
    }

    // Glow ring for own snake
    if (isMe) {
      g.lineStyle(1.5, palette[0], 0.2);
      g.strokeCircle(sprite.headX, sprite.headY, headRadius + 6);
    }

    // Update name position (above head)
    sprite.nameText.setPosition(sprite.headX, sprite.headY - headRadius - 12);
  }

  // ─── Food Rendering (slither.io glowing orbs) ─────

  private renderFood() {
    if (!this.foodGraphics || !this.room) return;
    this.foodGraphics.clear();

    const cam = this.cameras.main;
    const margin = 150;
    const viewBounds = {
      left: cam.scrollX - margin,
      right: cam.scrollX + cam.width / cam.zoom + margin,
      top: cam.scrollY - margin,
      bottom: cam.scrollY + cam.height / cam.zoom + margin,
    };

    const time = Date.now();

    this.room.state.food.forEach((food: any) => {
      if (
        food.x < viewBounds.left || food.x > viewBounds.right ||
        food.y < viewBounds.top || food.y > viewBounds.bottom
      ) return;

      const isDeath = food.size === 2;
      const baseSize = isDeath ? 6 : 3.5;

      // Gentle pulse
      const pulse = 1 + Math.sin(time / 400 + food.x * 0.1 + food.y * 0.1) * 0.2;
      const size = baseSize * pulse;

      // Pick a stable color based on position
      const colorIdx = Math.abs(Math.floor(food.x * 7 + food.y * 13)) % FOOD_COLORS.length;
      const color = FOOD_COLORS[colorIdx];

      // Outer glow halo
      this.foodGraphics!.fillStyle(color, 0.12);
      this.foodGraphics!.fillCircle(food.x, food.y, size * 3);

      // Inner glow
      this.foodGraphics!.fillStyle(color, 0.3);
      this.foodGraphics!.fillCircle(food.x, food.y, size * 1.8);

      // Core
      this.foodGraphics!.fillStyle(color, 0.9);
      this.foodGraphics!.fillCircle(food.x, food.y, size);

      // Bright center highlight
      this.foodGraphics!.fillStyle(0xffffff, 0.5);
      this.foodGraphics!.fillCircle(food.x - size * 0.2, food.y - size * 0.2, size * 0.35);
    });
  }

  // ─── Hexagonal Grid (slither.io signature) ────────

  private drawHexGrid() {
    if (!this.gridGraphics) return;
    this.gridGraphics.clear();

    const hexRadius = 40;
    const hexHeight = hexRadius * 2;
    const hexWidth = Math.sqrt(3) * hexRadius;
    const extent = this.arenaRadius + hexWidth;

    this.gridGraphics.lineStyle(0.8, 0x1a1a3a, 0.25);

    // Draw hex grid within arena bounds
    for (let row = -extent; row <= extent; row += hexHeight * 0.75) {
      const isOddRow = Math.round(row / (hexHeight * 0.75)) % 2 !== 0;
      const offsetX = isOddRow ? hexWidth / 2 : 0;

      for (let col = -extent; col <= extent; col += hexWidth) {
        const cx = col + offsetX;
        const cy = row;

        // Skip hexes outside arena
        if (cx * cx + cy * cy > (this.arenaRadius + hexWidth) * (this.arenaRadius + hexWidth)) continue;

        this.drawHexagon(this.gridGraphics, cx, cy, hexRadius);
      }
    }
  }

  private drawHexagon(g: Phaser.GameObjects.Graphics, cx: number, cy: number, radius: number) {
    const points: { x: number; y: number }[] = [];
    for (let i = 0; i < 6; i++) {
      const angle = (Math.PI / 3) * i + Math.PI / 6;
      points.push({
        x: cx + radius * Math.cos(angle),
        y: cy + radius * Math.sin(angle),
      });
    }

    g.beginPath();
    g.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < 6; i++) {
      g.lineTo(points[i].x, points[i].y);
    }
    g.closePath();
    g.strokePath();
  }

  // ─── Arena Boundary ───────────────────────────────

  private drawBoundary() {
    if (!this.boundaryGraphics) return;
    this.boundaryGraphics.clear();

    // Outer danger zone glow
    this.boundaryGraphics.lineStyle(8, 0xff0044, 0.15);
    this.boundaryGraphics.strokeCircle(0, 0, this.arenaRadius + 10);

    // Main boundary line
    this.boundaryGraphics.lineStyle(4, 0xff0044, 0.5);
    this.boundaryGraphics.strokeCircle(0, 0, this.arenaRadius);

    // Inner warning ring
    this.boundaryGraphics.lineStyle(2, 0xff0044, 0.15);
    this.boundaryGraphics.strokeCircle(0, 0, this.arenaRadius * 0.95);

    // Subtle inner ring
    this.boundaryGraphics.lineStyle(1, 0xff0044, 0.08);
    this.boundaryGraphics.strokeCircle(0, 0, this.arenaRadius * 0.90);
  }

  // ─── Cleanup ────────────────────────────────────────

  destroy() {
    this.snakeSprites.forEach((sprite) => {
      sprite.graphics.destroy();
      sprite.nameText.destroy();
    });
    this.snakeSprites.clear();
    this.room?.leave();
  }
}
