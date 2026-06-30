"use client";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  cdekStatusLabel,
  fulfillmentStatusLabel,
  paymentStatusLabel,
} from "@/lib/komui/types";

export function PaymentBadge({ status }: { status?: string }) {
  const cls = paymentTone(status);
  return (
    <Badge variant="outline" className={cn("border-transparent", cls)}>
      {paymentStatusLabel(status)}
    </Badge>
  );
}

export function FulfillmentBadge({ status }: { status?: string }) {
  const cls = fulfillmentTone(status);
  return (
    <Badge variant="outline" className={cn("border-transparent", cls)}>
      {fulfillmentStatusLabel(status)}
    </Badge>
  );
}

export function CdekBadge({ status }: { status?: string }) {
  if (!status) return <span className="text-muted-foreground text-xs">—</span>;
  const cls = cdekTone(status);
  return (
    <Badge variant="outline" className={cn("border-transparent text-[10px]", cls)}>
      {cdekStatusLabel(status)}
    </Badge>
  );
}

function paymentTone(s?: string): string {
  switch (s) {
    case "paid":
      return "bg-state-success text-state-success-fg";
    case "authorized":
      return "bg-state-info text-state-info-fg";
    case "pending_payment":
    case "created":
      return "bg-state-warning text-state-warning-fg";
    case "payment_review":
      return "bg-state-warning text-state-warning-fg";
    case "payment_failed":
    case "canceled":
    case "refunded":
    case "partially_refunded":
      return "bg-state-danger text-state-danger-fg";
    default:
      return "bg-state-neutral text-state-neutral-fg";
  }
}

function fulfillmentTone(s?: string): string {
  switch (s) {
    case "new":
      return "bg-state-warning text-state-warning-fg";
    case "processing":
      return "bg-state-info text-state-info-fg";
    case "shipped":
      return "bg-state-info text-state-info-fg";
    case "delivered":
      return "bg-state-success text-state-success-fg";
    case "canceled":
    case "returned":
      return "bg-state-danger text-state-danger-fg";
    default:
      return "bg-state-neutral text-state-neutral-fg";
  }
}

function cdekTone(s?: string): string {
  switch (s) {
    case "created":
    case "accepted":
      return "bg-state-success text-state-success-fg";
    case "pending":
    case "creating":
      return "bg-state-info text-state-info-fg";
    case "invalid":
    case "failed":
    case "deleted":
      return "bg-state-danger text-state-danger-fg";
    default:
      return "bg-state-neutral text-state-neutral-fg";
  }
}
