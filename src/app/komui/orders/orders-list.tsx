"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  ChevronLeft,
  ChevronRight,
  Loader2,
  Phone,
  Receipt,
  RefreshCcw,
  Search,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Pill } from "@/components/ui/pill";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { errorMessage, formatDate, formatMoney } from "@/lib/utils";
import {
  moneyFromKopecks,
  type FulfillmentStatus,
  type PaymentStatus,
  type StorefrontOrderListResponse,
  type StorefrontOrderSummary,
} from "@/lib/komui/types";
import { CdekBadge, FulfillmentBadge, PaymentBadge } from "./status-badges";

const PAGE_SIZE = 50;

type QuickFilterKey = "all" | "to_ship" | "shipped" | "review" | "unpaid";

const QUICK_FILTERS: {
  key: QuickFilterKey;
  label: string;
  paymentStatus?: PaymentStatus | null;
  fulfillmentStatus?: FulfillmentStatus | null;
}[] = [
  { key: "all", label: "Все" },
  { key: "to_ship", label: "К отправке", paymentStatus: "paid", fulfillmentStatus: "new" },
  { key: "shipped", label: "Отправлены", fulfillmentStatus: "shipped" },
  { key: "review", label: "На проверке", paymentStatus: "payment_review" },
  { key: "unpaid", label: "Ждут оплаты", paymentStatus: "pending_payment" },
];

export function OrdersList() {
  const [items, setItems] = useState<StorefrontOrderSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [searchInput, setSearchInput] = useState("");
  const [q, setQ] = useState("");
  const [quick, setQuick] = useState<QuickFilterKey>("to_ship");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set("limit", String(PAGE_SIZE));
      params.set("offset", String(offset));
      if (q) params.set("q", q);
      const qf = QUICK_FILTERS.find((f) => f.key === quick);
      if (qf?.paymentStatus) params.set("paymentStatus", qf.paymentStatus);
      if (qf?.fulfillmentStatus)
        params.set("fulfillmentStatus", qf.fulfillmentStatus);

      const res = await fetch(
        `/api/komui/storefront/orders?${params.toString()}`,
        { cache: "no-store" },
      );
      const data = (await res.json()) as
        | StorefrontOrderListResponse
        | { error: string };
      if (!res.ok || "error" in data) {
        throw new Error(("error" in data && data.error) || `Ошибка ${res.status}`);
      }
      setItems(data.orders);
      setTotal(data.pagination.total);
    } catch (e) {
      toast.error(errorMessage(e));
      setItems([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [offset, q, quick]);

  useEffect(() => {
    load();
  }, [load]);

  const totalPages = total > 0 ? Math.ceil(total / PAGE_SIZE) : 1;
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;
  const canPrev = offset > 0;
  const canNext = offset + PAGE_SIZE < total;

  function applySearch() {
    setOffset(0);
    setQ(searchInput.trim());
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="flex flex-wrap items-center gap-2 justify-between">
            <div className="flex flex-wrap gap-1.5">
              {QUICK_FILTERS.map((f) => (
                <Pill
                  key={f.key}
                  shape="square"
                  active={quick === f.key}
                  onClick={() => {
                    setQuick(f.key);
                    setOffset(0);
                  }}
                >
                  {f.label}
                </Pill>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  applySearch();
                }}
                className="relative"
              >
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  placeholder="номер, телефон, имя, город, ПВЗ"
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  className="pl-8 w-80"
                />
              </form>
              <Button variant="outline" onClick={load} disabled={loading}>
                {loading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCcw className="h-4 w-4" />
                )}
                Обновить
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {items.length === 0 && !loading ? (
        <Card>
          <CardContent className="p-0">
            <EmptyState
              icon={Receipt}
              title="Заказов не найдено"
              description={q ? `По запросу "${q}" ничего нет` : "Под текущий фильтр заказов нет"}
            />
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-44">Заказ</TableHead>
                    <TableHead>Клиент</TableHead>
                    <TableHead>Доставка</TableHead>
                    <TableHead className="w-32 text-right">Сумма</TableHead>
                    <TableHead className="w-44">Платёж</TableHead>
                    <TableHead className="w-44">Обработка</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((o) => (
                    <OrderRow key={o.id} order={o} />
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <div>
          Всего: <span className="tabular-nums text-foreground">{total}</span>
          {total > 0 && (
            <>
              {" · "}Страница{" "}
              <span className="tabular-nums text-foreground">{currentPage}</span> из{" "}
              <span className="tabular-nums text-foreground">{totalPages}</span>
            </>
          )}
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            disabled={!canPrev || loading}
            onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
          >
            <ChevronLeft className="h-4 w-4" /> Назад
          </Button>
          <Button
            variant="outline"
            disabled={!canNext || loading}
            onClick={() => setOffset(offset + PAGE_SIZE)}
          >
            Вперёд <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}

function OrderRow({ order }: { order: StorefrontOrderSummary }) {
  const total = moneyFromKopecks(order.amounts?.total ?? null);
  const customerName = [order.customer?.firstName, order.customer?.lastName]
    .filter(Boolean)
    .join(" ");
  return (
    <TableRow
      className="cursor-pointer hover:bg-muted/40"
      onClick={() => {
        window.location.href = `/komui/orders/${order.id}`;
      }}
    >
      <TableCell>
        <Link
          href={`/komui/orders/${order.id}`}
          className="font-mono font-medium hover:underline"
          onClick={(e) => e.stopPropagation()}
        >
          {order.orderNumber || order.id}
        </Link>
        <div className="text-[11px] text-muted-foreground">
          {order.createdAt ? formatDate(order.createdAt) : "—"}
        </div>
        {order.itemCount != null && (
          <div className="text-[10px] text-muted-foreground">
            {order.itemCount} шт / {order.lineCount ?? "?"} позиции
          </div>
        )}
      </TableCell>
      <TableCell>
        <div className="text-sm truncate max-w-[260px]">
          {customerName || (
            <span className="text-muted-foreground italic">без имени</span>
          )}
        </div>
        {order.customer?.phone && (
          <div className="text-xs text-muted-foreground inline-flex items-center gap-1 font-mono">
            <Phone className="h-3 w-3" /> {order.customer.phone}
          </div>
        )}
      </TableCell>
      <TableCell>
        <div className="text-xs">
          <span className="font-medium uppercase">
            {order.delivery?.provider ?? "—"}
          </span>
          {order.delivery?.city && (
            <span className="text-muted-foreground"> · {order.delivery.city}</span>
          )}
        </div>
        <div className="text-[10px] text-muted-foreground truncate max-w-[260px]">
          {order.delivery?.pointCode}
        </div>
        <div className="mt-1">
          <CdekBadge status={order.cdek?.status} />
          {order.cdek?.number && (
            <span className="ml-1 text-[10px] font-mono text-muted-foreground">
              {order.cdek.number}
            </span>
          )}
        </div>
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {total != null ? formatMoney(total) : "—"}
      </TableCell>
      <TableCell>
        <PaymentBadge status={order.paymentStatus} />
        {order.paidAt && (
          <div className="text-[10px] text-muted-foreground mt-1">
            оплачен {formatDate(order.paidAt)}
          </div>
        )}
      </TableCell>
      <TableCell>
        <FulfillmentBadge status={order.fulfillmentStatus} />
        {order.shippedAt && (
          <div className="text-[10px] text-muted-foreground mt-1">
            отправлен {formatDate(order.shippedAt)}
          </div>
        )}
      </TableCell>
    </TableRow>
  );
}
