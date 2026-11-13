import { CircleCheckIcon, InfoIcon, Loader2Icon, OctagonXIcon, TriangleAlertIcon } from "lucide-react"
import { Toaster as Sonner, type ToasterProps } from "sonner"

/** Follows the window's colour scheme, which the main process sets through nativeTheme. */
const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      theme="system"
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          // Docket's own palette (styles.css). The shadcn names (--popover, --border) are not defined
          // as variables here, and a toast pointed at them is drawn with no background at all.
          "--normal-bg": "var(--panel)",
          "--normal-text": "var(--ink)",
          "--normal-border": "var(--line)",
          "--border-radius": "8px",
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }
