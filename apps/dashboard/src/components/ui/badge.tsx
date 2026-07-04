import { cva, type VariantProps } from "class-variance-authority"
import type * as React from "react"
import { cn } from "../../lib/utils"

const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-2.5 py-0.5 font-medium font-mono text-[11px]",
  {
    variants: {
      variant: {
        default: "border-transparent bg-accent/15 text-accent",
        secondary: "border-transparent bg-raised text-muted",
        outline: "border-border text-muted",
        warning: "border-warn/25 bg-warn/12 text-warn",
        ok: "border-ok/25 bg-ok/12 text-ok",
        danger: "border-danger/25 bg-danger/12 text-danger",
      },
    },
    defaultVariants: { variant: "default" },
  },
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export const Badge = ({ className, variant, ...props }: BadgeProps) => (
  <span className={cn(badgeVariants({ variant }), className)} {...props} />
)

export { badgeVariants }
