import { describe, expect, it } from "vitest";
import {
  buildAccountStatsMap, classifyCashOrder, customerCountLabel, classifyLayaway, orderCountsLabel, tallyCustomerOrders,
} from "@/lib/customer-account-stats";

// One active/done rule for the directory row AND the customer page header
// (2026-09-24: the header read "8 active accounts" for a customer whose row
// said "1 active · 7 done").
const C = "cust-1";
const layaways = [
  { customer_id: C, status: "active", remaining_balance: 5000 },       // active
  { customer_id: C, status: "overdue", remaining_balance: 1200 },      // active
  { customer_id: C, status: "completed", remaining_balance: 0 },       // done
  { customer_id: C, status: "active", remaining_balance: 0 },          // done — nothing left to pay
  { customer_id: C, status: "forfeited", remaining_balance: 9000 },    // not counted
  { customer_id: C, status: "final_forfeited", remaining_balance: 900 }, // not counted
  { customer_id: C, status: "cancelled", remaining_balance: 3000 },    // not counted
];
const cash = [
  { customer_id: C, status: "pending" },    // active
  { customer_id: C, status: "completed" },  // done
  { customer_id: C, status: "cancelled" },  // not counted
  { customer_id: C, status: "expired" },    // not counted
];

describe("customer active/done counts", () => {
  it("classifies each status the directory's way", () => {
    expect(layaways.map(classifyLayaway)).toEqual(["active", "active", "completed", "completed", null, null, null]);
    expect(cash.map(classifyCashOrder)).toEqual(["active", "completed", null, null]);
  });

  it("a mixed customer reads 3 active · 3 done — header and directory agree", () => {
    const header = tallyCustomerOrders(layaways, cash);
    expect(header).toEqual({ active: 3, completed: 3 });
    expect(buildAccountStatsMap(layaways, cash).get(C)).toEqual(header);
    expect(orderCountsLabel(header)).toBe("3 active · 3 done");
  });

  it("the reported case: 1 open plan and 7 finished ones is '1 active · 7 done', not '8 active'", () => {
    const eight = [{ status: "active", remaining_balance: 100 }, ...Array.from({ length: 7 }, () => ({ status: "completed", remaining_balance: 0 }))];
    expect(orderCountsLabel(tallyCustomerOrders(eight, []))).toBe("1 active · 7 done");
  });

  it("labels the edges", () => {
    expect(orderCountsLabel({ active: 0, completed: 0 })).toBe("No accounts");
    expect(orderCountsLabel(tallyCustomerOrders([{ status: "cancelled", remaining_balance: 1 }], [{ status: "expired" }]))).toBe("No accounts");
    expect(orderCountsLabel({ active: 2, completed: 0 })).toBe("2 active");
    expect(orderCountsLabel({ active: 0, completed: 4 })).toBe("4 done");
  });

  it("a customer with only uncounted orders gets no directory entry (the row shows 'No accounts')", () => {
    expect(buildAccountStatsMap([{ customer_id: "x", status: "cancelled", remaining_balance: 5 }], []).has("x")).toBe(false);
  });
});

describe("directory count label", () => {
  it("says how many of the customers are tests", () => {
    const list = [...Array.from({ length: 902 }, () => ({ is_test: false })), { is_test: true }];
    expect(customerCountLabel(list)).toBe("903 customers (1 test)");
    expect(customerCountLabel(list.slice(0, 902))).toBe("902 customers");
    expect(customerCountLabel([{ is_test: true }])).toBe("1 customer (1 test)");
    expect(customerCountLabel([])).toBe("0 customers");
  });
});
