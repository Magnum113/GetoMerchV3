import type { OzonOrder } from "@/lib/types";

export type MarkingLabelDownloadReceipt = {
  assignmentId: string;
  assignmentRevision: number;
  renderCount: number;
  templateVersion: string | null;
};

export function applyMarkingLabelDownload(
  orders: OzonOrder[],
  receipt: MarkingLabelDownloadReceipt,
): OzonOrder[] {
  let ordersChanged = false;
  const nextOrders = orders.map((order) => {
    let orderChanged = false;
    const items = order.items?.map((item) => {
      if (!item.marking) return item;
      let itemChanged = false;
      const assignments = item.marking.assignments.map((assignment) => {
        if (assignment.id !== receipt.assignmentId) return assignment;
        itemChanged = true;
        const firstRender = assignment.renderCount === 0;
        return {
          ...assignment,
          assignmentRevision: receipt.assignmentRevision,
          renderCount: receipt.renderCount,
          templateVersion: receipt.templateVersion,
          labelState: firstRender ? "label_rendered" as const : assignment.labelState,
          canRenderLabel: false,
          canReprintLabel: true,
          canConfirmApplied: firstRender ? true : assignment.canConfirmApplied,
        };
      });
      if (!itemChanged) return item;
      orderChanged = true;
      return {
        ...item,
        marking: { ...item.marking, assignments },
      };
    });
    if (!orderChanged) return order;
    ordersChanged = true;
    return { ...order, items };
  });
  return ordersChanged ? nextOrders : orders;
}
