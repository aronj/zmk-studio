/**
 * Parses ZMK firmware header files to build reverse-lookup tables
 * for converting numeric param values back to ZMK keycode names.
 *
 * Reads from: zmk/zmk/app/include/dt-bindings/zmk/
 *   - hid_usage_pages.h  (page constants: HID_USAGE_KEY=0x07, etc.)
 *   - hid_usage.h        (usage IDs: HID_USAGE_KEY_KEYBOARD_A=0x04, etc.)
 *   - keys.h             (friendly names: A, SPACE, LSHFT, C_VOL_UP, etc.)
 *   - modifiers.h        (modifier encoding: LC, LS, LA, LG, etc.)
 *   - bt.h, rgb.h, outputs.h, ext_power.h, backlight.h, pointing.h
 */

import * as fs from "fs";
import * as path from "path";

const HEADERS_DIR = "dt-bindings/zmk";

/** Modifier bit → wrapper macro name */
const MOD_BITS: [number, string][] = [
  [0x01, "LC"],
  [0x02, "LS"],
  [0x04, "LA"],
  [0x08, "LG"],
  [0x10, "RC"],
  [0x20, "RS"],
  [0x40, "RA"],
  [0x80, "RG"],
];

export interface ConstantTables {
  /** HID usage code → shortest ZMK key name (e.g., 0x70004 → "A") */
  hidToName: Map<number, string>;
  /** ZMK key name → HID usage code (e.g., "A" → 0x70004) */
  nameToHid: Map<string, number>;
  /** Behavior-specific constant tables, keyed by behavior name */
  behaviorConstants: Map<string, BehaviorConstantTable>;
  /** Mouse button constants */
  mouseButtons: Map<number, string>;
}

export interface BehaviorConstantTable {
  /**
   * Maps (param1, param2) → display text.
   * For commands like BT_CLR where param2 is always 0, the key is `${param1},${param2}`.
   * For commands like BT_SEL where param2 is variable, only param1 is mapped
   * and param2 is appended as a number.
   */
  param1ToName: Map<number, string>;
  /** param1 values where param2 is a user-provided argument (not fixed to 0) */
  param2IsArg: Set<number>;
}

/**
 * Parse a C header file and extract all `#define NAME (0xNN)` or `#define NAME value` entries.
 */
function parseSimpleDefines(content: string): Map<string, number> {
  const defs = new Map<string, number>();
  const re = /^#define\s+(\w+)\s+\(?(?:0x([0-9A-Fa-f]+)|(\d+))\)?/gm;
  let m;
  while ((m = re.exec(content)) !== null) {
    const name = m[1];
    const val = m[2] ? parseInt(m[2], 16) : parseInt(m[3], 10);
    defs.set(name, val);
  }
  return defs;
}

/**
 * Parse keys.h to extract all keycode definitions.
 * Handles three patterns:
 *   1. `#define NAME (ZMK_HID_USAGE(PAGE_REF, USAGE_REF))`
 *   2. `#define NAME (LS(ZMK_HID_USAGE(PAGE_REF, USAGE_REF)))` (modifier-wrapped)
 *   3. `#define ALIAS (PRIMARY_NAME)` (alias)
 */
function parseKeysH(
  content: string,
  pages: Map<string, number>,
  usages: Map<string, number>
): Map<number, string[]> {
  const valueToNames = new Map<number, string[]>();

  const addEntry = (value: number, name: string) => {
    const existing = valueToNames.get(value);
    if (existing) {
      existing.push(name);
    } else {
      valueToNames.set(value, [name]);
    }
  };

  // Track name → value for resolving aliases
  const nameToValue = new Map<string, number>();

  // Pattern 1: ZMK_HID_USAGE(PAGE, USAGE)
  const reHid =
    /^#define\s+(\w+)\s+\(ZMK_HID_USAGE\((\w+),\s*(\w+)\)\)/gm;
  let m;
  while ((m = reHid.exec(content)) !== null) {
    const [, name, pageRef, usageRef] = m;
    const page = pages.get(pageRef);
    const usage = usages.get(usageRef);
    if (page !== undefined && usage !== undefined) {
      const value = (page << 16) | usage;
      addEntry(value, name);
      nameToValue.set(name, value);
    }
  }

  // Pattern 2: Modifier-wrapped: LS(ZMK_HID_USAGE(...))
  const reMod =
    /^#define\s+(\w+)\s+\((LC|LS|LA|LG|RC|RS|RA|RG)\(ZMK_HID_USAGE\((\w+),\s*(\w+)\)\)\)/gm;
  while ((m = reMod.exec(content)) !== null) {
    const [, name, modName, pageRef, usageRef] = m;
    const page = pages.get(pageRef);
    const usage = usages.get(usageRef);
    const modBit = MOD_BITS.find(([, n]) => n === modName)?.[0];
    if (page !== undefined && usage !== undefined && modBit !== undefined) {
      const value = (modBit << 24) | (page << 16) | usage;
      addEntry(value, name);
      nameToValue.set(name, value);
    }
  }

  // Pattern 3: Aliases: `#define ALIAS (PRIMARY)`
  // Must run after primary definitions are resolved
  const reAlias = /^#define\s+(\w+)\s+\((\w+)\)/gm;
  while ((m = reAlias.exec(content)) !== null) {
    const [, alias, target] = m;
    // Skip if we already parsed this as a HID or mod pattern
    if (nameToValue.has(alias)) continue;
    // Skip deprecated aliases
    if (content.substring(m.index, m.index + m[0].length + 50).includes("DEPRECATED")) continue;

    const targetValue = nameToValue.get(target);
    if (targetValue !== undefined) {
      addEntry(targetValue, alias);
      nameToValue.set(alias, targetValue);
    }
  }

  return valueToNames;
}

/**
 * From multiple names for the same value, pick the shortest non-deprecated one.
 */
function pickPreferredName(names: string[]): string {
  return names.reduce((best, name) => (name.length < best.length ? name : best));
}

/**
 * Build behavior-specific constant table from a header file.
 */
function buildBehaviorTable(
  entries: { name: string; param1: number; param2IsArg: boolean }[]
): BehaviorConstantTable {
  const param1ToName = new Map<number, string>();
  const param2IsArg = new Set<number>();

  for (const entry of entries) {
    param1ToName.set(entry.param1, entry.name);
    if (entry.param2IsArg) {
      param2IsArg.add(entry.param1);
    }
  }

  return { param1ToName, param2IsArg };
}

/**
 * Resolve a numeric HID value (possibly with modifiers) to a ZMK key name string.
 * E.g., 0x70004 → "A", 0x0107004F → "LC(RIGHT)"
 */
export function resolveHidValue(
  value: number,
  hidToName: Map<number, string>
): string | null {
  // Check for direct match first (handles named shifted keys like EXCL, UNDER, etc.)
  const direct = hidToName.get(value);
  if (direct) return direct;

  // Extract modifier bits
  const mods = (value >>> 24) & 0xff;
  if (mods === 0) return null;

  // Resolve base key without modifiers
  const baseValue = value & 0x00ffffff;
  const baseName = hidToName.get(baseValue);
  if (!baseName) return null;

  // Build nested modifier wrappers
  let result = baseName;
  // Apply modifiers from right to left (innermost first)
  for (const [bit, wrapper] of MOD_BITS) {
    if (mods & bit) {
      result = `${wrapper}(${result})`;
    }
  }
  return result;
}

/**
 * Build all constant lookup tables from ZMK firmware headers.
 * @param zmkFirmwarePath Path to ZMK firmware root (containing app/include/)
 */
export function buildConstantTables(zmkFirmwarePath: string): ConstantTables {
  const includeDir = path.join(zmkFirmwarePath, "app", "include", HEADERS_DIR);

  const readHeader = (name: string) =>
    fs.readFileSync(path.join(includeDir, name), "utf-8");

  // 1. Parse page constants
  const pagesContent = readHeader("hid_usage_pages.h");
  const pages = parseSimpleDefines(pagesContent);

  // 2. Parse usage ID constants
  const usagesContent = readHeader("hid_usage.h");
  const usages = parseSimpleDefines(usagesContent);

  // 3. Parse keys.h → value → names[]
  const keysContent = readHeader("keys.h");
  const valueToNames = parseKeysH(keysContent, pages, usages);

  // 4. Build hidToName with preferred (shortest) names
  const hidToName = new Map<number, string>();
  const nameToHid = new Map<string, number>();
  for (const [value, names] of valueToNames) {
    const preferred = pickPreferredName(names);
    hidToName.set(value, preferred);
    for (const name of names) {
      nameToHid.set(name, value);
    }
  }

  // 5. Build behavior-specific constant tables

  // Bluetooth
  const btTable = buildBehaviorTable([
    { name: "BT_CLR", param1: 0, param2IsArg: false },
    { name: "BT_NXT", param1: 1, param2IsArg: false },
    { name: "BT_PRV", param1: 2, param2IsArg: false },
    { name: "BT_SEL", param1: 3, param2IsArg: true },
    { name: "BT_CLR_ALL", param1: 4, param2IsArg: false },
    { name: "BT_DISC", param1: 5, param2IsArg: true },
  ]);

  // RGB underglow
  const rgbTable = buildBehaviorTable([
    { name: "RGB_TOG", param1: 0, param2IsArg: false },
    { name: "RGB_ON", param1: 1, param2IsArg: false },
    { name: "RGB_OFF", param1: 2, param2IsArg: false },
    { name: "RGB_HUI", param1: 3, param2IsArg: false },
    { name: "RGB_HUD", param1: 4, param2IsArg: false },
    { name: "RGB_SAI", param1: 5, param2IsArg: false },
    { name: "RGB_SAD", param1: 6, param2IsArg: false },
    { name: "RGB_BRI", param1: 7, param2IsArg: false },
    { name: "RGB_BRD", param1: 8, param2IsArg: false },
    { name: "RGB_SPI", param1: 9, param2IsArg: false },
    { name: "RGB_SPD", param1: 10, param2IsArg: false },
    { name: "RGB_EFF", param1: 11, param2IsArg: false },
    { name: "RGB_EFR", param1: 12, param2IsArg: false },
    { name: "RGB_EFS", param1: 13, param2IsArg: false },
    { name: "RGB_COLOR_HSB", param1: 14, param2IsArg: true },
    { name: "RGB_STATUS", param1: 15, param2IsArg: false },
  ]);

  // Outputs
  const outTable = buildBehaviorTable([
    { name: "OUT_TOG", param1: 0, param2IsArg: false },
    { name: "OUT_USB", param1: 1, param2IsArg: false },
    { name: "OUT_BLE", param1: 2, param2IsArg: false },
  ]);

  // External power
  const extPowerTable = buildBehaviorTable([
    { name: "EP_OFF", param1: 0, param2IsArg: false },
    { name: "EP_ON", param1: 1, param2IsArg: false },
    { name: "EP_TOG", param1: 2, param2IsArg: false },
  ]);

  // Backlight
  const blTable = buildBehaviorTable([
    { name: "BL_ON", param1: 0, param2IsArg: false },
    { name: "BL_OFF", param1: 1, param2IsArg: false },
    { name: "BL_TOG", param1: 2, param2IsArg: false },
    { name: "BL_INC", param1: 3, param2IsArg: false },
    { name: "BL_DEC", param1: 4, param2IsArg: false },
    { name: "BL_CYCLE", param1: 5, param2IsArg: false },
    { name: "BL_SET", param1: 6, param2IsArg: true },
  ]);

  const behaviorConstants = new Map<string, BehaviorConstantTable>();
  behaviorConstants.set("bt", btTable);
  behaviorConstants.set("rgb_ug", rgbTable);
  behaviorConstants.set("out", outTable);
  behaviorConstants.set("ext_power", extPowerTable);
  behaviorConstants.set("bl", blTable);

  // 6. Mouse button constants
  const mouseButtons = new Map<number, string>();
  mouseButtons.set(1, "LCLK");    // BIT(0)
  mouseButtons.set(2, "RCLK");    // BIT(1)
  mouseButtons.set(4, "MCLK");    // BIT(2)
  mouseButtons.set(8, "MB4");     // BIT(3)
  mouseButtons.set(16, "MB5");    // BIT(4)

  return { hidToName, nameToHid, behaviorConstants, mouseButtons };
}

/**
 * Resolve a behavior's parameters to text representation.
 *
 * @param behaviorName The behavior short name (e.g., "kp", "bt", "mo")
 * @param param1 First parameter value
 * @param param2 Second parameter value
 * @param tables Constant lookup tables
 * @param layerDefines Map of layer ID → layer name from #defines
 * @param paramTypes Parameter type descriptors from behavior metadata
 */
export function resolveParams(
  behaviorName: string,
  param1: number,
  param2: number,
  tables: ConstantTables,
  layerDefines: Map<number, string>,
  paramTypes: string[]
): string[] {
  const params: string[] = [];

  // Check for behavior-specific constant table first
  const behaviorTable = tables.behaviorConstants.get(behaviorName);
  if (behaviorTable) {
    const cmdName = behaviorTable.param1ToName.get(param1);
    if (cmdName) {
      if (behaviorTable.param2IsArg.has(param1)) {
        // Command takes an argument: "BT_SEL 0"
        params.push(cmdName, String(param2));
      } else {
        // Command with no variable arg: "BT_CLR" (param2 is baked into the macro)
        params.push(cmdName);
      }
      return params;
    }
  }

  // Handle each param based on type
  for (let i = 0; i < paramTypes.length; i++) {
    const pType = paramTypes[i];
    const value = i === 0 ? param1 : param2;

    if (pType === "nil") continue;

    if (pType === "hidUsage") {
      const name = resolveHidValue(value, tables.hidToName);
      params.push(name ?? `0x${value.toString(16).toUpperCase()}`);
    } else if (pType === "layerId") {
      const name = layerDefines.get(value);
      params.push(name ?? String(value));
    } else if (pType === "constant") {
      // Mouse buttons
      if (behaviorName === "mkp") {
        const btn = tables.mouseButtons.get(value);
        params.push(btn ?? String(value));
      } else {
        params.push(String(value));
      }
    } else {
      params.push(String(value));
    }
  }

  return params;
}
