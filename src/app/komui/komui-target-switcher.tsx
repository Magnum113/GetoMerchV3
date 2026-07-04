"use client";

import { useState } from "react";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  KOMUI_TARGET_COOKIE,
  type KomuiTarget,
  normalizeKomuiTarget,
} from "@/lib/komui/target";

export function KomuiTargetSwitcher({ target }: { target: KomuiTarget }) {
  const [value, setValue] = useState<KomuiTarget>(target);

  function switchTarget(nextValue: string) {
    const next = normalizeKomuiTarget(nextValue);
    if (!next || next === value) return;

    setValue(next);
    document.cookie = [
      `${KOMUI_TARGET_COOKIE}=${next}`,
      "Path=/",
      "Max-Age=31536000",
      "SameSite=Lax",
    ].join("; ");

    // Полная перезагрузка нужна, потому что страницы Komui держат данные в
    // client state после fetch('/api/komui/*'). После смены cookie нужно
    // гарантированно перечитать и server layout, и BFF routes.
    window.location.reload();
  }

  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-muted-foreground">Контур</span>
      <Select value={value} onValueChange={switchTarget}>
        <SelectTrigger className="h-8 w-[130px] bg-background">
          <SelectValue />
        </SelectTrigger>
        <SelectContent align="end">
          <SelectItem value="prod">PROD</SelectItem>
          <SelectItem value="stage">STAGE</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}
