import { describe, expect, it } from "vitest";
import { getOrderParticipantRole } from "./order-access";

const order = { buyerId: "buyer-1", sellerId: "seller-1" };

describe("getOrderParticipantRole", () => {
  it("recognizes the buyer and seller without granting access to other users", () => {
    expect(getOrderParticipantRole(order, "buyer-1")).toBe("buyer");
    expect(getOrderParticipantRole(order, "seller-1")).toBe("seller");
    expect(getOrderParticipantRole(order, "other-user")).toBeNull();
  });

  it("does not grant access when the authenticated user is missing", () => {
    expect(getOrderParticipantRole(order, null)).toBeNull();
    expect(getOrderParticipantRole(order, undefined)).toBeNull();
  });
});
