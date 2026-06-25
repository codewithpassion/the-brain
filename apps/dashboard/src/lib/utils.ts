import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

/** The shadcn `cn` helper — merge conditional class lists, de-duplicating Tailwind utilities. */
export const cn = (...inputs: ClassValue[]): string => twMerge(clsx(inputs))
