/**
 * Parses a .keymap devicetree file to extract layer bindings and #define constants.
 * Only touches the bindings blocks — all other content is preserved as-is.
 */

export interface ParsedBinding {
  /** Full text of the binding, e.g. "&kp F1" or "&lt NAV SPACE" */
  text: string;
  /** Character offset of this binding within the full file text */
  start: number;
  /** Character offset of the end of this binding */
  end: number;
}

export interface ParsedLayer {
  /** Layer block name from devicetree, e.g. "default_layer", "nav_layer" */
  name: string;
  /** Start offset of the `bindings = <` content (after the `<`) */
  bindingsStart: number;
  /** End offset of the bindings content (before the `>`) */
  bindingsEnd: number;
  /** Individual bindings parsed from the block */
  bindings: ParsedBinding[];
}

export interface ParsedKeymap {
  /** The full raw text of the .keymap file */
  rawText: string;
  /** #define layer constants: value → name (e.g., 1 → "NAV") */
  layerDefines: Map<number, string>;
  /** All #define constants: name → value (e.g., "NAV" → 1) */
  allDefines: Map<string, number>;
  /** Parsed layers in order */
  layers: ParsedLayer[];
}

/**
 * Parse #define constants from the file.
 * Matches patterns like: `#define NAV 1`, `#define LOWER 5`
 * Skips defines with parentheses (those are macro/function-like).
 */
function parseDefines(text: string): { byValue: Map<number, string>; byName: Map<string, number> } {
  const byValue = new Map<number, string>();
  const byName = new Map<string, number>();
  const re = /^#define\s+(\w+)\s+(\d+)\s*$/gm;
  let m;
  while ((m = re.exec(text)) !== null) {
    const name = m[1];
    const value = parseInt(m[2], 10);
    byName.set(name, value);
    // For byValue, prefer the first (usually shortest/most specific) name
    if (!byValue.has(value)) {
      byValue.set(value, name);
    }
  }
  return { byValue, byName };
}

/**
 * Find the keymap { ... } block in the devicetree text.
 * Returns the start and end offsets of the keymap block content.
 */
function findKeymapBlock(text: string): { start: number; end: number } | null {
  // Find `keymap {` with `compatible = "zmk,keymap"`
  const keymapRe = /keymap\s*\{/g;
  let m;
  while ((m = keymapRe.exec(text)) !== null) {
    const blockStart = m.index + m[0].length;
    // Check if this block contains the zmk,keymap compatible
    const snippet = text.substring(blockStart, blockStart + 200);
    if (snippet.includes("zmk,keymap")) {
      // Find matching closing brace
      let depth = 1;
      let i = blockStart;
      while (i < text.length && depth > 0) {
        if (text[i] === "{") depth++;
        else if (text[i] === "}") depth--;
        i++;
      }
      return { start: blockStart, end: i - 1 };
    }
  }
  return null;
}

/**
 * Parse bindings from a `bindings = < ... >;` block.
 * Each binding starts with `&` and extends until the next `&` or `>`.
 */
function parseBindingsBlock(
  text: string,
  blockStart: number
): ParsedBinding[] {
  const bindings: ParsedBinding[] = [];
  const content = text;
  let i = 0;

  while (i < content.length) {
    // Find next `&`
    const ampIdx = content.indexOf("&", i);
    if (ampIdx === -1) break;

    // Find the end of this binding: next `&` or `>`
    let endIdx = content.length;
    for (let j = ampIdx + 1; j < content.length; j++) {
      if (content[j] === "&" || content[j] === ">") {
        endIdx = j;
        break;
      }
    }

    // Extract and trim the binding text
    const rawBinding = content.substring(ampIdx, endIdx).trim();
    if (rawBinding.length > 0) {
      bindings.push({
        text: rawBinding,
        start: blockStart + ampIdx,
        end: blockStart + ampIdx + rawBinding.length,
      });
    }

    i = endIdx;
  }

  return bindings;
}

/**
 * Find all layer blocks within the keymap section and extract their bindings.
 */
function parseLayers(text: string, keymapStart: number, keymapEnd: number): ParsedLayer[] {
  const layers: ParsedLayer[] = [];
  const keymapText = text.substring(keymapStart, keymapEnd);

  // Find each top-level block in the keymap section
  let pos = 0;
  while (pos < keymapText.length) {
    // Find next block: `name {`
    const blockRe = /(\w+)\s*\{/g;
    blockRe.lastIndex = pos;
    const blockMatch = blockRe.exec(keymapText);
    if (!blockMatch) break;

    const layerName = blockMatch[1];
    const blockContentStart = blockMatch.index + blockMatch[0].length;

    // Skip the "compatible" line if this is not a layer
    if (layerName === "compatible") {
      pos = blockContentStart;
      continue;
    }

    // Find matching closing brace
    let depth = 1;
    let blockEnd = blockContentStart;
    while (blockEnd < keymapText.length && depth > 0) {
      if (keymapText[blockEnd] === "{") depth++;
      else if (keymapText[blockEnd] === "}") depth--;
      blockEnd++;
    }

    // Look for `bindings = <` within this block
    const blockContent = keymapText.substring(blockContentStart, blockEnd - 1);
    const bindingsMatch = blockContent.match(/bindings\s*=\s*</);
    if (bindingsMatch && bindingsMatch.index !== undefined) {
      const bindingsContentStart = bindingsMatch.index + bindingsMatch[0].length;
      const closingAngle = blockContent.indexOf(">;", bindingsContentStart);
      if (closingAngle !== -1) {
        const bindingsText = blockContent.substring(bindingsContentStart, closingAngle);
        const absoluteStart = keymapStart + blockContentStart + bindingsContentStart;

        const bindings = parseBindingsBlock(bindingsText, absoluteStart);

        layers.push({
          name: layerName,
          bindingsStart: absoluteStart,
          bindingsEnd: keymapStart + blockContentStart + closingAngle,
          bindings,
        });
      }
    }

    pos = blockEnd;
  }

  return layers;
}

/**
 * Parse a .keymap file into a structured representation.
 * Extracts #define constants and layer bindings while preserving all other content.
 */
export function parseKeymapFile(text: string): ParsedKeymap {
  const defines = parseDefines(text);
  const keymapBlock = findKeymapBlock(text);

  if (!keymapBlock) {
    throw new Error("Could not find keymap block in .keymap file");
  }

  const layers = parseLayers(text, keymapBlock.start, keymapBlock.end);

  return {
    rawText: text,
    layerDefines: defines.byValue,
    allDefines: defines.byName,
    layers,
  };
}

/**
 * Replace a single binding in the raw text, returning the updated text.
 * Adjusts all subsequent offsets in the parsed keymap.
 */
export function replaceBinding(
  parsed: ParsedKeymap,
  layerIndex: number,
  bindingIndex: number,
  newText: string
): string {
  const layer = parsed.layers[layerIndex];
  if (!layer) throw new Error(`Layer index ${layerIndex} out of range`);

  const binding = layer.bindings[bindingIndex];
  if (!binding) throw new Error(`Binding index ${bindingIndex} out of range in layer ${layerIndex}`);

  const before = parsed.rawText.substring(0, binding.start);
  const after = parsed.rawText.substring(binding.end);
  const newRawText = before + newText + after;

  // Calculate offset delta for adjusting subsequent positions
  const delta = newText.length - (binding.end - binding.start);

  // Update the parsed representation in place
  binding.text = newText;
  binding.end = binding.start + newText.length;

  // Adjust offsets for all subsequent bindings in this layer
  for (let i = bindingIndex + 1; i < layer.bindings.length; i++) {
    layer.bindings[i].start += delta;
    layer.bindings[i].end += delta;
  }
  layer.bindingsEnd += delta;

  // Adjust offsets for all subsequent layers
  for (let li = layerIndex + 1; li < parsed.layers.length; li++) {
    const l = parsed.layers[li];
    l.bindingsStart += delta;
    l.bindingsEnd += delta;
    for (const b of l.bindings) {
      b.start += delta;
      b.end += delta;
    }
  }

  parsed.rawText = newRawText;
  return newRawText;
}
