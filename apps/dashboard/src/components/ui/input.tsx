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
      "flex h-9 w-full rounded-md border border-neutral-300 bg-white px-3 py-1 text-sm shadow-sm placeholder:text-neutral-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400 disabled:opacity-50",
      className,
    )}
    {...props}
  />
))
Input.displayName = "Input"
