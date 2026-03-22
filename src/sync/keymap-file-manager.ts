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
          const message =
            `Binding count mismatch in layer ${li}: keyboard has ${kbLayer.bindings.length}, ` +
            `file has ${fileLayer.bindings.length}. Sync disabled.`;
          console.warn(`[keymap-sync] ${message}`);
          this.parsed = null;
          return { ok: false, message };
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
      // Unknown behavior — use placeholder
      const text = `&unknown_${binding.behaviorId} /* ${binding.param1} ${binding.param2} */`;
      console.warn(
        `[keymap-sync] Unknown behaviorId ${binding.behaviorId}, using placeholder`
      );
      this.applyChange(layerIndex, keyPosition, text);
      return {
        ok: true,
        message: `Updated with unknown behavior placeholder`,
      };
    }

    // Resolve parameters
    const paramTypes = this.getParamTypes(binding.behaviorId);
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
