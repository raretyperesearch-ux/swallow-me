"use client";

import { useEffect, useRef, useState } from "react";
import * as Colyseus from "colyseus.js";

interface SnakeGameProps {
  room: Colyseus.Room;
  onDeath: (data: any) => void;
  onCashout: (data: any) => void;
}

export default function SnakeGame({ room, onDeath, onCashout }: SnakeGameProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<any>(null);
  const [stats, setStats] = useState({ kills: 0, value: 0, alive: 0 });

  useEffect(() => {
    if (!containerRef.current || rendererRef.current) return;

    // Dynamic import Canvas renderer (client-side only)
    import("../lib/canvas/GameRenderer").then(({ GameRenderer }) => {
      const renderer = new GameRenderer(containerRef.current!, room);
      renderer.onDeath = onDeath;
      renderer.onCashout = onCashout;
      renderer.onStatsUpdate = setStats;
      rendererRef.current = renderer;
    });

    return () => {
      rendererRef.current?.destroy();
      rendererRef.current = null;
    };
  }, [room]);

  const handleCashout = () => {
    room.send("cashout");
  };

  return (
    <div className="relative w-full h-screen">
      {/* Game canvas */}
      <div ref={containerRef} className="w-full h-full" />

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
