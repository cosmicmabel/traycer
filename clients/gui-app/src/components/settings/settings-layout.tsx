import { Outlet } from "@tanstack/react-router";
import { SettingsSidebar } from "@/components/settings/settings-sidebar";

export function SettingsLayout() {
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background text-foreground sm:flex-row">
      <SettingsSidebar mode={{ kind: "route" }} />
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        <Outlet />
      </div>
    </div>
  );
}
