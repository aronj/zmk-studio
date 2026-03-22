import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { KeymapFileManager } from "../keymap-file-manager";
import { parseKeymapFile } from "../keymap-parser";
import type { InitSyncMessage, BindingChangedMessage } from "../types";

const KEYMAP_PATH = path.resolve(__dirname, "../../../../config/glove80.keymap");
const ZMK_FIRMWARE_PATH = path.resolve(__dirname, "../../../../zmk");

// Use a temp file for tests to avoid modifying the real keymap
const TEMP_KEYMAP_PATH = path.resolve(__dirname, "test-glove80.keymap.tmp");

function copyKeymapToTemp() {
  fs.copyFileSync(KEYMAP_PATH, TEMP_KEYMAP_PATH);
}

function cleanupTemp() {
  try {
    fs.unlinkSync(TEMP_KEYMAP_PATH);
  } catch {}
}

/**
 * Build a minimal INIT_SYNC message that matches the glove80.keymap structure.
 * Uses fake behaviorIds but correct layer/binding counts.
 */
function buildInitSyncMessage(): InitSyncMessage {
  const keymapText = fs.readFileSync(KEYMAP_PATH, "utf-8");
  const parsed = parseKeymapFile(keymapText);

  // Build a behavior name → id mapping
  const behaviorNameToId = new Map<string, number>();
  let nextId = 0;

  const layers = parsed.layers.map((layer: any) => ({
    id: parsed.allDefines.get(
      layer.name.replace("_layer", "").toUpperCase()
    ) ?? 0,
    name: layer.name,
    bindings: layer.bindings.map((b: any) => {
      const behaviorName = b.text.match(/^&(\w+)/)?.[1] ?? "unknown";
      if (!behaviorNameToId.has(behaviorName)) {
        behaviorNameToId.set(behaviorName, nextId++);
      }
      return {
        behaviorId: behaviorNameToId.get(behaviorName)!,
        param1: 0,
        param2: 0,
      };
    }),
  }));

  // Build behavior metadata
  const behaviors: Record<number, any> = {};
  for (const [name, id] of behaviorNameToId) {
    const paramTypes: string[] = [];
    // Assign param types based on known behaviors
    if (["kp", "sk", "kt"].includes(name)) {
      paramTypes.push("hidUsage");
    } else if (["mo", "to", "tog", "sl"].includes(name)) {
      paramTypes.push("layerId");
    } else if (["lt"].includes(name)) {
      paramTypes.push("layerId", "hidUsage");
    } else if (["mt"].includes(name)) {
      paramTypes.push("hidUsage", "hidUsage");
    } else if (["bt", "rgb_ug", "bl"].includes(name)) {
      paramTypes.push("constant", "constant");
    } else if (["out", "ext_power", "mkp"].includes(name)) {
      paramTypes.push("constant");
    }

    behaviors[id] = {
      id,
      displayName: name,
      paramTypes,
    };
  }

  return { type: "INIT_SYNC", layers, behaviors };
}

describe("KeymapFileManager", () => {
  beforeEach(() => {
    copyKeymapToTemp();
    return () => cleanupTemp();
  });

  it("constructs successfully with valid paths", () => {
    const manager = new KeymapFileManager({
      keymapPath: TEMP_KEYMAP_PATH,
      zmkFirmwarePath: ZMK_FIRMWARE_PATH,
    });
    expect(manager).toBeDefined();
  });

  describe("initSync", () => {
    it("initializes successfully with matching keymap", () => {
      const manager = new KeymapFileManager({
        keymapPath: TEMP_KEYMAP_PATH,
        zmkFirmwarePath: ZMK_FIRMWARE_PATH,
      });

      const msg = buildInitSyncMessage();
      const result = manager.initSync(msg);

      expect(result.ok).toBe(true);
      expect(result.message).toContain("Sync initialized");
      expect(result.message).toContain("8 layers");
    });

    it("builds behavior ID mappings", () => {
      const manager = new KeymapFileManager({
        keymapPath: TEMP_KEYMAP_PATH,
        zmkFirmwarePath: ZMK_FIRMWARE_PATH,
      });

      const msg = buildInitSyncMessage();
      const result = manager.initSync(msg);

      expect(result.ok).toBe(true);
      // Should have mapped behaviors like kp, trans, lt, mo, etc.
      expect(result.message).toContain("behaviors mapped");
    });

    it("fails on layer count mismatch", () => {
      const manager = new KeymapFileManager({
        keymapPath: TEMP_KEYMAP_PATH,
        zmkFirmwarePath: ZMK_FIRMWARE_PATH,
      });

      const msg = buildInitSyncMessage();
      // Remove a layer to cause mismatch
      msg.layers.pop();

      const result = manager.initSync(msg);
      expect(result.ok).toBe(false);
      expect(result.message).toContain("Layer count mismatch");
    });

    it("warns but succeeds on binding count mismatch (skips mismatched layer)", () => {
      const manager = new KeymapFileManager({
        keymapPath: TEMP_KEYMAP_PATH,
        zmkFirmwarePath: ZMK_FIRMWARE_PATH,
      });

      const msg = buildInitSyncMessage();
      // Remove a binding from the first layer
      msg.layers[0].bindings.pop();

      const result = manager.initSync(msg);
      // Should still succeed — just skips the mismatched layer for mapping
      expect(result.ok).toBe(true);
      expect(result.message).toContain("Sync initialized");
    });
  });

  describe("onBindingChanged", () => {
    it("returns error when not initialized", () => {
      const manager = new KeymapFileManager({
        keymapPath: TEMP_KEYMAP_PATH,
        zmkFirmwarePath: ZMK_FIRMWARE_PATH,
      });

      const msg: BindingChangedMessage = {
        type: "BINDING_CHANGED",
        layerIndex: 0,
        keyPosition: 0,
        binding: { behaviorId: 0, param1: 0x070004, param2: 0 },
      };

      const result = manager.onBindingChanged(msg);
      expect(result.ok).toBe(false);
      expect(result.message).toBe("Sync not initialized");
    });

    it("updates binding after init", () => {
      const manager = new KeymapFileManager({
        keymapPath: TEMP_KEYMAP_PATH,
        zmkFirmwarePath: ZMK_FIRMWARE_PATH,
      });

      const initMsg = buildInitSyncMessage();
      manager.initSync(initMsg);

      // Find the behaviorId for "kp" from our init message
      const kpId = Object.values(initMsg.behaviors).find(
        (b: any) => b.displayName === "kp"
      )?.id;
      expect(kpId).toBeDefined();

      const changeMsg: BindingChangedMessage = {
        type: "BINDING_CHANGED",
        layerIndex: 0,
        keyPosition: 0, // First key (F1 in default layer)
        binding: { behaviorId: kpId!, param1: 0x070004, param2: 0 }, // A key
      };

      const result = manager.onBindingChanged(changeMsg);
      expect(result.ok).toBe(true);
      expect(result.message).toContain("Updated");

      // Flush to write the file
      manager.flush();

      // Verify the file was updated
      const content = fs.readFileSync(TEMP_KEYMAP_PATH, "utf-8");
      // The first binding should now be &kp A instead of &kp F1
      expect(content).toContain("&kp A");
    });

    it("returns error for out-of-range layer", () => {
      const manager = new KeymapFileManager({
        keymapPath: TEMP_KEYMAP_PATH,
        zmkFirmwarePath: ZMK_FIRMWARE_PATH,
      });

      manager.initSync(buildInitSyncMessage());

      const result = manager.onBindingChanged({
        type: "BINDING_CHANGED",
        layerIndex: 99,
        keyPosition: 0,
        binding: { behaviorId: 0, param1: 0, param2: 0 },
      });

      expect(result.ok).toBe(false);
      expect(result.message).toContain("not found");
    });

    it("returns error for out-of-range key position", () => {
      const manager = new KeymapFileManager({
        keymapPath: TEMP_KEYMAP_PATH,
        zmkFirmwarePath: ZMK_FIRMWARE_PATH,
      });

      manager.initSync(buildInitSyncMessage());

      const result = manager.onBindingChanged({
        type: "BINDING_CHANGED",
        layerIndex: 0,
        keyPosition: 999,
        binding: { behaviorId: 0, param1: 0, param2: 0 },
      });

      expect(result.ok).toBe(false);
      expect(result.message).toContain("out of range");
    });

    it("handles unknown behaviorId with placeholder", () => {
      const manager = new KeymapFileManager({
        keymapPath: TEMP_KEYMAP_PATH,
        zmkFirmwarePath: ZMK_FIRMWARE_PATH,
      });

      manager.initSync(buildInitSyncMessage());

      const result = manager.onBindingChanged({
        type: "BINDING_CHANGED",
        layerIndex: 0,
        keyPosition: 0,
        binding: { behaviorId: 9999, param1: 42, param2: 7 },
      });

      expect(result.ok).toBe(true);
      expect(result.message).toContain("unknown");

      manager.flush();
      const content = fs.readFileSync(TEMP_KEYMAP_PATH, "utf-8");
      expect(content).toContain("&unknown_9999");
    });
  });

  describe("flush", () => {
    it("is safe to call when no pending writes", () => {
      const manager = new KeymapFileManager({
        keymapPath: TEMP_KEYMAP_PATH,
        zmkFirmwarePath: ZMK_FIRMWARE_PATH,
      });

      // Should not throw
      expect(() => manager.flush()).not.toThrow();
    });
  });
});
