"use client";

import { useEffect, useMemo, useState } from "react";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState } from "@/components/ui/empty-state";
import { ProductDisplay } from "@/components/product-display";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from "@/lib/api";
import type { Transaction, TransactionType } from "@/lib/types";
import { TRANSACTION_LABELS } from "@/lib/types";
import { ArrowLeftRight, Search, Image as ImageIcon } from "lucide-react";
import { formatDate } from "@/lib/utils";

const TX_COLORS: Record<TransactionType, string> = {
  receive: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
  transfer: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  sale: "bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300",
  production: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  adjustment: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  writeoff: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
};

export default function TransactionsPage() {
  const [tx, setTx] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [type, setType] = useState<string>("all");
  const [search, setSearch] = useState("");

  useEffect(() => { (async () => { setTx(await api.listTransactions(500)); setLoading(false); })(); }, []);

  const filtered = useMemo(() => {
    return tx.filter((t) => {
      if (type !== "all" && t.type !== type) return false;
      if (search) {
        const h = [t.product?.sku, t.product?.category?.name, t.product?.color?.name, t.product?.design?.name, t.notes, t.from_warehouse?.name, t.to_warehouse?.name].filter(Boolean).join(" ").toLowerCase();
        if (!h.includes(search.toLowerCase())) return false;
      }
      return true;
    });
  }, [tx, type, search]);

  return (
    <div>
      <PageHeader title="Журнал операций" description="История всех движений товара" />

      <Card className="mb-4">
        <CardContent className="p-4 flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Поиск по товару, складу, комментарию…" className="pl-8" />
          </div>
          <Select value={type} onValueChange={setType}>
            <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Все операции</SelectItem>
              {Object.entries(TRANSACTION_LABELS).map(([k, v]) => (
                <SelectItem key={k} value={k}>{v}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="p-10 text-center text-muted-foreground">Загрузка…</div>
          ) : filtered.length === 0 ? (
            <EmptyState icon={ArrowLeftRight} title="Операций пока нет" description="Здесь появятся все приёмки, перемещения, продажи и производства" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-28">Дата</TableHead>
                  <TableHead className="w-28">Тип</TableHead>
                  <TableHead>Товар</TableHead>
                  <TableHead>Откуда → Куда</TableHead>
                  <TableHead className="text-right">Кол-во</TableHead>
                  <TableHead>Комментарий</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((t) => (
                  <TableRow key={t.id}>
                    <TableCell className="text-xs text-muted-foreground">{formatDate(t.occurred_at)}</TableCell>
                    <TableCell>
                      <Badge className={TX_COLORS[t.type]}>{TRANSACTION_LABELS[t.type]}</Badge>
                    </TableCell>
                    <TableCell>
                      {t.product ? (
                        <div className="space-y-0.5">
                          <ProductDisplay p={t.product} compact />
                          {t.source_design && (
                            <div className="text-[11px] text-muted-foreground flex items-center gap-1">
                              <ImageIcon className="h-3 w-3" /> принт: {t.source_design.name} −{t.quantity}
                            </div>
                          )}
                        </div>
                      ) : t.design ? (
                        <div className="flex items-center gap-2">
                          {t.design.image_url ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={t.design.image_url} alt={t.design.name} className="h-8 w-8 rounded object-cover border" />
                          ) : (
                            <div className="h-8 w-8 rounded border bg-muted flex items-center justify-center">
                              <ImageIcon className="h-4 w-4 text-muted-foreground" />
                            </div>
                          )}
                          <div className="min-w-0">
                            <div className="text-sm font-medium truncate">{t.design.name}</div>
                            <div className="text-[11px] text-muted-foreground">принт</div>
                          </div>
                        </div>
                      ) : <span className="text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {t.from_warehouse?.name ?? "—"} <span className="mx-1">→</span> {t.to_warehouse?.name ?? "—"}
                    </TableCell>
                    <TableCell className="text-right font-semibold tabular-nums">{t.quantity}</TableCell>
                    <TableCell className="text-xs text-muted-foreground max-w-[300px] truncate">{t.notes ?? "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
