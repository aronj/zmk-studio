/** Messages sent from React client → Vite server over WebSocket */

export interface BehaviorBindingData {
  behaviorId: number;
  param1: number;
  param2: number;
}

export interface BehaviorMetadata {
  id: number;
  displayName: string;
  /** Parameter type descriptors from getBehaviorDetails RPC */
  paramTypes: ParamType[];
}

export type ParamType = "hidUsage" | "layerId" | "constant" | "nil";

export interface InitSyncMessage {
  type: "INIT_SYNC";
  layers: {
    id: number;
    name: string;
    bindings: BehaviorBindingData[];
  }[];
  behaviors: Record<number, BehaviorMetadata>;
}

export interface BindingChangedMessage {
  type: "BINDING_CHANGED";
  layerIndex: number;
  keyPosition: number;
  binding: BehaviorBindingData;
}

export interface LayersChangedMessage {
  type: "LAYERS_CHANGED";
  layers: {
    id: number;
    name: string;
    bindings: BehaviorBindingData[];
  }[];
}

export type SyncMessage =
  | InitSyncMessage
  | BindingChangedMessage
  | LayersChangedMessage;

/** Messages sent from Vite server → React client */
export interface StatusMessage {
  type: "STATUS";
  ok: boolean;
  message: string;
}
