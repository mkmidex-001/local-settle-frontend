import type { Order } from "../models/order";

export type OrderParticipantRole = "buyer" | "seller";

export function getOrderParticipantRole(
  order: Pick<Order, "buyerId" | "sellerId">,
  userId?: string | null,
): OrderParticipantRole | null {
  if (!userId) return null;
  if (userId === order.buyerId) return "buyer";
  if (userId === order.sellerId) return "seller";
  return null;
}
