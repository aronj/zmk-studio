/**
 * Manages the .keymap file: builds behavior ID→name mappings via initial
 * positional alignment, resolves bindings from numeric to text, and
 * performs debounced surgical file updates.
 */

import * as fs from "fs";
import { exec } from "child_process";
import {
  type ParsedKeymap,
  parseKeymapFile,
  replaceBinding,
} from "./keymap-parser";
import {
  type ConstantTables,
  buildConstantTables,
  resolveParams,
  unresolveParams,
  splitParams,
} from "./zmk-constants";
import type {
  InitSyncMessage,
  BindingChangedMessage,
  LayersChangedMessage,
  BehaviorMetadata,
  BehaviorBindingData,
  FileBindingChangedMessage,
  FileFullResyncMessage,
  ParamType,
} from "./types";

export interface KeymapFileManagerConfig {
  /** Path to the .keymap file */
  keymapPath: string;
  /** Path to ZMK firmware root (containing app/include/) */
  zmkFirmwarePath: string;
  /** Shell command to run after writing the .keymap file (e.g., formatter) */
  fmtCommand?: string;
  /** Working directory for fmtCommand */
  fmtCwd?: string;
}

export class KeymapFileManager {
  private config: KeymapFileManagerConfig;
  private tables: ConstantTables;
  private parsed: ParsedKeymap | null = null;

  /** behaviorId → behavior short name (e.g., 0 → "kp", 5 → "mo") */
  private behaviorIdToName = new Map<number, string>();
  /** Reverse: behavior short name → behaviorId */
  private behaviorNameToId = new Map<string, number>();
  /** Behavior metadata from RPC */
  private behaviorMeta = new Map<number, BehaviorMetadata>();

  /** Debounce timer for file writes */
  private writeTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingWrite: string | null = null;

  /** Debounce timer for post-write formatter */
  private fmtTimer: ReturnType<typeof setTimeout> | null = null;

  /** File watcher for external changes */
  private watcher: fs.FSWatcher | null = null;
  /** Timestamp of our last write, to ignore self-triggered watch events */
  private lastWriteTime = 0;
  /** Flag-based loop protection: suppress file watcher during our own writes */
  private suppressFileWatch = false;
  /** Debounce timer for file watcher to coalesce rapid external edits */
  private watchDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  /** Callback for emitting file-originated changes to connected clients */
  private onFileChanged?: (messages: (FileBindingChangedMessage | FileFullResyncMessage)[]) => void;

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

      // Build behavior ID ↔ name mapping by positional alignment
      this.behaviorIdToName.clear();
      this.behaviorNameToId.clear();
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
            this.behaviorNameToId.set(behaviorName, kbBinding.behaviorId);
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
      this.behaviorNameToId.clear();
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
            this.behaviorNameToId.set(behaviorName, kbBinding.behaviorId);
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
    this.suppressFileWatch = true;
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

    const writeStart = performance.now();
    const tmpPath = this.config.keymapPath + ".tmp";
    try {
      fs.writeFileSync(tmpPath, this.pendingWrite, "utf-8");
      fs.renameSync(tmpPath, this.config.keymapPath);
      this.lastWriteTime = Date.now();
      const writeMs = (performance.now() - writeStart).toFixed(1);
      console.log(`[keymap-sync] Write completed in ${writeMs}ms → ${this.config.keymapPath}`);
      this.scheduleFormatter();
      // If no formatter configured, clear suppress flag now
      if (!this.config.fmtCommand) {
        this.suppressFileWatch = false;
      }
    } catch (err: any) {
      console.error(`[keymap-sync] Failed to write: ${err.message}`);
      this.suppressFileWatch = false;
      // Clean up temp file on failure
      try {
        fs.unlinkSync(tmpPath);
      } catch {}
    }
    this.pendingWrite = null;
    this.writeTimer = null;
  }

  /**
   * Schedule the post-write formatter with its own debounce.
   * Coalesces rapid writes so the formatter only runs once.
   */
  private scheduleFormatter(): void {
    if (!this.config.fmtCommand) return;

    if (this.fmtTimer) {
      clearTimeout(this.fmtTimer);
    }

    this.fmtTimer = setTimeout(() => {
      this.runFormatter();
    }, 200);
  }

  /**
   * Run the configured formatter command, then re-read the file
   * so our in-memory state stays in sync with the formatted output.
   */
  private runFormatter(): void {
    const { fmtCommand, fmtCwd } = this.config;
    if (!fmtCommand) return;

    const fmtStart = performance.now();
    exec(fmtCommand, { cwd: fmtCwd }, (err, _stdout, stderr) => {
      const fmtMs = (performance.now() - fmtStart).toFixed(1);
      if (err) {
        console.error(`[keymap-sync] Formatter failed in ${fmtMs}ms: ${err.message}`);
        if (stderr) console.error(`[keymap-sync] Formatter stderr: ${stderr}`);
        this.suppressFileWatch = false;
        return;
      }
      console.log(`[keymap-sync] Formatter completed in ${fmtMs}ms`);

      // Re-read the formatted file so in-memory state stays current
      this.lastWriteTime = Date.now();
      try {
        const content = fs.readFileSync(this.config.keymapPath, "utf-8");
        this.parsed = parseKeymapFile(content);
      } catch (readErr: any) {
        console.warn(`[keymap-sync] Failed to re-read after format: ${readErr.message}`);
      }
      this.suppressFileWatch = false;
    });
  }

  /** Flush any pending writes immediately (for cleanup). */
  flush(): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
    }
    if (this.fmtTimer) {
      clearTimeout(this.fmtTimer);
    }
    if (this.watchDebounceTimer) {
      clearTimeout(this.watchDebounceTimer);
    }
    this.flushWrite();
    this.stopFileWatch();
  }

  /**
   * Register a callback for file-originated changes.
   * Called when the .keymap file is modified externally and bindings differ.
   */
  setFileChangeCallback(
    cb: (messages: (FileBindingChangedMessage | FileFullResyncMessage)[]) => void
  ): void {
    this.onFileChanged = cb;
  }

  /**
   * Diff two parsed keymaps and return changed bindings.
   * Returns null if layer structure changed (caller should trigger full resync).
   */
  private diffBindings(
    oldParsed: ParsedKeymap,
    newParsed: ParsedKeymap
  ): { layerIndex: number; keyPosition: number; newText: string }[] | null {
    if (oldParsed.layers.length !== newParsed.layers.length) {
      return null; // Layer structure changed
    }

    const diffs: { layerIndex: number; keyPosition: number; newText: string }[] = [];

    for (let li = 0; li < oldParsed.layers.length; li++) {
      const oldLayer = oldParsed.layers[li];
      const newLayer = newParsed.layers[li];

      if (oldLayer.bindings.length !== newLayer.bindings.length) {
        return null; // Binding count changed within a layer
      }

      for (let ki = 0; ki < oldLayer.bindings.length; ki++) {
        if (oldLayer.bindings[ki].text !== newLayer.bindings[ki].text) {
          diffs.push({
            layerIndex: li,
            keyPosition: ki,
            newText: newLayer.bindings[ki].text,
          });
        }
      }
    }

    return diffs;
  }

  /**
   * Convert a text binding (e.g., "&kp A") to numeric BehaviorBindingData.
   * Returns null if the behavior is unknown or params can't be resolved.
   */
  private textToNumeric(bindingText: string): BehaviorBindingData | null {
    const behaviorName = extractBehaviorName(bindingText);
    if (!behaviorName) return null;

    const behaviorId = this.behaviorNameToId.get(behaviorName);
    if (behaviorId === undefined) return null;

    const paramTypes = this.getParamTypes(behaviorId);

    // 0-cell behavior: no params
    if (paramTypes.length === 0) {
      return { behaviorId, param1: 0, param2: 0 };
    }

    // Extract param text: everything after "&behaviorName "
    const paramStr = bindingText.replace(/^&\w+\s*/, "").trim();
    const paramTexts = paramStr ? splitParams(paramStr) : [];

    if (paramTexts.length === 0 && paramTypes.length > 0) {
      // Has param types but no params in text — can't resolve
      return null;
    }

    const { param1, param2 } = unresolveParams(
      behaviorName,
      paramTexts,
      this.tables,
      this.parsed!.allDefines,
      paramTypes
    );

    return { behaviorId, param1, param2 };
  }

  /**
   * Start watching the .keymap file for external changes.
   * When changes are detected, diffs against current state and emits
   * FILE_BINDING_CHANGED messages to connected clients for reverse sync.
   */
  private startFileWatch(): void {
    this.stopFileWatch();

    try {
      this.watcher = fs.watch(this.config.keymapPath, (_eventType) => {
        // Ignore changes triggered by our own writes
        if (this.suppressFileWatch) return;
        if (Date.now() - this.lastWriteTime < 1000) return;

        // Debounce rapid external edits (e.g., formatter, save-on-type)
        if (this.watchDebounceTimer) {
          clearTimeout(this.watchDebounceTimer);
        }
        this.watchDebounceTimer = setTimeout(() => {
          this.handleExternalFileChange();
        }, 200);
      });
    } catch (err: any) {
      console.warn(`[keymap-sync] Could not watch file: ${err.message}`);
    }
  }

  /**
   * Process an external file change: diff, convert, and emit changes.
   */
  private handleExternalFileChange(): void {
    console.log("[keymap-sync] External file change detected, re-reading...");
    try {
      const content = fs.readFileSync(this.config.keymapPath, "utf-8");
      const newParsed = parseKeymapFile(content);
      const oldParsed = this.parsed;

      if (!oldParsed) {
        this.parsed = newParsed;
        console.log("[keymap-sync] File re-read (no prior state to diff).");
        return;
      }

      // Diff bindings
      const diffs = this.diffBindings(oldParsed, newParsed);

      if (diffs === null) {
        // Layer structure changed — emit full resync warning
        console.warn(
          "[keymap-sync] File changed with different layer structure. " +
            "Emitting full resync notification."
        );
        this.parsed = newParsed;

        // Build full resync message with all bindings converted to numeric
        const layers = newParsed.layers.map((layer, li) => ({
          id: li,
          name: layer.name,
          bindings: layer.bindings.map((b) => {
            const numeric = this.textToNumeric(b.text);
            return numeric ?? { behaviorId: 0, param1: 0, param2: 0 };
          }),
        }));

        this.onFileChanged?.([{ type: "FILE_FULL_RESYNC", layers }]);
        return;
      }

      this.parsed = newParsed;

      if (diffs.length === 0) {
        console.log("[keymap-sync] File re-read, no binding changes detected.");
        return;
      }

      // Convert diffs to numeric and emit
      const messages: FileBindingChangedMessage[] = [];
      for (const diff of diffs) {
        const numeric = this.textToNumeric(diff.newText);
        if (numeric) {
          messages.push({
            type: "FILE_BINDING_CHANGED",
            layerIndex: diff.layerIndex,
            keyPosition: diff.keyPosition,
            binding: numeric,
          });
        } else {
          console.warn(
            `[keymap-sync] Could not resolve binding "${diff.newText}" at ` +
              `layer ${diff.layerIndex}, key ${diff.keyPosition} — skipping`
          );
        }
      }

      if (messages.length > 0) {
        console.log(
          `[keymap-sync] External edit: ${messages.length} binding change(s) detected, pushing to Studio`
        );
        this.onFileChanged?.(messages);
      }
    } catch (err: any) {
      console.warn(`[keymap-sync] Failed to re-read file: ${err.message}`);
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
