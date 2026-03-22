import { describe, it, expect } from "vitest";
import * as path from "path";
import {
  buildConstantTables,
  resolveHidValue,
  resolveParams,
  type ConstantTables,
} from "../zmk-constants";

const ZMK_FIRMWARE_PATH = path.resolve(__dirname, "../../../../zmk");

let tables: ConstantTables;

// Build tables once for all tests
tables = buildConstantTables(ZMK_FIRMWARE_PATH);

describe("buildConstantTables", () => {
  it("loads HID key names", () => {
    expect(tables.hidToName.size).toBeGreaterThan(200);
  });

  it("maps basic keys correctly", () => {
    // A = HID_USAGE_KEY (0x07) << 16 | 0x04
    expect(tables.hidToName.get(0x070004)).toBe("A");
    expect(tables.hidToName.get(0x070005)).toBe("B");
    // Space
    expect(tables.hidToName.get(0x07002c)).toBe("SPACE");
  });

  it("maps function keys", () => {
    // F1 = 0x07003a
    expect(tables.hidToName.get(0x07003a)).toBe("F1");
    expect(tables.hidToName.get(0x070043)).toBe("F10");
  });

  it("maps modifier keys", () => {
    // LSHIFT is the shortest alias for 0x0700e1
    expect(tables.hidToName.get(0x0700e1)).toBe("LSHIFT");
    expect(tables.hidToName.get(0x0700e0)).toBe("LCTRL");
  });

  it("maps consumer keys", () => {
    // Consumer page = 0x0C
    // C_VOL_UP, C_VOL_DN, etc.
    const volUp = tables.nameToHid.get("C_VOL_UP");
    expect(volUp).toBeDefined();
    expect(tables.hidToName.get(volUp!)).toBe("C_VOL_UP");
  });

  it("prefers shortest alias", () => {
    // A should be preferred over KEYBOARD_A
    const aValue = tables.nameToHid.get("A");
    expect(aValue).toBeDefined();
    expect(tables.hidToName.get(aValue!)).toBe("A");

    // Both A and longer aliases should resolve to the same value
    const longA = tables.nameToHid.get("KEYBOARD_A");
    if (longA !== undefined) {
      expect(longA).toBe(aValue);
    }
  });

  it("loads behavior constant tables", () => {
    expect(tables.behaviorConstants.has("bt")).toBe(true);
    expect(tables.behaviorConstants.has("rgb_ug")).toBe(true);
    expect(tables.behaviorConstants.has("out")).toBe(true);
    expect(tables.behaviorConstants.has("ext_power")).toBe(true);
    expect(tables.behaviorConstants.has("bl")).toBe(true);
  });

  it("loads mouse button constants", () => {
    expect(tables.mouseButtons.get(1)).toBe("LCLK");
    expect(tables.mouseButtons.get(2)).toBe("RCLK");
    expect(tables.mouseButtons.get(4)).toBe("MCLK");
  });
});

describe("resolveHidValue", () => {
  it("resolves plain key", () => {
    expect(resolveHidValue(0x070004, tables.hidToName)).toBe("A");
  });

  it("resolves modifier-wrapped key: LC(LEFT_ARROW)", () => {
    // LC = 0x01 << 24, LEFT_ARROW = 0x070050
    const value = (0x01 << 24) | 0x070050;
    expect(resolveHidValue(value, tables.hidToName)).toBe("LC(LEFT_ARROW)");
  });

  it("resolves named shifted key directly: LS(NUMBER_8) → STAR", () => {
    const n8Value = tables.nameToHid.get("NUMBER_8");
    expect(n8Value).toBeDefined();
    const value = (0x02 << 24) | n8Value!;
    // LS(NUMBER_8) has a direct define as STAR, so direct match wins
    expect(resolveHidValue(value, tables.hidToName)).toBe("STAR");
  });

  it("resolves multi-modifier: LA(LS(NUMBER_8))", () => {
    const n8Value = tables.nameToHid.get("NUMBER_8");
    expect(n8Value).toBeDefined();
    // LA=0x04, LS=0x02, combined = 0x06
    const value = (0x06 << 24) | n8Value!;
    const result = resolveHidValue(value, tables.hidToName);
    // Should contain both LA and LS wrappers
    expect(result).toContain("LA(");
    expect(result).toContain("LS(");
    expect(result).toContain("NUMBER_8");
  });

  it("resolves named shifted keys directly (e.g., EXCL)", () => {
    // EXCL is LS(N1) but also has a direct #define
    const exclValue = tables.nameToHid.get("EXCL");
    if (exclValue !== undefined) {
      const result = resolveHidValue(exclValue, tables.hidToName);
      expect(result).toBeDefined();
    }
  });

  it("returns null for unknown value", () => {
    expect(resolveHidValue(0xdeadbeef, tables.hidToName)).toBeNull();
  });

  it("returns null for zero without mods", () => {
    expect(resolveHidValue(0, tables.hidToName)).toBeNull();
  });
});

describe("resolveParams", () => {
  const emptyLayerDefines = new Map<number, string>();
  const layerDefines = new Map<number, string>([
    [0, "DEFAULT"],
    [1, "NAV"],
    [2, "SYM"],
    [5, "LOWER"],
    [6, "MAGIC"],
  ]);

  describe("kp behavior (HID keys)", () => {
    it("resolves plain key", () => {
      const result = resolveParams("kp", 0x070004, 0, tables, emptyLayerDefines, ["hidUsage"]);
      expect(result).toEqual(["A"]);
    });

    it("resolves modifier-wrapped key", () => {
      const value = (0x01 << 24) | 0x070050; // LC(LEFT_ARROW)
      const result = resolveParams("kp", value, 0, tables, emptyLayerDefines, ["hidUsage"]);
      expect(result).toEqual(["LC(LEFT_ARROW)"]);
    });

    it("falls back to hex for unknown HID value", () => {
      const result = resolveParams("kp", 0xdeadbeef, 0, tables, emptyLayerDefines, ["hidUsage"]);
      expect(result[0]).toMatch(/0x/i);
    });
  });

  describe("mo behavior (layer ID)", () => {
    it("resolves layer name from defines", () => {
      const result = resolveParams("mo", 1, 0, tables, layerDefines, ["layerId"]);
      expect(result).toEqual(["NAV"]);
    });

    it("falls back to numeric for unknown layer", () => {
      const result = resolveParams("mo", 99, 0, tables, layerDefines, ["layerId"]);
      expect(result).toEqual(["99"]);
    });
  });

  describe("lt behavior (layer + key)", () => {
    it("resolves layer and key", () => {
      const result = resolveParams("lt", 1, 0x07002c, tables, layerDefines, [
        "layerId",
        "hidUsage",
      ]);
      expect(result).toEqual(["NAV", "SPACE"]);
    });
  });

  describe("mt behavior (modifier + key)", () => {
    it("resolves modifier and key", () => {
      const lshft = tables.nameToHid.get("LSHIFT")!;
      const aKey = 0x070004;
      const result = resolveParams("mt", lshft, aKey, tables, emptyLayerDefines, [
        "hidUsage",
        "hidUsage",
      ]);
      expect(result).toEqual(["LSHIFT", "A"]);
    });
  });

  describe("bt behavior (bluetooth)", () => {
    it("resolves BT_CLR (no param2)", () => {
      const result = resolveParams("bt", 0, 0, tables, emptyLayerDefines, [
        "constant",
        "constant",
      ]);
      expect(result).toEqual(["BT_CLR"]);
    });

    it("resolves BT_SEL with profile number", () => {
      const result = resolveParams("bt", 3, 2, tables, emptyLayerDefines, [
        "constant",
        "constant",
      ]);
      expect(result).toEqual(["BT_SEL", "2"]);
    });

    it("resolves BT_NXT", () => {
      const result = resolveParams("bt", 1, 0, tables, emptyLayerDefines, [
        "constant",
        "constant",
      ]);
      expect(result).toEqual(["BT_NXT"]);
    });

    it("resolves BT_DISC with profile number", () => {
      const result = resolveParams("bt", 5, 1, tables, emptyLayerDefines, [
        "constant",
        "constant",
      ]);
      expect(result).toEqual(["BT_DISC", "1"]);
    });
  });

  describe("rgb_ug behavior", () => {
    it("resolves RGB_TOG", () => {
      const result = resolveParams("rgb_ug", 0, 0, tables, emptyLayerDefines, [
        "constant",
        "constant",
      ]);
      expect(result).toEqual(["RGB_TOG"]);
    });

    it("resolves RGB_BRI", () => {
      const result = resolveParams("rgb_ug", 7, 0, tables, emptyLayerDefines, [
        "constant",
        "constant",
      ]);
      expect(result).toEqual(["RGB_BRI"]);
    });

    it("resolves RGB_COLOR_HSB with decoded H,S,B", () => {
      // Encode HSB: h=180, s=100, b=50 → (180 << 16) + (100 << 8) + 50
      const param2 = (180 << 16) + (100 << 8) + 50;
      const result = resolveParams("rgb_ug", 14, param2, tables, emptyLayerDefines, [
        "constant",
        "constant",
      ]);
      expect(result).toEqual(["RGB_COLOR_HSB(180,100,50)"]);
    });

    it("resolves RGB_STATUS", () => {
      const result = resolveParams("rgb_ug", 15, 0, tables, emptyLayerDefines, [
        "constant",
        "constant",
      ]);
      expect(result).toEqual(["RGB_STATUS"]);
    });
  });

  describe("out behavior", () => {
    it("resolves OUT_USB", () => {
      const result = resolveParams("out", 1, 0, tables, emptyLayerDefines, ["constant"]);
      expect(result).toEqual(["OUT_USB"]);
    });

    it("resolves OUT_BLE", () => {
      const result = resolveParams("out", 2, 0, tables, emptyLayerDefines, ["constant"]);
      expect(result).toEqual(["OUT_BLE"]);
    });
  });

  describe("ext_power behavior", () => {
    it("resolves EP_TOG", () => {
      const result = resolveParams("ext_power", 2, 0, tables, emptyLayerDefines, ["constant"]);
      expect(result).toEqual(["EP_TOG"]);
    });
  });

  describe("bl behavior", () => {
    it("resolves BL_TOG", () => {
      const result = resolveParams("bl", 2, 0, tables, emptyLayerDefines, [
        "constant",
        "constant",
      ]);
      expect(result).toEqual(["BL_TOG"]);
    });

    it("resolves BL_SET with brightness", () => {
      const result = resolveParams("bl", 6, 128, tables, emptyLayerDefines, [
        "constant",
        "constant",
      ]);
      expect(result).toEqual(["BL_SET", "128"]);
    });
  });

  describe("mkp behavior (mouse)", () => {
    it("resolves LCLK", () => {
      const result = resolveParams("mkp", 1, 0, tables, emptyLayerDefines, ["constant"]);
      expect(result).toEqual(["LCLK"]);
    });

    it("resolves RCLK", () => {
      const result = resolveParams("mkp", 2, 0, tables, emptyLayerDefines, ["constant"]);
      expect(result).toEqual(["RCLK"]);
    });
  });

  describe("0-param behaviors", () => {
    it("returns empty for no param types", () => {
      const result = resolveParams("trans", 0, 0, tables, emptyLayerDefines, []);
      expect(result).toEqual([]);
    });

    it("returns empty for none behavior", () => {
      const result = resolveParams("none", 0, 0, tables, emptyLayerDefines, []);
      expect(result).toEqual([]);
    });
  });
});
