import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { parseKeymapFile, replaceBinding } from "../keymap-parser";

const KEYMAP_PATH = path.resolve(__dirname, "../../../../config/glove80.keymap");

function loadKeymap() {
  return fs.readFileSync(KEYMAP_PATH, "utf-8");
}

describe("parseKeymapFile", () => {
  it("parses the actual glove80.keymap file", () => {
    const text = loadKeymap();
    const parsed = parseKeymapFile(text);

    expect(parsed.layers.length).toBe(8);
    expect(parsed.rawText).toBe(text);
  });

  it("extracts #define layer constants", () => {
    const text = loadKeymap();
    const parsed = parseKeymapFile(text);

    expect(parsed.allDefines.get("DEFAULT")).toBe(0);
    expect(parsed.allDefines.get("NAV")).toBe(1);
    expect(parsed.allDefines.get("SYM")).toBe(2);
    expect(parsed.allDefines.get("SYM2")).toBe(3);
    expect(parsed.allDefines.get("SYM3")).toBe(4);
    expect(parsed.allDefines.get("LOWER")).toBe(5);
    expect(parsed.allDefines.get("MAGIC")).toBe(6);
    expect(parsed.allDefines.get("FACTORY_TEST")).toBe(7);
  });

  it("builds layerDefines reverse map", () => {
    const text = loadKeymap();
    const parsed = parseKeymapFile(text);

    expect(parsed.layerDefines.get(0)).toBe("DEFAULT");
    expect(parsed.layerDefines.get(1)).toBe("NAV");
    expect(parsed.layerDefines.get(6)).toBe("MAGIC");
  });

  it("extracts correct layer names", () => {
    const text = loadKeymap();
    const parsed = parseKeymapFile(text);

    const layerNames = parsed.layers.map((l) => l.name);
    expect(layerNames).toEqual([
      "default_layer",
      "nav_layer",
      "sym_layer",
      "sym2_layer",
      "sym3_layer",
      "lower_layer",
      "magic_layer",
      "factory_test_layer",
    ]);
  });

  it("parses correct binding count for default layer (80 keys)", () => {
    const text = loadKeymap();
    const parsed = parseKeymapFile(text);

    // Glove80 has 80 keys
    expect(parsed.layers[0].bindings.length).toBe(80);
  });

  it("parses correct binding count for all layers", () => {
    const text = loadKeymap();
    const parsed = parseKeymapFile(text);

    for (const layer of parsed.layers) {
      expect(layer.bindings.length).toBe(80);
    }
  });

  it("extracts binding text correctly", () => {
    const text = loadKeymap();
    const parsed = parseKeymapFile(text);

    // First binding in default layer should be &kp F1
    expect(parsed.layers[0].bindings[0].text).toBe("&kp F1");
    // Last binding in default layer
    expect(parsed.layers[0].bindings[79].text).toBe("&kp PG_DN");
  });

  it("captures correct offsets for bindings", () => {
    const text = loadKeymap();
    const parsed = parseKeymapFile(text);

    // Verify that extracted text at offsets matches binding text
    for (const layer of parsed.layers) {
      for (const binding of layer.bindings) {
        const extracted = text.substring(binding.start, binding.end);
        expect(extracted).toBe(binding.text);
      }
    }
  });

  it("handles multi-param bindings", () => {
    const text = loadKeymap();
    const parsed = parseKeymapFile(text);

    // Find &lt NAV SPACE in default layer (should be in thumb cluster)
    const ltBinding = parsed.layers[0].bindings.find((b) =>
      b.text.startsWith("&lt NAV")
    );
    expect(ltBinding).toBeDefined();
    expect(ltBinding!.text).toBe("&lt NAV SPACE");

    // Find &lt SYM SPACE
    const symBinding = parsed.layers[0].bindings.find((b) =>
      b.text.startsWith("&lt SYM")
    );
    expect(symBinding).toBeDefined();
    expect(symBinding!.text).toBe("&lt SYM SPACE");
  });

  it("handles &trans bindings", () => {
    const text = loadKeymap();
    const parsed = parseKeymapFile(text);

    // nav_layer (index 1) should have many &trans bindings
    const transCount = parsed.layers[1].bindings.filter(
      (b) => b.text === "&trans"
    ).length;
    expect(transCount).toBeGreaterThan(50);
  });

  it("parses a minimal keymap", () => {
    const minimal = `
#define DEFAULT 0
#define NAV 1

/ {
    keymap {
        compatible = "zmk,keymap";

        default_layer {
            bindings = <
            &kp A &kp B
            >;
        };

        nav_layer {
            bindings = <
            &trans &mo NAV
            >;
        };
    };
};
`;
    const parsed = parseKeymapFile(minimal);
    expect(parsed.layers.length).toBe(2);
    expect(parsed.layers[0].bindings.length).toBe(2);
    expect(parsed.layers[0].bindings[0].text).toBe("&kp A");
    expect(parsed.layers[0].bindings[1].text).toBe("&kp B");
    expect(parsed.layers[1].bindings[0].text).toBe("&trans");
    expect(parsed.layers[1].bindings[1].text).toBe("&mo NAV");
  });
});

describe("replaceBinding", () => {
  it("replaces a binding and returns updated text", () => {
    const minimal = `
/ {
    keymap {
        compatible = "zmk,keymap";
        layer0 {
            bindings = <
            &kp A &kp B &kp C
            >;
        };
    };
};
`;
    const parsed = parseKeymapFile(minimal);
    const newText = replaceBinding(parsed, 0, 1, "&kp X");

    // Verify the replacement happened
    expect(newText).toContain("&kp X");
    expect(newText).not.toContain("&kp B");
    // Other bindings preserved
    expect(newText).toContain("&kp A");
    expect(newText).toContain("&kp C");
  });

  it("adjusts offsets for subsequent bindings", () => {
    const minimal = `
/ {
    keymap {
        compatible = "zmk,keymap";
        layer0 {
            bindings = <
            &kp A &kp B &kp C
            >;
        };
    };
};
`;
    const parsed = parseKeymapFile(minimal);

    // Replace with a longer string
    const newText = replaceBinding(parsed, 0, 0, "&kp LONG_NAME");

    // Verify offset adjustment — binding[1] and binding[2] should still be extractable
    const b1 = parsed.layers[0].bindings[1];
    expect(newText.substring(b1.start, b1.end)).toBe("&kp B");

    const b2 = parsed.layers[0].bindings[2];
    expect(newText.substring(b2.start, b2.end)).toBe("&kp C");
  });

  it("adjusts offsets for subsequent layers", () => {
    const text = `
#define DEFAULT 0
#define NAV 1

/ {
    keymap {
        compatible = "zmk,keymap";
        layer0 {
            bindings = <
            &kp A &kp B
            >;
        };
        layer1 {
            bindings = <
            &kp C &kp D
            >;
        };
    };
};
`;
    const parsed = parseKeymapFile(text);

    // Replace in layer 0 with longer text
    const newText = replaceBinding(parsed, 0, 0, "&kp VERY_LONG_KEY_NAME");

    // layer1 bindings should still be extractable at adjusted offsets
    const c = parsed.layers[1].bindings[0];
    expect(newText.substring(c.start, c.end)).toBe("&kp C");

    const d = parsed.layers[1].bindings[1];
    expect(newText.substring(d.start, d.end)).toBe("&kp D");
  });

  it("handles replacement with shorter text", () => {
    const text = `
/ {
    keymap {
        compatible = "zmk,keymap";
        layer0 {
            bindings = <
            &kp VERY_LONG_KEY &kp B
            >;
        };
    };
};
`;
    const parsed = parseKeymapFile(text);
    const newText = replaceBinding(parsed, 0, 0, "&kp A");

    expect(newText).toContain("&kp A");
    const b = parsed.layers[0].bindings[1];
    expect(newText.substring(b.start, b.end)).toBe("&kp B");
  });

  it("throws on invalid layer index", () => {
    const parsed = parseKeymapFile(`
/ { keymap { compatible = "zmk,keymap"; l { bindings = < &kp A >; }; }; };
`);
    expect(() => replaceBinding(parsed, 5, 0, "&kp B")).toThrow(
      "Layer index 5 out of range"
    );
  });

  it("throws on invalid binding index", () => {
    const parsed = parseKeymapFile(`
/ { keymap { compatible = "zmk,keymap"; l { bindings = < &kp A >; }; }; };
`);
    expect(() => replaceBinding(parsed, 0, 5, "&kp B")).toThrow(
      "Binding index 5 out of range"
    );
  });
});
