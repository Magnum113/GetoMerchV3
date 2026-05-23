import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { Product } from "@/lib/types";

export function ProductDisplay({ p, compact = false }: { p?: Product | null; compact?: boolean }) {
  if (!p) return <span className="text-muted-foreground">—</span>;

  return (
    <div className="flex flex-col gap-1 min-w-0">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-medium">
          {p.category?.name ?? "?"}{" "}
          <span className="text-muted-foreground font-normal">
            {p.fabric?.name.toLowerCase()}
          </span>
        </span>
        {p.color && (
          <span className="inline-flex items-center gap-1.5 text-sm">
            <span
              className="h-3 w-3 rounded-full border"
              style={{ backgroundColor: p.color.hex_code ?? "#999" }}
            />
            {p.color.name}
          </span>
        )}
        <Badge variant="outline" className="text-[10px] h-5">{p.size?.name}</Badge>
        {p.is_blank ? (
          <Badge variant="secondary" className="text-[10px] h-5">пустая</Badge>
        ) : (
          <Badge className="text-[10px] h-5">
            {p.decoration_type?.name}: {p.design?.name}
          </Badge>
        )}
      </div>
      {!compact && p.sku && (
        <div className="text-[11px] text-muted-foreground font-mono">{p.sku}</div>
      )}
    </div>
  );
}

export function ColorSwatch({ hex, name }: { hex?: string | null; name?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className={cn("h-3 w-3 rounded-full border")}
        style={{ backgroundColor: hex ?? "#999" }}
      />
      <span>{name}</span>
    </span>
  );
}
