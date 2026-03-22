# ZMK Keymap Sync — Reference

## ZMK Behavior Inventory (27 behaviors)

### 0-Parameter Behaviors
| Binding | Description | Notes |
|---------|-------------|-------|
| `&none` | Disable key | |
| `&trans` | Pass to lower layer | |
| `&key_repeat` | Repeat last key | |
| `&caps_word` | Caps until non-continue key | |
| `&sys_reset` | System reset | |
| `&bootloader` | Bootloader mode | |
| `&soft_off` | Power down | |
| `&studio_unlock` | Unlock ZMK Studio | |
| Custom macros | e.g. `&layer_td`, `&rgb_ug_status_macro` | Defined in .keymap behaviors/macros section |
| Custom mod-morph | e.g. `&gresc` | Defined in .keymap behaviors section |
| Custom tap-dance | e.g. `&layer_td` | Defined in .keymap behaviors section |

### 1-Parameter Behaviors
| Binding | Param type | Example | Notes |
|---------|-----------|---------|-------|
| `&kp` | HID keycode | `&kp A`, `&kp LC(LEFT)` | keys.h + modifiers.h |
| `&mo` | Layer ID | `&mo NAV` | #define constants |
| `&to` | Layer ID | `&to DEFAULT` | |
| `&tog` | Layer ID | `&tog 1` | |
| `&sk` | HID keycode | `&sk LSHFT` | Sticky key |
| `&sl` | Layer ID | `&sl 1` | Sticky layer |
| `&kt` | HID keycode | `&kt CAPS` | Key toggle |
| `&mkp` | Mouse button | `&mkp LCLK` | mouse.h/pointing.h |
| `&out` | Output constant | `&out OUT_USB` | outputs.h |
| `&ext_power` | Power constant | `&ext_power EP_ON` | ext_power.h |

### 2-Parameter Behaviors
| Binding | Param1 type | Param2 type | Example | Notes |
|---------|------------|------------|---------|-------|
| `&lt` | Layer ID | HID keycode | `&lt NAV SPACE` | Hold=layer, tap=key |
| `&mt` | HID modifier | HID keycode | `&mt LSHFT A` | Hold=mod, tap=key |
| `&bt` | BT command | BT param | `&bt BT_SEL 0` | bt.h |
| `&rgb_ug` | RGB command | RGB param | `&rgb_ug RGB_TOG` | rgb.h |
| `&bl` | BL command | BL param | `&bl BL_TOG` | backlight.h |
| Custom hold-tap | Behavior ref | Behavior ref | `&magic MAGIC 0` | Defined in .keymap |

---

## Header Files for Constant Lookups

All at `zmk/zmk/app/include/dt-bindings/zmk/`:

### keys.h — HID keycodes
- Encoding: `ZMK_HID_USAGE(page, id) = (page << 16) | id`
- Page 0x07 = keyboard (A=0x04, F1=0x3A, LSHFT=0xE1, etc.)
- Page 0x0C = consumer (C_VOL_UP, C_PP, C_BRI_DN, etc.)
- Page 0x01 = generic desktop (SYS_PWR, SYS_SLEEP, SYS_WAKE)
- Prefer shortest alias: `A` not `KEYBOARD_A`

### modifiers.h — Modifier wrapping
- `mods << 24 | keycode`
- MOD_LCTL=0x01, MOD_LSFT=0x02, MOD_LALT=0x04, MOD_LGUI=0x08
- MOD_RCTL=0x10, MOD_RSFT=0x20, MOD_RALT=0x40, MOD_RGUI=0x80
- Macros: LC(), LS(), LA(), LG(), RC(), RS(), RA(), RG()
- Can nest: `LA(LS(N8))` = 0x06 << 24 | keycode

### bt.h — Bluetooth constants
- `BT_CLR` → param1=0, param2=0
- `BT_NXT` → param1=1, param2=0
- `BT_PRV` → param1=2, param2=0
- `BT_SEL` → param1=3, param2=<profile_number>
- `BT_CLR_ALL` → param1=4, param2=0
- `BT_DISC` → param1=5, param2=<profile_number>
- NOTE: `BT_CLR`, `BT_NXT`, `BT_PRV`, `BT_CLR_ALL` expand to TWO tokens (cmd + 0)

### rgb.h — RGB underglow constants
- `RGB_TOG` → 0, 0
- `RGB_ON` → 1, 0 / `RGB_OFF` → 2, 0
- `RGB_HUI` → 3, 0 / `RGB_HUD` → 4, 0
- `RGB_SAI` → 5, 0 / `RGB_SAD` → 6, 0
- `RGB_BRI` → 7, 0 / `RGB_BRD` → 8, 0
- `RGB_SPI` → 9, 0 / `RGB_SPD` → 10, 0
- `RGB_EFF` → 11, 0 / `RGB_EFR` → 12, 0
- `RGB_EFS` → 13, 0 / `RGB_STATUS` → 15, 0
- `RGB_COLOR_HSB(h,s,v)` → 14, `(h<<16)+(s<<8)+v`
- NOTE: All expand to TWO tokens (cmd + 0 or cmd + value)

### outputs.h — Output selection
- `OUT_TOG` → 0
- `OUT_USB` → 1
- `OUT_BLE` → 2

### ext_power.h — External power
- `EP_OFF` → 0
- `EP_ON` → 1
- `EP_TOG` → 2

### backlight.h — Backlight
- `BL_ON` → 0, 0 / `BL_OFF` → 1, 0
- `BL_TOG` → 2, 0
- `BL_INC` → 3, 0 / `BL_DEC` → 4, 0
- `BL_CYCLE` → 5, 0
- `BL_SET` → 6, <brightness>
- NOTE: Most expand to TWO tokens

### mouse.h / pointing.h — Mouse buttons
- Imports from pointing.h
- Mouse button codes for `&mkp`

---

## ZMK Studio RPC — What It Can Modify

### Binding operations
- `setLayerBinding(layerId, keyPosition, { behaviorId, param1, param2 })` — change one key
- All bindings use the 3-field format regardless of behavior param count

### Layer operations
- `addLayer()` → returns new layer with id and index
- `removeLayer(layerIndex)` → returns removed layer id for restore
- `restoreLayer(layerId, atIndex)` → re-add removed layer
- `moveLayer(startIndex, destIndex)` → reorder
- `setLayerProps(layerId, { name })` → rename layer

### Read-only queries
- `getKeymap()` → all layers with bindings
- `getPhysicalLayouts()` → physical key positions
- `listAllBehaviors()` → behavior IDs
- `getBehaviorDetails(behaviorId)` → displayName + parameter metadata
- `checkUnsavedChanges()`

### Persistence
- `saveChanges()` → persist to keyboard flash
- `discardChanges()` → revert to last saved

---

## What Studio CANNOT Modify (keymap-file-only)

These sections of the .keymap file are never touched by Studio and must be preserved as-is:

- `#include` directives
- `#define` constants (HYPER, layer names)
- `behaviors { }` section (custom hold-tap, tap-dance, mod-morph configs)
- `macros { }` section (macro sequences)
- `combos { }` section (combo definitions)
- `conditional_layers { }` section
- Sensor bindings
- Comments
- All formatting/whitespace outside bindings blocks

---

## Known Gaps & Complexity

### Gap 1: Constant reverse-lookup tables
The plan's Step 1 (`zmk-key-names.ts`) must parse ALL header files above, not just `keys.h`. Many constants (BT_*, RGB_*, BL_*) expand to TWO values that map to param1+param2 together. Resolution must be aware of the behavior type to know which constant table to use.

### Gap 2: Multi-token constant expansion
`BT_SEL 0` in the .keymap becomes `param1=3, param2=0` internally. `BT_SEL` itself expands to `BT_SEL_CMD` (=3) and consumes the next token as param2. When reverse-mapping, we need to recognize that param1=3 for a `bt` behavior means `BT_SEL` and param2 is the profile number — NOT a separate constant lookup.

### Gap 3: Dynamic layer operations
Adding/removing/reordering layers requires structural .keymap file changes:
- **Add**: Insert new `layer_name { bindings = <...>; };` block with all `&none` bindings
- **Remove**: Delete the layer block, update `#define` numbering, update any `&mo`/`&lt`/`&to`/`&tog` references
- **Move**: Reorder layer blocks, update `#define` numbering
- **Rename**: Update layer block name and `#define`

Layer remove/move also affects other bindings that reference layer IDs — those references will be updated on the keyboard side by Studio, so a full re-sync (re-read all bindings) is needed after any layer structural change.

### Gap 4: Custom behavior parameter resolution
Custom hold-tap behaviors (like `&magic MAGIC 0`) use custom parameter semantics. `MAGIC` is a `#define` for a layer ID, `0` is passed to the underlying behavior. Positional alignment handles this for the initial sync, but if a user assigns `&magic` to a NEW position via Studio, we need to know that param1 is a layer ID and param2 is passed through. The behavior metadata from RPC should tell us this.

### Gap 5: Behavior binding cells vary
Some behaviors that appear as 0-param in the .keymap are actually 1-param or 2-param at the protobuf level (with params set to 0). The behavior metadata from `getBehaviorDetails` defines the actual parameter count. We should use the metadata, not assumptions.
