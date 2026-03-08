"use client";

import { useEffect, useRef, useState } from "react";
import * as Colyseus from "colyseus.js";

interface SnakeGameProps {
  room: Colyseus.Room;
  onDeath: (data: any) => void;
  onCashout: (data: any) => void;
}

export default function SnakeGame({ room, onDeath, onCashout }: SnakeGameProps) {
  const gameRef = useRef<HTMLDivElement>(null);
  const phaserRef = useRef<any>(null);
  const [stats, setStats] = useState({ kills: 0, value: 0, alive: 0 });

  useEffect(() => {
    if (!gameRef.current || phaserRef.current) return;

    // Dynamic import Phaser (client-side only)
    import("phaser").then((Phaser) => {
      import("../lib/phaser/SnakeScene").then(({ SnakeScene }) => {
        const scene = new SnakeScene();
        scene.onDeath = onDeath;
        scene.onCashout = onCashout;
        scene.onStatsUpdate = setStats;

        // Set room directly on the instance BEFORE Phaser boots
        (scene as any).room = room;
        (scene as any).mySessionId = room.sessionId;

        const config: Phaser.Types.Core.GameConfig = {
          type: Phaser.AUTO,
          parent: gameRef.current!,
          width: window.innerWidth,
          height: window.innerHeight,
          backgroundColor: "#0a0a1a",
          scene: [scene],
          physics: { default: "arcade" },
          scale: {
            mode: Phaser.Scale.RESIZE,
            autoCenter: Phaser.Scale.CENTER_BOTH,
          },
          input: {
            touch: { capture: true },
          },
        };

        phaserRef.current = new Phaser.Game(config);
      });
    });

    return () => {
      phaserRef.current?.destroy(true);
      phaserRef.current = null;
    };
  }, [room]);

  const handleCashout = () => {
    room.send("cashout");
  };

  return (
    <div className="relative w-full h-screen">
      {/* Game canvas */}
      <div ref={gameRef} className="w-full h-full" />

      {/* HUD Overlay */}
      <div className="absolute top-0 left-0 right-0 p-4 flex justify-between items-start pointer-events-none">
        {/* Balance */}
        <div className="bg-black/70 rounded-lg px-4 py-2 backdrop-blur-sm">
          <div className="text-sm text-gray-400">Balance</div>
          <div className="text-2xl font-bold text-green-400">
            ${stats.value.toFixed(2)}
          </div>
        </div>

        {/* Stats */}
        <div className="flex gap-3">
          <div className="bg-black/70 rounded-lg px-3 py-2 backdrop-blur-sm text-center">
            <div className="text-xs text-gray-400">Kills</div>
            <div className="text-lg font-bold text-white">{stats.kills}</div>
          </div>
          <div className="bg-black/70 rounded-lg px-3 py-2 backdrop-blur-sm text-center">
            <div className="text-xs text-gray-400">Alive</div>
            <div className="text-lg font-bold text-white">{stats.alive}</div>
          </div>
        </div>

        {/* Cash Out Button */}
        <button
          onClick={handleCashout}
          className="pointer-events-auto bg-green-500 hover:bg-green-400 text-black font-bold px-6 py-3 rounded-lg transition-colors"
        >
          Cash Out ${stats.value.toFixed(2)}
        </button>
      </div>
    </div>
  );
}
