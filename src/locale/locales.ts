export type HidLabels = {
  short?: string;
  med?: string;
  long?: string;
};

export type LocaleOverrides = Record<string, Record<string, HidLabels>>;

export interface LocaleDefinition {
  id: string;
  label: string;
  overrides: LocaleOverrides;
}
