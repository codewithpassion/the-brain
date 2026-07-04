import * as React from "react"
import { cn } from "../../lib/utils"

export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(({ className, type, ...props }, ref) => (
  <input
    type={type}
    ref={ref}
    className={cn(
      "flex h-9 w-full rounded-ui border border-border bg-bg px-3 py-1 text-ink text-sm placeholder:text-faint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 disabled:opacity-50",
      className,
    )}
    {...props}
  />
))
Input.displayName = "Input"
