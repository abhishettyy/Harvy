import type { ReactNode } from "react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";

/** An icon button whose label shows as the app's tooltip and is its accessible name. */
export function HintButton({
  label,
  className,
  onClick,
  disabled,
  children,
}: {
  readonly label: string;
  readonly className: string;
  readonly onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
  readonly disabled?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            className={className}
            onClick={onClick}
            disabled={disabled}
            aria-label={label}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
}
