"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { VoicePeer } from "./VoiceChat";
import { MockVoiceChat } from "./MockVoiceChat";
import * as Colyseus from "colyseus.js";

function calculateProximityVolume(myX: number, myY: number, otherX: number, otherY: number): number {
  const dist = Math.sqrt((myX - otherX) ** 2 + (myY - otherY) ** 2);
  if (dist < 300) return 1.0;
  if (dist > 1500) return 0.1;
  return 1.0 - (dist - 300) / (1500 - 300) * 0.9;
}

export interface VoiceChatState {
  selfMuted: boolean;
  peers: Map<string, VoicePeer>;
  voiceEnabled: boolean;
  toggleSelfMute: () => void;
  mutePeer: (sessionId: string) => void;
  unmutePeer: (sessionId: string) => void;
  setVoiceEnabled: (enabled: boolean) => void;
}

export function useVoiceChat(
  room: Colyseus.Room | null,
  localSnakes: Map<string, any> | null,
  mySessionId: string
): VoiceChatState {
  const [selfMuted, setSelfMuted] = useState(false);
  const [peers, setPeers] = useState<Map<string, VoicePeer>>(new Map());
  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const voiceChatRef = useRef<MockVoiceChat | null>(null);
  const volumeIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Init mock voice chat on room join
  useEffect(() => {
    if (!room || !voiceEnabled) return;

    const vc = new MockVoiceChat();
    voiceChatRef.current = vc;

    vc.setCallbacks({
      onPeerJoined: () => setPeers(new Map(vc.getPeers())),
      onPeerLeft: () => setPeers(new Map(vc.getPeers())),
      onTalkingChanged: () => setPeers(new Map(vc.getPeers())),
    });

    vc.join(room.id, room.sessionId, "me");

    return () => {
      vc.destroy();
      voiceChatRef.current = null;
      setPeers(new Map());
    };
  }, [room, voiceEnabled]);

  // Sync peers from game snakes and update proximity volumes every 500ms
  useEffect(() => {
    if (!voiceChatRef.current || !localSnakes) return;

    volumeIntervalRef.current = setInterval(() => {
      const vc = voiceChatRef.current;
      if (!vc || !localSnakes) return;

      // Sync peer list from alive snakes
      vc.syncPeers(localSnakes, mySessionId);

      // Update proximity volumes
      const me = localSnakes.get(mySessionId);
      if (me && me.alive) {
        for (const [id, peer] of vc.getPeers()) {
          const other = localSnakes.get(id);
          if (other && other.alive) {
            const vol = calculateProximityVolume(me.headX, me.headY, other.headX, other.headY);
            vc.setPeerVolume(id, vol);
          }
        }
      }

      setPeers(new Map(vc.getPeers()));
    }, 500);

    return () => {
      if (volumeIntervalRef.current) {
        clearInterval(volumeIntervalRef.current);
        volumeIntervalRef.current = null;
      }
    };
  }, [localSnakes, mySessionId]);

  const toggleSelfMute = useCallback(() => {
    const vc = voiceChatRef.current;
    if (!vc) return;
    if (vc.isSelfMuted()) {
      vc.unmuteSelf();
      setSelfMuted(false);
    } else {
      vc.muteSelf();
      setSelfMuted(true);
    }
  }, []);

  const mutePeer = useCallback((sessionId: string) => {
    voiceChatRef.current?.mutePeer(sessionId);
    setPeers(new Map(voiceChatRef.current?.getPeers() || []));
  }, []);

  const unmutePeer = useCallback((sessionId: string) => {
    voiceChatRef.current?.unmutePeer(sessionId);
    setPeers(new Map(voiceChatRef.current?.getPeers() || []));
  }, []);

  return { selfMuted, peers, voiceEnabled, toggleSelfMute, mutePeer, unmutePeer, setVoiceEnabled };
}
