import { cva, type VariantProps } from "class-variance-authority"
import type * as React from "react"
import { cn } from "../../lib/utils"

const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-2.5 py-0.5 font-medium text-xs",
  {
    variants: {
      variant: {
        default: "border-transparent bg-neutral-900 text-white",
        secondary: "border-transparent bg-neutral-100 text-neutral-700",
        outline: "border-neutral-300 text-neutral-700",
        warning: "border-transparent bg-amber-100 text-amber-800",
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
