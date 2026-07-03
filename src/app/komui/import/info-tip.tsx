"use client";

import { Info } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

// Иконка (i) с пояснением — вместо многострочных текстовых блоков в формах.
// Требует <TooltipProvider> выше по дереву.
export function InfoTip({ text }: { text: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="inline-flex text-muted-foreground/70 hover:text-foreground transition-colors"
          aria-label="Пояснение"
          onClick={(e) => e.preventDefault()}
        >
          <Info className="h-3.5 w-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs leading-snug">{text}</TooltipContent>
    </Tooltip>
  );
}
