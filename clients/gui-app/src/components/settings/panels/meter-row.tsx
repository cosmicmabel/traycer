/**
 * The one shared meter-row layout + severity scale used by every usage bar in
 * the app (the Settings providers card, the header popover's windows, and the
 * uncapped extra-usage bars) - each caller computes its own `usedPercent` and
 * composes its own `detail`, but all of them render through this one layout
 * so the bars can never visually drift.
 *
 * The track fills with `bg-foreground/15` rather than `bg-muted`, and carries
 * no border: several dark theme presets set `--muted` equal to `--popover`,
 * so a plain `bg-muted` track (with or without a border ring) can end up the
 * same color as the popover background and read as "nothing there" (or as an
 * unwanted outline where none was wanted). An opacity overlay on
 * `--foreground` is guaranteed to contrast against any background, in every
 * theme, without needing a border to stay visible at 0% fill.
 */
import type { ReactNode } from "react";
import {
  rateLimitWindowFillPercent,
  rateLimitWindowSeverity,
  rateLimitWindowSeverityBarClassName,
} from "@/lib/rate-limits/window-severity";
import { cn } from "@/lib/utils";

export function MeterRow({
  label,
  usedPercent,
  detail,
}: {
  readonly label: string;
  readonly usedPercent: number;
  readonly detail: ReactNode;
}): ReactNode {
  const severity = rateLimitWindowSeverity(usedPercent);
  const fillPercent = rateLimitWindowFillPercent(usedPercent);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-3 text-ui-sm">
        <span className="text-foreground">{label}</span>
        <span className="text-ui-xs text-muted-foreground/70">{detail}</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-foreground/15">
        <div
          className={cn(
            "h-full rounded-full transition-all",
            rateLimitWindowSeverityBarClassName(severity),
          )}
          style={{ width: `${fillPercent}%` }}
        />
      </div>
    </div>
  );
}
