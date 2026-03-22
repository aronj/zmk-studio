/**
 * React hook that connects to the keymap sync WebSocket server
 * and provides methods to notify about keymap changes.
 */

import { useEffect, useRef, useCallback } from "react";
import type { Keymap, BehaviorBinding } from "@zmkfirmware/zmk-studio-ts-client/keymap";
import type { GetBehaviorDetailsResponse } from "@zmkfirmware/zmk-studio-ts-client/behaviors";
import type {
  InitSyncMessage,
  BindingChangedMessage,
  LayersChangedMessage,
  BehaviorMetadata,
  ParamType,
} from "./types";

type BehaviorMap = Record<number, GetBehaviorDetailsResponse>;

function inferParamType(
  descriptions: { nil?: any; hidUsage?: any; layerId?: any; constant?: number; range?: any }[]
): ParamType {
  if (!descriptions || descriptions.length === 0) return "nil";
  for (const desc of descriptions) {
    if (desc.hidUsage !== undefined) return "hidUsage";
    if (desc.layerId !== undefined) return "layerId";
    if (desc.constant !== undefined || desc.range !== undefined) return "constant";
  }
  return "nil";
}

function extractParamTypes(details: GetBehaviorDetailsResponse): ParamType[] {
  if (!details.metadata || details.metadata.length === 0) return [];
  const paramSet = details.metadata[0];
  const types: ParamType[] = [];
  const p1Type = inferParamType(paramSet.param1);
  if (p1Type !== "nil") {
    types.push(p1Type);
    const p2Type = inferParamType(paramSet.param2);
    if (p2Type !== "nil") {
      types.push(p2Type);
    }
  }
  return types;
}

export interface KeymapSyncHandle {
  notifyBindingChange: (
    layerIndex: number,
    keyPosition: number,
    binding: BehaviorBinding
  ) => void;
  notifyLayersChanged: () => void;
}

/**
 * Hook that manages the WebSocket connection to the keymap sync server.
 * Uses refs to avoid re-render loops — keymap/behaviors are stored in refs
 * and only trigger init sync via a manual check, not a useEffect dependency.
 */
export function useKeymapSync(
  keymap: Keymap | undefined,
  behaviors: BehaviorMap
): KeymapSyncHandle {
  const wsRef = useRef<WebSocket | null>(null);
  const initializedRef = useRef(false);
  // Store latest values in refs to avoid stale closures and re-render loops
  const keymapRef = useRef(keymap);
  const behaviorsRef = useRef(behaviors);

  keymapRef.current = keymap;
  behaviorsRef.current = behaviors;

  // Try to send init sync if we have everything ready
  const trySendInitSync = useCallback(() => {
    const ws = wsRef.current;
    const km = keymapRef.current;
    const bh = behaviorsRef.current;
    if (
      ws &&
      ws.readyState === WebSocket.OPEN &&
      km &&
      Object.keys(bh).length > 0 &&
      !initializedRef.current
    ) {
      sendInitSync(ws, km, bh);
      initializedRef.current = true;
    }
  }, []);

  // Connect WebSocket — runs once on mount
  useEffect(() => {
    if (import.meta.env.PROD) return;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${protocol}//${window.location.host}/ws/keymap-sync`;

    let reconnectTimer: ReturnType<typeof setTimeout>;
    let closed = false;
    let ws: WebSocket;

    function connect() {
      ws = new WebSocket(url);

      ws.onopen = () => {
        console.log("[keymap-sync] Connected to sync server");
        wsRef.current = ws;
        trySendInitSync();
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === "STATUS") {
            if (msg.ok) {
              console.log(`[keymap-sync] ${msg.message}`);
            } else {
              console.warn(`[keymap-sync] Error: ${msg.message}`);
            }
          }
        } catch {}
      };

      ws.onclose = () => {
        wsRef.current = null;
        initializedRef.current = false;
        if (!closed) {
          reconnectTimer = setTimeout(connect, 3000);
        }
      };

      ws.onerror = () => {};
    }

    connect();

    return () => {
      closed = true;
      clearTimeout(reconnectTimer);
      ws?.close();
      wsRef.current = null;
      initializedRef.current = false;
    };
  }, [trySendInitSync]);

  // When keymap/behaviors become available, try init sync.
  // Use a simple interval check instead of useEffect deps to avoid loops.
  useEffect(() => {
    if (import.meta.env.PROD) return;
    if (initializedRef.current) return;

    const interval = setInterval(() => {
      if (initializedRef.current) {
        clearInterval(interval);
        return;
      }
      trySendInitSync();
    }, 500);

    return () => clearInterval(interval);
  }, [trySendInitSync]);

  const notifyBindingChange = useCallback(
    (layerIndex: number, keyPosition: number, binding: BehaviorBinding) => {
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
      if (!initializedRef.current) return;

      const msg: BindingChangedMessage = {
        type: "BINDING_CHANGED",
        layerIndex,
        keyPosition,
        binding: {
          behaviorId: binding.behaviorId,
          param1: binding.param1,
          param2: binding.param2,
        },
      };

      wsRef.current.send(JSON.stringify(msg));
    },
    []
  );

  const notifyLayersChanged = useCallback(() => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    if (!initializedRef.current) return;

    const km = keymapRef.current;
    if (!km) return;

    const msg: LayersChangedMessage = {
      type: "LAYERS_CHANGED",
      layers: km.layers.map((layer) => ({
        id: layer.id,
        name: layer.name,
        bindings: layer.bindings.map((b) => ({
          behaviorId: b.behaviorId,
          param1: b.param1,
          param2: b.param2,
        })),
      })),
    };

    wsRef.current.send(JSON.stringify(msg));
    console.log("[keymap-sync] Sent LAYERS_CHANGED");
  }, []);

  return { notifyBindingChange, notifyLayersChanged };
}

function sendInitSync(
  ws: WebSocket,
  keymap: Keymap,
  behaviors: BehaviorMap
): void {
  const behaviorsMeta: Record<number, BehaviorMetadata> = {};
  for (const [id, details] of Object.entries(behaviors)) {
    behaviorsMeta[Number(id)] = {
      id: details.id,
      displayName: details.displayName,
      paramTypes: extractParamTypes(details),
    };
  }

  const msg: InitSyncMessage = {
    type: "INIT_SYNC",
    layers: keymap.layers.map((layer) => ({
      id: layer.id,
      name: layer.name,
      bindings: layer.bindings.map((b) => ({
        behaviorId: b.behaviorId,
        param1: b.param1,
        param2: b.param2,
      })),
    })),
    behaviors: behaviorsMeta,
  };

  ws.send(JSON.stringify(msg));
  console.log("[keymap-sync] Sent INIT_SYNC");
}
