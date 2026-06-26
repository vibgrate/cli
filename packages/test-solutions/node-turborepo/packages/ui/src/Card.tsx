import { forwardRef, type HTMLAttributes, type ReactNode } from "react";
import { clsx } from "clsx";

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  variant?: "default" | "outlined" | "elevated";
  padding?: "none" | "sm" | "md" | "lg";
  hover?: boolean;
  header?: ReactNode;
  footer?: ReactNode;
}

const variantStyles = {
  default: "bg-white border border-gray-200",
  outlined: "bg-transparent border-2 border-gray-300",
  elevated: "bg-white shadow-lg",
};

const paddingStyles = {
  none: "",
  sm: "p-3",
  md: "p-4",
  lg: "p-6",
};

export const Card = forwardRef<HTMLDivElement, CardProps>(
  (
    {
      variant = "default",
      padding = "none",
      hover = false,
      header,
      footer,
      className,
      children,
      ...props
    },
    ref
  ) => {
    return (
      <div
        ref={ref}
        className={clsx(
          "rounded-lg",
          variantStyles[variant],
          paddingStyles[padding],
          hover && "transition-shadow hover:shadow-md cursor-pointer",
          className
        )}
        {...props}
      >
        {header && (
          <div className="border-b border-gray-200 px-4 py-3 font-medium">
            {header}
          </div>
        )}
        {children}
        {footer && (
          <div className="border-t border-gray-200 px-4 py-3 bg-gray-50 rounded-b-lg">
            {footer}
          </div>
        )}
      </div>
    );
  }
);

Card.displayName = "Card";
