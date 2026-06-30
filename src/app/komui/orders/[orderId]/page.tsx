import { OrderDetail } from "./order-detail";

export const metadata = { title: "Заказ — Komui" };

export default async function KomuiOrderPage({
  params,
}: {
  params: Promise<{ orderId: string }>;
}) {
  const { orderId } = await params;
  return <OrderDetail orderId={orderId} />;
}
