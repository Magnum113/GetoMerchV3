import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { Product } from "@/lib/types";

export function ProductDisplay({
  p,
  compact = false,
  layout = "inline",
}: {
  p?: Product | null;
  compact?: boolean;
  layout?: "inline" | "stacked";
}) {
  if (!p) return <span className="text-muted-foreground">—</span>;

  const productName = (
    <>
      <span className="font-medium leading-snug">
        {p.category?.name ?? "?"}{" "}
        <span className="font-normal text-muted-foreground">
          {p.fabric?.name.toLowerCase()}
        </span>
      </span>
      {p.color && (
        <span className="inline-flex shrink-0 items-center gap-1.5 text-sm">
          <span
            className="h-3 w-3 rounded-full border"
            style={{ backgroundColor: p.color.hex_code ?? "#999" }}
          />
          {p.color.name}
        </span>
      )}
    </>
  );

  const productBadges = (
    <>
      <Badge variant="outline" className="h-6 shrink-0 px-2 text-xs">
        {p.size?.name}
      </Badge>
      {p.is_blank ? (
        <Badge variant="secondary" className="h-6 px-2 text-xs">
          пустая
        </Badge>
      ) : (
        <Badge className="h-auto min-h-6 max-w-full whitespace-normal break-words px-2 py-1 text-left text-xs leading-4">
          {p.decoration_type?.name}: {p.design?.name}
        </Badge>
      )}
    </>
  );

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {layout === "stacked" ? (
        <>
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            {productName}
          </div>
          <div className="flex min-w-0 flex-wrap items-start gap-1.5">
            {productBadges}
          </div>
        </>
      ) : (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {productName}
          {productBadges}
        </div>
      )}
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
