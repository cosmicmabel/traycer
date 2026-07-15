import type { ReactNode } from "react";

interface SettingsRowProps {
  label: string;
  description?: string;
  control: ReactNode;
}

export function SettingsRow(props: SettingsRowProps) {
  const { label, description, control } = props;
  // Mobile: label over control (a wide control has no room beside the label).
  // Desktop (sm+): the label/control split.
  return (
    <div className="flex flex-col gap-2 border-b border-border/40 px-4 py-4 last:border-b-0 sm:flex-row sm:items-start sm:justify-between sm:gap-6 sm:px-5">
      <div className="min-w-0 space-y-1">
        <div className="font-medium text-foreground">{label}</div>
        {description ? (
          <p className="text-ui-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      <div className="shrink-0 sm:ml-auto">{control}</div>
    </div>
  );
}
