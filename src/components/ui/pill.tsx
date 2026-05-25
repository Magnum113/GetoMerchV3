import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * Pill — компактная toggle-кнопка для переключателей и фильтров.
 *
 * В отличие от Button: меньший вертикальный отступ, отсутствие тени, два
 * визуальных состояния через проп `active`. Подходит для inline-фильтров
 * («Все склады / Мой склад / Цех вышивки»), сегмент-контролов и
 * переключателей в шапке карточек.
 */
const pillVariants = cva(
  "inline-flex items-center gap-1.5 border text-xs font-medium transition-colors disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      shape: {
        rounded: "rounded-full px-3 py-1",
        square: "rounded-md px-3 py-1.5",
      },
      active: {
        true: "bg-primary text-primary-foreground border-primary",
        false: "bg-background hover:bg-accent",
      },
    },
    defaultVariants: {
      shape: "rounded",
      active: false,
    },
  },
);

export interface PillProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof pillVariants> {}

export const Pill = React.forwardRef<HTMLButtonElement, PillProps>(
  ({ className, shape, active, type = "button", ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      data-state={active ? "active" : "inactive"}
      className={cn(pillVariants({ shape, active, className }))}
      {...props}
    />
  ),
);
Pill.displayName = "Pill";
