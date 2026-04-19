import type { LocaleDefinition } from "./locale/locales";

export interface AppFooterProps {
  onShowAbout: () => void;
  onShowLicenseNotice: () => void;
  localeId: string;
  onLocaleChange: (id: string) => void;
  locales: LocaleDefinition[];
}

export const AppFooter = ({
  onShowAbout,
  onShowLicenseNotice,
  localeId,
  onLocaleChange,
  locales,
}: AppFooterProps) => {
  return (
    <div className="grid justify-center p-1 bg-base-200">
      <div className="flex items-center gap-1 flex-wrap justify-center">
        <span>&copy; 2024 - The ZMK Contributors</span> -{" "}
        <a className="hover:text-primary hover:cursor-pointer" onClick={onShowAbout}>
          About ZMK Studio
        </a>{" "}
        -{" "}
        <a className="hover:text-primary hover:cursor-pointer" onClick={onShowLicenseNotice}>
          License NOTICE
        </a>{" "}
        -{" "}
        <select
          className="select select-xs bg-base-300"
          value={localeId}
          onChange={(e) => onLocaleChange(e.target.value)}
        >
          {locales.map((l) => (
            <option key={l.id} value={l.id}>
              {l.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
};
