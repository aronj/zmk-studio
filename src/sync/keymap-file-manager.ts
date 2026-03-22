/**
 * Manages the .keymap file: builds behavior ID→name mappings via initial
 * positional alignment, resolves bindings from numeric to text, and
 * performs debounced surgical file updates.
 */

import * as fs from "fs";
import {
  type ParsedKeymap,
  parseKeymapFile,
  replaceBinding,
} from "./keymap-parser";
import {
  type ConstantTables,
  buildConstantTables,
  resolveParams,
} from "./zmk-constants";
import type {
  InitSyncMessage,
  BindingChangedMessage,
  LayersChangedMessage,
  BehaviorMetadata,
  ParamType,
} from "./types";

export interface KeymapFileManagerConfig {
  /** Path to the .keymap file */
  keymapPath: string;
  /** Path to ZMK firmware root (containing app/include/) */
  zmkFirmwarePath: string;
}

export class KeymapFileManager {
  private config: KeymapFileManagerConfig;
  private tables: ConstantTables;
  private parsed: ParsedKeymap | null = null;

  /** behaviorId → behavior short name (e.g., 0 → "kp", 5 → "mo") */
  private behaviorIdToName = new Map<number, string>();
  /** Behavior metadata from RPC */
  private behaviorMeta = new Map<number, BehaviorMetadata>();

  /** Debounce timer for file writes */
  private writeTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingWrite: string | null = null;

  /** File watcher for external changes */
  private watcher: fs.FSWatcher | null = null;
  /** Timestamp of our last write, to ignore self-triggered watch events */
  private lastWriteTime = 0;

  constructor(config: KeymapFileManagerConfig) {
    this.config = config;
    this.tables = buildConstantTables(config.zmkFirmwarePath);
    console.log(
      `[keymap-sync] Loaded ${this.tables.hidToName.size} HID key names, ` +
        `${this.tables.behaviorConstants.size} behavior constant tables`
    );
  }

  /**
   * Initialize sync: read the .keymap file, receive keyboard state,
   * and build the behavior ID → name mapping by positional alignment.
   */
  initSync(msg: InitSyncMessage): { ok: boolean; message: string } {
    try {
      // Read and parse the .keymap file
      const fileContent = fs.readFileSync(this.config.keymapPath, "utf-8");
      this.parsed = parseKeymapFile(fileContent);

      // Store behavior metadata
      this.behaviorMeta.clear();
      for (const [id, meta] of Object.entries(msg.behaviors)) {
        this.behaviorMeta.set(Number(id), meta);
      }

      // Validate layer counts match
      if (msg.layers.length !== this.parsed.layers.length) {
        const message =
          `Layer count mismatch: keyboard has ${msg.layers.length} layers, ` +
          `.keymap file has ${this.parsed.layers.length} layers. Sync disabled.`;
        console.warn(`[keymap-sync] ${message}`);
        this.parsed = null;
        return { ok: false, message };
      }

      // Build behavior ID → name mapping by positional alignment
      this.behaviorIdToName.clear();
      for (let li = 0; li < msg.layers.length; li++) {
        const kbLayer = msg.layers[li];
        const fileLayer = this.parsed.layers[li];

        if (kbLayer.bindings.length !== fileLayer.bindings.length) {
          console.warn(
            `[keymap-sync] Binding count mismatch in layer ${li}: keyboard has ${kbLayer.bindings.length}, ` +
              `file has ${fileLayer.bindings.length}. Skipping layer for mapping (sync will still work for other layers).`
          );
          continue;
        }

        for (let ki = 0; ki < kbLayer.bindings.length; ki++) {
          const kbBinding = kbLayer.bindings[ki];
          const fileBinding = fileLayer.bindings[ki];

          // Extract behavior name from the file binding text
          // e.g., "&kp F1" → "kp", "&lt NAV SPACE" → "lt", "&trans" → "trans"
          const behaviorName = extractBehaviorName(fileBinding.text);
          if (behaviorName && !this.behaviorIdToName.has(kbBinding.behaviorId)) {
            this.behaviorIdToName.set(kbBinding.behaviorId, behaviorName);
          }
        }
      }

      console.log(
        `[keymap-sync] Initialized with ${this.behaviorIdToName.size} behavior mappings:`,
        Object.fromEntries(this.behaviorIdToName)
      );

      // Start watching the file for external changes
      this.startFileWatch();

      return {
        ok: true,
        message: `Sync initialized: ${this.parsed.layers.length} layers, ${this.behaviorIdToName.size} behaviors mapped`,
      };
    } catch (err: any) {
      const message = `Failed to initialize sync: ${err.message}`;
      console.error(`[keymap-sync] ${message}`);
      return { ok: false, message };
    }
  }

  /**
   * Handle a single binding change: resolve the new binding to text
   * and update the .keymap file.
   */
  onBindingChanged(msg: BindingChangedMessage): { ok: boolean; message: string } {
    if (!this.parsed) {
      return { ok: false, message: "Sync not initialized" };
    }

    const { layerIndex, keyPosition, binding } = msg;
    const layer = this.parsed.layers[layerIndex];
    if (!layer) {
      return { ok: false, message: `Layer ${layerIndex} not found` };
    }
    if (keyPosition >= layer.bindings.length) {
      return {
        ok: false,
        message: `Key position ${keyPosition} out of range (layer has ${layer.bindings.length} bindings)`,
      };
    }

    // Resolve behavior name
    const behaviorName = this.behaviorIdToName.get(binding.behaviorId);
    if (!behaviorName) {
      // Completely unknown behavior — use placeholder with raw values
      const meta = this.behaviorMeta.get(binding.behaviorId);
      const displayName = meta?.displayName ?? `unknown_${binding.behaviorId}`;
      const text =
        binding.param1 === 0 && binding.param2 === 0
          ? `&${displayName}`
          : `&${displayName} ${binding.param1} ${binding.param2} /* unresolved */`;
      console.warn(
        `[keymap-sync] Unknown behaviorId ${binding.behaviorId} (${displayName}), using raw values`
      );
      this.applyChange(layerIndex, keyPosition, text);
      return {
        ok: true,
        message: `Updated with unresolved behavior: ${text}`,
      };
    }

    // Resolve parameters
    const paramTypes = this.getParamTypes(binding.behaviorId);

    // For 0-cell behaviors, always emit just the name regardless of param values
    if (paramTypes.length === 0) {
      const text = `&${behaviorName}`;
      this.applyChange(layerIndex, keyPosition, text);

      const oldText = layer.bindings[keyPosition].text;
      console.log(
        `[keymap-sync] Layer ${layerIndex}, key ${keyPosition}: "${oldText}" → "${text}"`
      );
      return { ok: true, message: `Updated: ${text}` };
    }

    const params = resolveParams(
      behaviorName,
      binding.param1,
      binding.param2,
      this.tables,
      this.parsed.layerDefines,
      paramTypes
    );

    // Build the binding text
    const text =
      params.length > 0
        ? `&${behaviorName} ${params.join(" ")}`
        : `&${behaviorName}`;

    this.applyChange(layerIndex, keyPosition, text);

    const oldText = layer.bindings[keyPosition].text;
    console.log(
      `[keymap-sync] Layer ${layerIndex}, key ${keyPosition}: "${oldText}" → "${text}"`
    );

    return { ok: true, message: `Updated: ${text}` };
  }

  /**
   * Handle layer structural changes (add/remove/move/rename).
   * Re-reads the file, diffs against the new keyboard state, and updates.
   */
  onLayersChanged(msg: LayersChangedMessage): { ok: boolean; message: string } {
    if (!this.parsed) {
      return { ok: false, message: "Sync not initialized" };
    }

    try {
      // Re-read the current .keymap file to get fresh state
      const fileContent = fs.readFileSync(this.config.keymapPath, "utf-8");
      this.parsed = parseKeymapFile(fileContent);

      const kbLayerCount = msg.layers.length;
      const fileLayerCount = this.parsed.layers.length;

      if (kbLayerCount > fileLayerCount) {
        // Layers were added — insert new layer blocks
        for (let i = fileLayerCount; i < kbLayerCount; i++) {
          const kbLayer = msg.layers[i];
          const bindingCount = kbLayer.bindings.length;
          this.insertLayerBlock(kbLayer.name || `layer_${i}`, bindingCount, i);
        }
      } else if (kbLayerCount < fileLayerCount) {
        // Layers were removed — remove excess layer blocks from the end
        // Remove from highest index first to keep offsets valid
        for (let i = fileLayerCount - 1; i >= kbLayerCount; i--) {
          this.removeLayerBlock(i);
        }
      }

      // Re-parse after structural changes
      if (kbLayerCount !== fileLayerCount) {
        this.parsed = parseKeymapFile(this.parsed.rawText);
      }

      // Validate counts now match
      if (msg.layers.length !== this.parsed.layers.length) {
        const message =
          `Layer count still mismatched after adjustment: keyboard has ${msg.layers.length}, ` +
          `file has ${this.parsed.layers.length}. Re-sync needed.`;
        console.warn(`[keymap-sync] ${message}`);
        return { ok: false, message };
      }

      // Re-align all bindings: rebuild behavior mapping and update all bindings
      this.behaviorIdToName.clear();
      for (let li = 0; li < msg.layers.length; li++) {
        const kbLayer = msg.layers[li];
        const fileLayer = this.parsed.layers[li];

        if (kbLayer.bindings.length !== fileLayer.bindings.length) {
          console.warn(
            `[keymap-sync] Binding count mismatch in layer ${li} during re-sync: ` +
              `keyboard has ${kbLayer.bindings.length}, file has ${fileLayer.bindings.length}. Skipping layer.`
          );
          continue;
        }

        for (let ki = 0; ki < kbLayer.bindings.length; ki++) {
          const kbBinding = kbLayer.bindings[ki];
          const fileBinding = fileLayer.bindings[ki];
          const behaviorName = extractBehaviorName(fileBinding.text);
          if (behaviorName && !this.behaviorIdToName.has(kbBinding.behaviorId)) {
            this.behaviorIdToName.set(kbBinding.behaviorId, behaviorName);
          }
        }
      }

      // Now update all bindings to match keyboard state
      // Re-parse again to get clean offsets
      this.parsed = parseKeymapFile(this.parsed.rawText);

      for (let li = 0; li < msg.layers.length; li++) {
        const kbLayer = msg.layers[li];
        const fileLayer = this.parsed.layers[li];
        if (!fileLayer || kbLayer.bindings.length !== fileLayer.bindings.length) continue;

        for (let ki = 0; ki < kbLayer.bindings.length; ki++) {
          const kbBinding = kbLayer.bindings[ki];
          const behaviorName = this.behaviorIdToName.get(kbBinding.behaviorId);
          if (!behaviorName) continue;

          const paramTypes = this.getParamTypes(kbBinding.behaviorId);
          const params = resolveParams(
            behaviorName,
            kbBinding.param1,
            kbBinding.param2,
            this.tables,
            this.parsed.layerDefines,
            paramTypes
          );

          const newBindingText =
            params.length > 0
              ? `&${behaviorName} ${params.join(" ")}`
              : `&${behaviorName}`;

          // Only replace if different
          if (newBindingText !== fileLayer.bindings[ki].text) {
            replaceBinding(this.parsed, li, ki, newBindingText);
          }
        }
      }

      // Update #define layer constants
      this.updateLayerDefines(msg.layers);

      this.scheduleWrite(this.parsed.rawText);

      console.log(
        `[keymap-sync] Layers re-synced: ${msg.layers.length} layers, ` +
          `${this.behaviorIdToName.size} behaviors mapped`
      );

      return {
        ok: true,
        message: `Layers re-synced: ${msg.layers.length} layers`,
      };
    } catch (err: any) {
      const message = `Failed to re-sync layers: ${err.message}`;
      console.error(`[keymap-sync] ${message}`);
      return { ok: false, message };
    }
  }

  /**
   * Insert a new layer block into the .keymap file.
   */
  private insertLayerBlock(name: string, bindingCount: number, _index: number): void {
    if (!this.parsed) return;

    // Build the layer block with &none bindings
    const noneBindings = Array(bindingCount).fill("&none").join(" ");
    const layerBlock = `\n        ${name} {\n            bindings = <\n            ${noneBindings}\n            >;\n        };\n`;

    // Find the end of the keymap block (before the closing `};`)
    // Insert before the last `};` in the keymap section
    const keymapEndRe = /(\n    \};\n\};\s*)$/;
    const match = this.parsed.rawText.match(keymapEndRe);
    if (match && match.index !== undefined) {
      const insertPos = match.index;
      this.parsed.rawText =
        this.parsed.rawText.substring(0, insertPos) +
        layerBlock +
        this.parsed.rawText.substring(insertPos);
    }
  }

  /**
   * Remove a layer block from the .keymap file by index.
   */
  private removeLayerBlock(layerIndex: number): void {
    if (!this.parsed || layerIndex >= this.parsed.layers.length) return;

    const layer = this.parsed.layers[layerIndex];
    // Find the full layer block: search backwards from bindingsStart for the layer name
    // and forwards from bindingsEnd for the closing `};`
    const text = this.parsed.rawText;

    // Find the start of this layer block
    const layerNamePattern = new RegExp(
      `\\n(\\s+)${layer.name}\\s*\\{`,
      "g"
    );
    let blockStart = -1;
    let m;
    while ((m = layerNamePattern.exec(text)) !== null) {
      if (m.index < layer.bindingsStart) {
        blockStart = m.index;
      }
    }

    if (blockStart === -1) return;

    // Find the end of this layer block (matching closing `};`)
    let depth = 0;
    let blockEnd = blockStart;
    let foundOpen = false;
    for (let i = blockStart; i < text.length; i++) {
      if (text[i] === "{") {
        depth++;
        foundOpen = true;
      } else if (text[i] === "}") {
        depth--;
        if (foundOpen && depth === 0) {
          // Skip past the `};`
          blockEnd = i + 1;
          if (text[blockEnd] === ";") blockEnd++;
          break;
        }
      }
    }

    // Remove the block
    this.parsed.rawText =
      text.substring(0, blockStart) + text.substring(blockEnd);
  }

  /**
   * Update #define layer constants to match the new layer order.
   */
  private updateLayerDefines(
    layers: { id: number; name: string }[]
  ): void {
    if (!this.parsed) return;

    // Remove existing layer #define lines and rebuild
    let text = this.parsed.rawText;

    // Remove all existing layer defines
    for (const [, name] of this.parsed.layerDefines) {
      const defineRe = new RegExp(`^#define\\s+${name}\\s+\\d+\\s*$\\n?`, "gm");
      text = text.replace(defineRe, "");
    }

    // Find where to insert new defines (after last #define or after #include block)
    const lastDefineMatch = [...text.matchAll(/^#define\s+\w+\s+.+$/gm)];
    const lastIncludeMatch = [...text.matchAll(/^#include\s+.+$/gm)];

    let insertPos: number;
    if (lastDefineMatch.length > 0) {
      const last = lastDefineMatch[lastDefineMatch.length - 1];
      insertPos = last.index! + last[0].length;
    } else if (lastIncludeMatch.length > 0) {
      const last = lastIncludeMatch[lastIncludeMatch.length - 1];
      insertPos = last.index! + last[0].length;
    } else {
      insertPos = 0;
    }

    // Build new defines
    // Use layer names from the keyboard, converting to uppercase
    const newDefines = layers
      .map((layer, i) => {
        const defineName = layer.name
          .replace(/_layer$/, "")
          .toUpperCase();
        return `#define ${defineName} ${i}`;
      })
      .join("\n");

    text =
      text.substring(0, insertPos) +
      "\n" + newDefines + "\n" +
      text.substring(insertPos);

    this.parsed.rawText = text;
    // Re-parse to update all data structures
    this.parsed = parseKeymapFile(text);
  }

  /**
   * Get parameter types for a behavior from its metadata.
   */
  private getParamTypes(behaviorId: number): ParamType[] {
    const meta = this.behaviorMeta.get(behaviorId);
    if (!meta) return [];
    return meta.paramTypes;
  }

  /**
   * Apply a binding text change and schedule a debounced file write.
   */
  private applyChange(
    layerIndex: number,
    keyPosition: number,
    newText: string
  ): void {
    if (!this.parsed) return;

    const newRawText = replaceBinding(
      this.parsed,
      layerIndex,
      keyPosition,
      newText
    );

    this.scheduleWrite(newRawText);
  }

  /**
   * Schedule a debounced write to the .keymap file.
   * Multiple rapid changes (e.g., undo/redo) are coalesced.
   */
  private scheduleWrite(content: string): void {
    this.pendingWrite = content;

    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
    }

    this.writeTimer = setTimeout(() => {
      this.flushWrite();
    }, 300);
  }

  /**
   * Write pending content to the .keymap file atomically.
   */
  private flushWrite(): void {
    if (!this.pendingWrite) return;

    const tmpPath = this.config.keymapPath + ".tmp";
    try {
      fs.writeFileSync(tmpPath, this.pendingWrite, "utf-8");
      fs.renameSync(tmpPath, this.config.keymapPath);
      this.lastWriteTime = Date.now();
      console.log(`[keymap-sync] Written to ${this.config.keymapPath}`);
    } catch (err: any) {
      console.error(`[keymap-sync] Failed to write: ${err.message}`);
      // Clean up temp file on failure
      try {
        fs.unlinkSync(tmpPath);
      } catch {}
    }
    this.pendingWrite = null;
    this.writeTimer = null;
  }

  /** Flush any pending writes immediately (for cleanup). */
  flush(): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
    }
    this.flushWrite();
    this.stopFileWatch();
  }

  /**
   * Start watching the .keymap file for external changes.
   * If the file is modified externally (e.g., manual edit, git checkout),
   * re-read and re-parse it so the in-memory state stays fresh.
   */
  private startFileWatch(): void {
    this.stopFileWatch();

    try {
      this.watcher = fs.watch(this.config.keymapPath, (_eventType) => {
        // Ignore changes triggered by our own writes (within 1 second)
        if (Date.now() - this.lastWriteTime < 1000) return;

        console.log("[keymap-sync] External file change detected, re-reading...");
        try {
          const content = fs.readFileSync(this.config.keymapPath, "utf-8");
          const newParsed = parseKeymapFile(content);

          // Check if re-parsed file is still compatible
          if (this.parsed && newParsed.layers.length === this.parsed.layers.length) {
            this.parsed = newParsed;
            console.log("[keymap-sync] File re-read successfully, sync continues.");
          } else {
            console.warn(
              "[keymap-sync] File changed with different layer count. " +
                "Sync paused until next INIT_SYNC."
            );
            this.parsed = null;
          }
        } catch (err: any) {
          console.warn(`[keymap-sync] Failed to re-read file: ${err.message}`);
        }
      });
    } catch (err: any) {
      console.warn(`[keymap-sync] Could not watch file: ${err.message}`);
    }
  }

  /**
   * Stop watching the .keymap file.
   */
  private stopFileWatch(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }
}

/**
 * Extract the behavior short name from a binding text string.
 * E.g., "&kp F1" → "kp", "&lt NAV SPACE" → "lt", "&trans" → "trans"
 */
function extractBehaviorName(bindingText: string): string | null {
  const m = bindingText.match(/^&(\w+)/);
  return m ? m[1] : null;
}
