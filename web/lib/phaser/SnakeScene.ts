import Phaser from "phaser";
import * as Colyseus from "colyseus.js";

interface SnakeSprite {
  graphics: Phaser.GameObjects.Graphics;
  nameText: Phaser.GameObjects.Text;
  segments: { x: number; y: number }[];
  headX: number;
  headY: number;
  angle: number;
  length: number;
  alive: boolean;
  skinId: number;
}

// Skin colors
const SKIN_COLORS = [
  0x00ff88, 0xff4488, 0x44aaff, 0xffaa00, 0xff00ff,
  0x00ffff, 0xff6600, 0xaaff00, 0xff0044, 0x8844ff,
];

export class SnakeScene extends Phaser.Scene {
  private room: Colyseus.Room | null = null;
  private snakeSprites: Map<string, SnakeSprite> = new Map();
  private foodGraphics: Phaser.GameObjects.Graphics | null = null;
  private boundaryGraphics: Phaser.GameObjects.Graphics | null = null;
  private gridGraphics: Phaser.GameObjects.Graphics | null = null;
  private mySessionId: string = "";
  private inputThrottle: number = 0;
  private arenaRadius: number = 3000;

  // Callbacks to React layer
  public onDeath?: (data: any) => void;
  public onCashout?: (data: any) => void;
  public onKillFeedUpdate?: (feed: any[]) => void;
  public onStatsUpdate?: (stats: { kills: number; value: number; alive: number }) => void;

  constructor() {
    super({ key: "SnakeScene" });
  }

  init(data: { room: Colyseus.Room }) {
    this.room = data.room;
    this.mySessionId = data.room.sessionId;
  }

  create() {
    if (!this.room) return;

    // Dark background
    this.cameras.main.setBackgroundColor(0x0a0a1a);

    // Draw grid
    this.gridGraphics = this.add.graphics();
    this.drawGrid();

    // Draw arena boundary
    this.boundaryGraphics = this.add.graphics();
    this.drawBoundary();

    // Food layer
    this.foodGraphics = this.add.graphics();

    // Camera setup
    this.cameras.main.setZoom(0.8);

    // ─── State Sync Listeners ─────────────────────────

    this.room.state.snakes.onAdd((snake: any, key: string) => {
      this.addSnake(key, snake);

      // Listen for changes
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
      this.inputThrottle = Date.now() + 50; // 20 inputs/sec

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

    // Touch support
    this.input.on("pointerdown", () => {
      // Boost on hold
    });
  }

  update() {
    // Render all snakes
    for (const [id, sprite] of this.snakeSprites) {
      this.renderSnake(id, sprite);
    }

    // Render food
    this.renderFood();

    // Follow camera
    const mySnake = this.snakeSprites.get(this.mySessionId);
    if (mySnake && mySnake.alive) {
      this.cameras.main.centerOn(mySnake.headX, mySnake.headY);

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

  // ─── Snake Management ──────────────────────────────

  private addSnake(id: string, data: any) {
    const graphics = this.add.graphics();
    const nameText = this.add.text(0, 0, data.name || id.slice(0, 8), {
      fontSize: "14px",
      color: "#ffffff",
      stroke: "#000000",
      strokeThickness: 3,
    }).setOrigin(0.5, 1);

    this.snakeSprites.set(id, {
      graphics,
      nameText,
      segments: [],
      headX: data.headX,
      headY: data.headY,
      angle: data.angle,
      length: data.length,
      alive: data.alive,
      skinId: data.skinId || 0,
    });
  }

  private updateSnake(id: string, data: any) {
    const sprite = this.snakeSprites.get(id);
    if (!sprite) return;

    sprite.headX = data.headX;
    sprite.headY = data.headY;
    sprite.angle = data.angle;
    sprite.length = data.length;
    sprite.alive = data.alive;
    sprite.skinId = data.skinId;

    // Sync segments from state
    sprite.segments = [];
    if (data.segments) {
      for (let i = 0; i < data.segments.length; i++) {
        const seg = data.segments[i];
        sprite.segments.push({ x: seg.x, y: seg.y });
      }
    }
  }

  private removeSnake(id: string) {
    const sprite = this.snakeSprites.get(id);
    if (sprite) {
      sprite.graphics.destroy();
      sprite.nameText.destroy();
      this.snakeSprites.delete(id);
    }
  }

  private renderSnake(id: string, sprite: SnakeSprite) {
    const g = sprite.graphics;
    g.clear();

    if (!sprite.alive || sprite.segments.length < 2) return;

    const color = SKIN_COLORS[sprite.skinId % SKIN_COLORS.length];
    const isMe = id === this.mySessionId;
    const bodyAlpha = isMe ? 1.0 : 0.85;
    const radius = 8;

    // Draw body segments
    g.fillStyle(color, bodyAlpha);
    for (let i = sprite.segments.length - 1; i >= 1; i--) {
      const seg = sprite.segments[i];
      const t = i / sprite.segments.length;
      const r = radius * (0.5 + t * 0.5); // Tapers toward tail
      g.fillCircle(seg.x, seg.y, r);
    }

    // Draw head (slightly larger)
    g.fillStyle(color, 1.0);
    g.fillCircle(sprite.headX, sprite.headY, radius * 1.3);

    // Draw eyes
    const eyeOffset = radius * 0.6;
    const eyeAngle1 = sprite.angle + 0.5;
    const eyeAngle2 = sprite.angle - 0.5;
    g.fillStyle(0xffffff, 1);
    g.fillCircle(
      sprite.headX + Math.cos(eyeAngle1) * eyeOffset,
      sprite.headY + Math.sin(eyeAngle1) * eyeOffset,
      3
    );
    g.fillCircle(
      sprite.headX + Math.cos(eyeAngle2) * eyeOffset,
      sprite.headY + Math.sin(eyeAngle2) * eyeOffset,
      3
    );

    // Pupils
    g.fillStyle(0x000000, 1);
    g.fillCircle(
      sprite.headX + Math.cos(eyeAngle1) * (eyeOffset + 1),
      sprite.headY + Math.sin(eyeAngle1) * (eyeOffset + 1),
      1.5
    );
    g.fillCircle(
      sprite.headX + Math.cos(eyeAngle2) * (eyeOffset + 1),
      sprite.headY + Math.sin(eyeAngle2) * (eyeOffset + 1),
      1.5
    );

    // Glow effect for player's own snake
    if (isMe) {
      g.lineStyle(2, color, 0.3);
      g.strokeCircle(sprite.headX, sprite.headY, radius * 2);
    }

    // Update name position
    sprite.nameText.setPosition(sprite.headX, sprite.headY - 20);
  }

  // ─── Food Rendering ────────────────────────────────

  private renderFood() {
    if (!this.foodGraphics || !this.room) return;
    this.foodGraphics.clear();

    const cam = this.cameras.main;
    const viewBounds = {
      left: cam.scrollX - 100,
      right: cam.scrollX + cam.width / cam.zoom + 100,
      top: cam.scrollY - 100,
      bottom: cam.scrollY + cam.height / cam.zoom + 100,
    };

    this.room.state.food.forEach((food: any) => {
      // Only render food in view
      if (
        food.x < viewBounds.left || food.x > viewBounds.right ||
        food.y < viewBounds.top || food.y > viewBounds.bottom
      ) return;

      const size = food.size === 2 ? 6 : 3;
      const color = food.size === 2 ? 0xffaa00 : 0x44ff88;
      const alpha = 0.7 + Math.sin(Date.now() / 500 + food.x) * 0.3;

      this.foodGraphics!.fillStyle(color, alpha);
      this.foodGraphics!.fillCircle(food.x, food.y, size);
    });
  }

  // ─── Arena Drawing ──────────────────────────────────

  private drawGrid() {
    if (!this.gridGraphics) return;
    this.gridGraphics.clear();
    this.gridGraphics.lineStyle(1, 0x1a1a3a, 0.3);

    const spacing = 100;
    const size = this.arenaRadius * 2;
    for (let x = -size; x <= size; x += spacing) {
      this.gridGraphics.lineBetween(x, -size, x, size);
    }
    for (let y = -size; y <= size; y += spacing) {
      this.gridGraphics.lineBetween(-size, y, size, y);
    }
  }

  private drawBoundary() {
    if (!this.boundaryGraphics) return;
    this.boundaryGraphics.clear();

    // Red warning zone
    this.boundaryGraphics.lineStyle(4, 0xff0044, 0.6);
    this.boundaryGraphics.strokeCircle(0, 0, this.arenaRadius);

    // Softer inner ring
    this.boundaryGraphics.lineStyle(2, 0xff0044, 0.2);
    this.boundaryGraphics.strokeCircle(0, 0, this.arenaRadius * 0.95);
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
