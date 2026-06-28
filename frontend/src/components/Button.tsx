import type { ButtonHTMLAttributes } from "react";

type Variant = "primary" | "ghost";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
}

const base =
  "inline-flex items-center justify-center gap-2 rounded-md px-4 py-2 text-sm font-medium " +
  "transition-all duration-150 outline-none focus-visible:ring-1 focus-visible:ring-accent " +
  "active:scale-[0.98] disabled:opacity-40 disabled:pointer-events-none";

const variants: Record<Variant, string> = {
  // Accent = interactive. The one cool color, used sparingly.
  primary:
    "bg-accent text-bg hover:brightness-110 shadow-[0_1px_2px_rgba(0,0,0,0.4)]",
  ghost:
    "border border-border text-text-muted hover:text-text hover:border-border-strong",
};

export function Button({ variant = "primary", className = "", ...props }: ButtonProps) {
  return <button className={`${base} ${variants[variant]} ${className}`} {...props} />;
}
