import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

export const buttonVariants = cva(
  "relative inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-lg font-medium transition-[background-color,border-color,color,box-shadow,transform] duration-150 ease-out active:translate-y-px disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        primary: "bg-accent text-accent-fg shadow-sm hover:bg-accent-strong shadow-[inset_0_1px_0_rgb(255_255_255/0.25)]",
        secondary: "border border-line-strong bg-surface text-fg shadow-sm hover:bg-hover",
        ghost: "text-fg-2 hover:bg-hover hover:text-fg",
        danger: "bg-bad text-white shadow-sm hover:brightness-110",
        "danger-ghost": "border border-bad/35 bg-bad/[0.08] text-bad hover:border-bad/60 hover:bg-bad/[0.14]",
        link: "h-auto px-0 text-accent underline-offset-4 hover:underline",
      },
      size: {
        xs: "h-7 px-2 text-xs [&_svg]:size-3.5",
        sm: "h-8 px-3 text-[13px]",
        md: "h-9 px-3.5 text-sm",
        lg: "h-10 px-5 text-sm",
        icon: "size-8",
        "icon-sm": "size-7 [&_svg]:size-3.5",
      },
    },
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof buttonVariants> & { loading?: boolean };

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button({ className, variant, size, loading, disabled, children, type = "button", ...props }, ref) {
  return (
    <button ref={ref} type={type} className={cn(buttonVariants({ variant, size }), className)} disabled={disabled || loading} aria-busy={loading || undefined} {...props}>
      {loading && <Loader2 className="animate-spin" />}
      {children}
    </button>
  );
});
