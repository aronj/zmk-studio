/**
 * Vite plugin that attaches a WebSocket server to the dev server
 * for receiving keymap changes from the React app and writing
 * them to the local .keymap file.
 */

import type { Plugin, ViteDevServer } from "vite";
import { WebSocketServer, WebSocket } from "ws";
import * as path from "path";
import { KeymapFileManager } from "./keymap-file-manager";
import type { SyncMessage, StatusMessage } from "./types";

export interface KeymapSyncPluginOptions {
  /** Path to the .keymap file. Default: ../../config/glove80.keymap */
  keymapPath?: string;
  /** Path to ZMK firmware root. Default: ../../zmk */
  zmkFirmwarePath?: string;
}

export function keymapSyncPlugin(options: KeymapSyncPluginOptions = {}): Plugin {
  let manager: KeymapFileManager | null = null;
  let wss: WebSocketServer | null = null;

  return {
    name: "keymap-sync",
    apply: "serve", // Only active in dev mode

    configureServer(server: ViteDevServer) {
      const studioRoot = process.cwd();
      const keymapPath =
        options.keymapPath ??
        process.env.KEYMAP_PATH ??
        path.resolve(studioRoot, "..", "config", "glove80.keymap");
      const zmkFirmwarePath =
        options.zmkFirmwarePath ??
        process.env.ZMK_FIRMWARE_PATH ??
        path.resolve(studioRoot, "..", "zmk");

      console.log(`[keymap-sync] Keymap path: ${keymapPath}`);
      console.log(`[keymap-sync] ZMK firmware path: ${zmkFirmwarePath}`);

      try {
        manager = new KeymapFileManager({ keymapPath, zmkFirmwarePath });
      } catch (err: any) {
        console.error(
          `[keymap-sync] Failed to initialize: ${err.message}. Sync disabled.`
        );
        return;
      }

      // Attach WebSocket server to Vite's HTTP server
      server.httpServer?.once("listening", () => {
        if (!server.httpServer) return;

        wss = new WebSocketServer({
          server: server.httpServer as any,
          path: "/ws/keymap-sync",
        });

        wss.on("connection", (ws: WebSocket) => {
          console.log("[keymap-sync] Client connected");

          ws.on("message", (data: Buffer | string) => {
            try {
              const msg: SyncMessage = JSON.parse(data.toString());
              handleMessage(ws, msg);
            } catch (err: any) {
              sendStatus(ws, false, `Invalid message: ${err.message}`);
            }
          });

          ws.on("close", () => {
            console.log("[keymap-sync] Client disconnected");
            manager?.flush();
          });
        });

        const addr = server.httpServer.address();
        const port = typeof addr === "object" ? addr?.port : addr;
        console.log(
          `[keymap-sync] WebSocket server ready at ws://localhost:${port}/ws/keymap-sync`
        );
      });

      // Clean up on server close
      server.httpServer?.on("close", () => {
        manager?.flush();
        wss?.close();
      });
    },
  };

  function handleMessage(ws: WebSocket, msg: SyncMessage): void {
    if (!manager) {
      sendStatus(ws, false, "Sync manager not initialized");
      return;
    }

    switch (msg.type) {
      case "INIT_SYNC": {
        const result = manager.initSync(msg);
        sendStatus(ws, result.ok, result.message);
        break;
      }
      case "BINDING_CHANGED": {
        const result = manager.onBindingChanged(msg);
        sendStatus(ws, result.ok, result.message);
        break;
      }
      case "LAYERS_CHANGED": {
        // v2: full re-sync after layer structural changes
        sendStatus(ws, false, "LAYERS_CHANGED not yet implemented (v2)");
        break;
      }
      default:
        sendStatus(ws, false, `Unknown message type: ${(msg as any).type}`);
    }
  }

  function sendStatus(ws: WebSocket, ok: boolean, message: string): void {
    const status: StatusMessage = { type: "STATUS", ok, message };
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(status));
    }
  }
}
