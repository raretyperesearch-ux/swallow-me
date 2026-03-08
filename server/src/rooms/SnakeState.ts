import { Schema, MapSchema, ArraySchema, type, defineTypes } from "@colyseus/schema";

export class SnakeEntity extends Schema {
  @type("string") id: string = "";
  @type("string") name: string = "";
  @type("float32") headX: number = 0;
  @type("float32") headY: number = 0;
  @type("float32") angle: number = 0;
  @type("float32") speed: number = 0;
  @type("boolean") boosting: boolean = false;
  @type("uint16") length: number = 10;
  @type("uint8") skinId: number = 0;
  @type("boolean") isBot: boolean = false;
  @type("boolean") alive: boolean = true;
  @type("uint16") kills: number = 0;
  @type("float64") valueUsdc: number = 0;
}

export class FoodOrb extends Schema {
  @type("float32") x: number = 0;
  @type("float32") y: number = 0;
  @type("uint8") size: number = 1; // 1=normal, 2=from-death (bigger/more value)
  @type("string") id: string = "";
}

export class KillFeedEntry extends Schema {
  @type("string") killerName: string = "";
  @type("string") victimName: string = "";
  @type("float64") amount: number = 0;
  @type("float64") timestamp: number = 0;
}

export class SnakeRoomState extends Schema {
  @type({ map: SnakeEntity }) snakes = new MapSchema<SnakeEntity>();
  @type({ map: FoodOrb }) food = new MapSchema<FoodOrb>();
  @type([KillFeedEntry]) killFeed = new ArraySchema<KillFeedEntry>();
  @type("uint8") tier: number = 1;
  @type("uint16") playerCount: number = 0;
  @type("uint16") aliveCount: number = 0;
  @type("float64") arenaRadius: number = 3000;
}
