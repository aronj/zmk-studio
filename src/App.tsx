import { AppHeader } from "./AppHeader";

import { create_rpc_connection } from "@zmkfirmware/zmk-studio-ts-client";
import { call_rpc } from "./rpc/logging";

import type { Notification } from "@zmkfirmware/zmk-studio-ts-client/studio";
import { ConnectionState, ConnectionContext } from "./rpc/ConnectionContext";
import { Dispatch, useCallback, useEffect, useState } from "react";
import { ConnectModal, TransportFactory } from "./ConnectModal";

import type { RpcTransport } from "@zmkfirmware/zmk-studio-ts-client/transport/index";
import { UserCancelledError } from "@zmkfirmware/zmk-studio-ts-client/transport/errors";

const BLE_SERVICE_UUID = "00000000-0196-6107-c967-c5cfb1c2482a";
const BLE_RPC_CHRC_UUID = "00000001-0196-6107-c967-c5cfb1c2482a";

async function gatt_connect(): Promise<RpcTransport> {
  let dev = await navigator.bluetooth
    .requestDevice({
      acceptAllDevices: true,
      optionalServices: [BLE_SERVICE_UUID],
    })
    .catch((e) => {
      if (e instanceof DOMException && e.name === "NotFoundError") {
        throw new UserCancelledError("User cancelled the connection attempt", {
          cause: e,
        });
      } else {
        throw e;
      }
    });

  if (!dev.gatt) {
    throw new Error("No GATT service!");
  }

  let abortController = new AbortController();
  let label = dev.name || "Unknown";

  if (!dev.gatt.connected) {
    await dev.gatt.connect();
  }

  console.log("[gatt] Getting primary service...");
  let svc = await dev.gatt.getPrimaryService(BLE_SERVICE_UUID);
  console.log("[gatt] Got service, getting characteristic...");
  let char = await svc.getCharacteristic(BLE_RPC_CHRC_UUID);
  const p = char.properties;
  console.log("[gatt] Got characteristic, properties:", {
    broadcast: p.broadcast, read: p.read, writeWithoutResponse: p.writeWithoutResponse,
    write: p.write, notify: p.notify, indicate: p.indicate,
    authenticatedSignedWrites: p.authenticatedSignedWrites,
  });

  // The ZMK Studio GATT characteristic uses INDICATE (not NOTIFY).
  // Chrome on Windows may write the wrong CCC value (NOTIFY instead of INDICATE),
  // so we manually write the CCC descriptor with the INDICATE bit.
  const CCC_UUID = "00002902-0000-1000-8000-00805f9b34fb";
  try {
    await char.stopNotifications();
    await char.startNotifications();
    console.log("[gatt] startNotifications succeeded");
  } catch (e) {
    console.warn("[gatt] startNotifications failed:", e);
  }

  // Manually set CCC descriptor to INDICATE (0x0002) in case startNotifications set NOTIFY (0x0001)
  try {
    let cccDesc = await char.getDescriptor(CCC_UUID);
    await cccDesc.writeValue(new Uint8Array([0x02, 0x00]));
    console.log("[gatt] Manually wrote CCC descriptor with INDICATE bit");
  } catch (e) {
    console.warn("[gatt] Could not write CCC descriptor manually:", e);
  }

  let readable = new ReadableStream<Uint8Array>({
    start(controller) {
      let vc = (ev: Event) => {
        let buf = (ev.target as any)?.value?.buffer;
        console.log("[gatt] Received data:", buf ? new Uint8Array(buf) : "null");
        if (!buf) return;
        controller.enqueue(new Uint8Array(buf));
      };
      char.addEventListener("characteristicvaluechanged", vc);
      let cb = async () => {
        console.log("[gatt] Disconnected");
        char.removeEventListener("characteristicvaluechanged", vc);
        dev.removeEventListener("gattserverdisconnected", cb);
        controller.close();
      };
      dev.addEventListener("gattserverdisconnected", cb);
    },
  });

  // Use writeValueWithResponse — characteristic has writeWithoutResponse: false
  let writable = new WritableStream({
    async write(chunk) {
      console.log("[gatt] Sending data:", new Uint8Array(chunk));
      try {
        await char.writeValueWithResponse(new Uint8Array(chunk));
        console.log("[gatt] Write succeeded");
      } catch (e) {
        console.error("[gatt] Write failed:", e);
        throw e;
      }
    },
  });

  let sig = abortController.signal;
  let abort_cb: () => void;
  abort_cb = async () => {
    sig.removeEventListener("abort", abort_cb);
    dev.gatt?.disconnect();
  };
  sig.addEventListener("abort", abort_cb);

  return { label, abortController, readable, writable };
}
async function serial_connect(): Promise<RpcTransport> {
  let abortController = new AbortController();
  let port = await navigator.serial.requestPort({});
  await port.open({ baudRate: 9600 });
  console.log("[serial] Port opened");

  let info = port.getInfo();
  let label =
    (info.usbVendorId?.toLocaleString() || "") +
    ":" +
    (info.usbProductId?.toLocaleString() || "");

  // Wrap readable to log incoming data
  let rawReadable = port.readable!;
  let readable = rawReadable.pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        console.log("[serial] Received data:", new Uint8Array(chunk));
        controller.enqueue(chunk);
      },
    })
  );

  // Wrap writable to log outgoing data
  let rawWritable = port.writable!;
  let writable = new WritableStream({
    async write(chunk) {
      console.log("[serial] Sending data:", new Uint8Array(chunk));
      let writer = rawWritable.getWriter();
      await writer.write(chunk);
      writer.releaseLock();
    },
  });

  let sig = abortController.signal;
  let abort_cb: () => void;
  abort_cb = async () => {
    sig.removeEventListener("abort", abort_cb);
    await rawWritable.close();
    await rawReadable.cancel();
    await port.close();
  };
  sig.addEventListener("abort", abort_cb);

  return { label, abortController, readable, writable };
}
import {
  connect as tauri_ble_connect,
  list_devices as ble_list_devices,
} from "./tauri/ble";
import {
  connect as tauri_serial_connect,
  list_devices as serial_list_devices,
} from "./tauri/serial";
import Keyboard from "./keyboard/Keyboard";
import { UndoRedoContext, useUndoRedo } from "./undoRedo";
import { usePub, useSub } from "./usePubSub";
import { LockState } from "@zmkfirmware/zmk-studio-ts-client/core";
import { LockStateContext } from "./rpc/LockStateContext";
import { UnlockModal } from "./UnlockModal";
import { valueAfter } from "./misc/async";
import { AppFooter } from "./AppFooter";
import { AboutModal } from "./AboutModal";
import { LicenseNoticeModal } from "./misc/LicenseNoticeModal";

declare global {
  interface Window {
    __TAURI_INTERNALS__?: object;
  }
}

const TRANSPORTS: TransportFactory[] = [
  navigator.serial && { label: "USB", connect: serial_connect },
  ...(navigator.bluetooth
    ? [{ label: "BLE", connect: gatt_connect }]
    : []),
  ...(window.__TAURI_INTERNALS__
    ? [
        {
          label: "BLE",
          isWireless: true,
          pick_and_connect: {
            connect: tauri_ble_connect,
            list: ble_list_devices,
          },
        },
      ]
    : []),
  ...(window.__TAURI_INTERNALS__
    ? [
        {
          label: "USB",
          pick_and_connect: {
            connect: tauri_serial_connect,
            list: serial_list_devices,
          },
        },
      ]
    : []),
].filter((t) => t !== undefined);

async function listen_for_notifications(
  notification_stream: ReadableStream<Notification>,
  signal: AbortSignal
): Promise<void> {
  let reader = notification_stream.getReader();
  const onAbort = () => {
    reader.cancel();
    reader.releaseLock();
  };
  signal.addEventListener("abort", onAbort, { once: true });
  do {
    let pub = usePub();

    try {
      let { done, value } = await reader.read();
      if (done) {
        break;
      }

      if (!value) {
        continue;
      }

      console.log("Notification", value);
      pub("rpc_notification", value);

      const subsystem = Object.entries(value).find(
        ([_k, v]) => v !== undefined
      );
      if (!subsystem) {
        continue;
      }

      const [subId, subData] = subsystem;
      const event = Object.entries(subData).find(([_k, v]) => v !== undefined);

      if (!event) {
        continue;
      }

      const [eventName, eventData] = event;
      const topic = ["rpc_notification", subId, eventName].join(".");

      pub(topic, eventData);
    } catch (e) {
      signal.removeEventListener("abort", onAbort);
      reader.releaseLock();
      throw e;
    }
  } while (true);

  signal.removeEventListener("abort", onAbort);
  reader.releaseLock();
  notification_stream.cancel();
}

async function connect(
  transport: RpcTransport,
  setConn: Dispatch<ConnectionState>,
  setConnectedDeviceName: Dispatch<string | undefined>,
  signal: AbortSignal
) {
  console.log("[connect] Creating RPC connection...");
  let conn = await create_rpc_connection(transport, { signal });
  console.log("[connect] RPC connection created, sending getDeviceInfo...");

  let details = await Promise.race([
    call_rpc(conn, { core: { getDeviceInfo: true } })
      .then((r) => {
        console.log("[connect] getDeviceInfo response:", r);
        return r?.core?.getDeviceInfo;
      })
      .catch((e) => {
        console.error("[connect] Failed first RPC call", e);
        return undefined;
      }),
    valueAfter(undefined, 5000),
  ]);

  if (!details) {
    // TODO: Show a proper toast/alert not using `window.alert`
    window.alert("Failed to connect to the chosen device");
    return;
  }

  listen_for_notifications(conn.notification_readable, signal)
    .then(() => {
      setConnectedDeviceName(undefined);
      setConn({ conn: null });
    })
    .catch((_e) => {
      setConnectedDeviceName(undefined);
      setConn({ conn: null });
    });

  setConnectedDeviceName(details.name);
  setConn({ conn });
}

function App() {
  const [conn, setConn] = useState<ConnectionState>({ conn: null });
  const [connectedDeviceName, setConnectedDeviceName] = useState<
    string | undefined
  >(undefined);
  const [doIt, undo, redo, canUndo, canRedo, reset] = useUndoRedo();
  const [showAbout, setShowAbout] = useState(false);
  const [showLicenseNotice, setShowLicenseNotice] = useState(false);
  const [connectionAbort, setConnectionAbort] = useState(new AbortController());

  const [lockState, setLockState] = useState<LockState>(
    LockState.ZMK_STUDIO_CORE_LOCK_STATE_LOCKED
  );

  useSub("rpc_notification.core.lockStateChanged", (ls) => {
    setLockState(ls);
  });

  useEffect(() => {
    if (!conn) {
      reset();
      setLockState(LockState.ZMK_STUDIO_CORE_LOCK_STATE_LOCKED);
    }

    async function updateLockState() {
      if (!conn.conn) {
        return;
      }

      let locked_resp = await call_rpc(conn.conn, {
        core: { getLockState: true },
      });

      setLockState(
        locked_resp.core?.getLockState ||
          LockState.ZMK_STUDIO_CORE_LOCK_STATE_LOCKED
      );
    }

    updateLockState();
  }, [conn, setLockState]);

  const save = useCallback(() => {
    async function doSave() {
      if (!conn.conn) {
        return;
      }

      let resp = await call_rpc(conn.conn, { keymap: { saveChanges: true } });
      if (!resp.keymap?.saveChanges || resp.keymap?.saveChanges.err) {
        console.error("Failed to save changes", resp.keymap?.saveChanges);
      }
    }

    doSave();
  }, [conn]);

  const discard = useCallback(() => {
    async function doDiscard() {
      if (!conn.conn) {
        return;
      }

      let resp = await call_rpc(conn.conn, {
        keymap: { discardChanges: true },
      });
      if (!resp.keymap?.discardChanges) {
        console.error("Failed to discard changes", resp);
      }

      reset();
      setConn({ conn: conn.conn });
    }

    doDiscard();
  }, [conn]);

  const resetSettings = useCallback(() => {
    async function doReset() {
      if (!conn.conn) {
        return;
      }

      let resp = await call_rpc(conn.conn, {
        core: { resetSettings: true },
      });
      if (!resp.core?.resetSettings) {
        console.error("Failed to settings reset", resp);
      }

      reset();
      setConn({ conn: conn.conn });
    }

    doReset();
  }, [conn]);

  const disconnect = useCallback(() => {
    async function doDisconnect() {
      if (!conn.conn) {
        return;
      }

      await conn.conn.request_writable.close();
      connectionAbort.abort("User disconnected");
      setConnectionAbort(new AbortController());
    }

    doDisconnect();
  }, [conn]);

  const onConnect = useCallback(
    (t: RpcTransport) => {
      const ac = new AbortController();
      setConnectionAbort(ac);
      connect(t, setConn, setConnectedDeviceName, ac.signal);
    },
    [setConn, setConnectedDeviceName, setConnectedDeviceName]
  );

  return (
    <ConnectionContext.Provider value={conn}>
      <LockStateContext.Provider value={lockState}>
        <UndoRedoContext.Provider value={doIt}>
          <UnlockModal />
          <ConnectModal
            open={!conn.conn}
            transports={TRANSPORTS}
            onTransportCreated={onConnect}
          />
          <AboutModal open={showAbout} onClose={() => setShowAbout(false)} />
          <LicenseNoticeModal
            open={showLicenseNotice}
            onClose={() => setShowLicenseNotice(false)}
          />
          <div className="bg-base-100 text-base-content h-full max-h-[100vh] w-full max-w-[100vw] inline-grid grid-cols-[auto] grid-rows-[auto_1fr_auto] overflow-hidden">
            <AppHeader
              connectedDeviceLabel={connectedDeviceName}
              canUndo={canUndo}
              canRedo={canRedo}
              onUndo={undo}
              onRedo={redo}
              onSave={save}
              onDiscard={discard}
              onDisconnect={disconnect}
              onResetSettings={resetSettings}
            />
            <Keyboard />
            <AppFooter
              onShowAbout={() => setShowAbout(true)}
              onShowLicenseNotice={() => setShowLicenseNotice(true)}
            />
          </div>
        </UndoRedoContext.Provider>
      </LockStateContext.Provider>
    </ConnectionContext.Provider>
  );
}

export default App;
