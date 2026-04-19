import { createContext, useContext } from "react";
import type { LocaleDefinition, LocaleOverrides } from "./locales";

import svMacOverrides from "./locale-overrides-sv-mac.json";
import svWinOverrides from "./locale-overrides-sv-win.json";

export const AVAILABLE_LOCALES: LocaleDefinition[] = [
  { id: "us", label: "US", overrides: {} },
  { id: "sv-mac", label: "Swedish (macOS)", overrides: svMacOverrides },
  { id: "sv-win", label: "Swedish (Windows)", overrides: svWinOverrides },
];

const LocaleContext = createContext<LocaleOverrides>({});

export const LocaleProvider = LocaleContext.Provider;

export function useLocaleOverrides(): LocaleOverrides {
  return useContext(LocaleContext);
}
