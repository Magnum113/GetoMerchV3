"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { Warehouse } from "@/lib/types";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

interface WarehouseSelectProps {
  value?: string;
  onChange: (id: string) => void;
  placeholder?: string;
  filterType?: "own" | "workshop";
}

export function WarehouseSelect({ value, onChange, placeholder = "Выберите склад", filterType }: WarehouseSelectProps) {
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  useEffect(() => {
    api.listWarehouses().then((ws) => {
      setWarehouses(filterType ? ws.filter((w) => w.type === filterType) : ws);
    });
  }, [filterType]);

  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger><SelectValue placeholder={placeholder} /></SelectTrigger>
      <SelectContent>
        {warehouses.map((w) => (
          <SelectItem key={w.id} value={w.id}>
            <span className="inline-flex items-center gap-2">
              <span className={`h-2 w-2 rounded-full ${w.type === "own" ? "bg-emerald-500" : "bg-amber-500"}`} />
              {w.name}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
