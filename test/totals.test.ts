import { describe, expect, it } from "vitest";
import { apiOrder, dailyTotals, postWebhook, setupTestApp } from "./helpers.js";

const ctx = setupTestApp();

describe("GET /customers/:id/daily-totals", () => {
  it("суммирует оплаченные заказы по дням в таймзоне клиента", async () => {
    // c_1 — Europe/Moscow (UTC+3): 20:30Z ещё 10-е, 21:30Z уже 11-е
    await postWebhook(ctx.app, apiOrder({ amount: 1000, createdAt: "2026-02-10T20:30:00Z" }));
    await postWebhook(ctx.app, apiOrder({ amount: 250, createdAt: "2026-02-10T21:30:00Z" }));
    await postWebhook(ctx.app, apiOrder({ amount: "99", createdAt: "2026-02-11T10:00:00Z" }));

    const res = await dailyTotals(ctx.app, "c_1", "2026-02-09", "2026-02-11");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      { date: "2026-02-09", total: 0, gross: 0, discount: 0, net: 0 },
      { date: "2026-02-10", total: 1000, gross: 1000, discount: 0, net: 1000 },
      { date: "2026-02-11", total: 349, gross: 349, discount: 0, net: 349 },
    ]);
  });

  it("не учитывает pending и refunded", async () => {
    await postWebhook(ctx.app, apiOrder({ amount: 500 }));
    await postWebhook(ctx.app, apiOrder({ amount: 700, status: "pending" }));
    await postWebhook(ctx.app, apiOrder({ amount: 900, status: "refunded" }));
    const res = await dailyTotals(ctx.app, "c_1", "2026-02-10", "2026-02-10");
    expect(res.json()).toEqual([{ date: "2026-02-10", total: 500, gross: 500, discount: 0, net: 500 }]);
  });

  it("учитывает только заказы этого клиента", async () => {
    ctx.api.customers.set("c_2", "Asia/Novosibirsk");
    await postWebhook(ctx.app, apiOrder({ amount: 500 }));
    await postWebhook(ctx.app, apiOrder({ amount: 800, customerId: "c_2" }));
    const res = await dailyTotals(ctx.app, "c_2", "2026-02-10", "2026-02-10");
    expect(res.json()).toEqual([{ date: "2026-02-10", total: 800, gross: 800, discount: 0, net: 800 }]);
  });

  it("считает gross, discount и net по оплаченным заказам", async () => {
    await postWebhook(ctx.app, apiOrder({ amount: 2500, discountPercent: 16.5, amountPaid: 2087.5 }));
    await postWebhook(ctx.app, apiOrder({ amount: 900, discountPercent: 50, amountPaid: 450, status: "refunded" }));
    const res = await dailyTotals(ctx.app, "c_1", "2026-02-10", "2026-02-10");
    expect(res.json()).toEqual([{ date: "2026-02-10", total: 2500, gross: 2500, discount: 412.5, net: 2087.5 }]);
  });

  it("заказ без полей скидки считает оплаченным полностью", async () => {
    await postWebhook(ctx.app, apiOrder({ amount: 1000 }));
    await postWebhook(ctx.app, apiOrder({ amount: 500, amountPaid: null }));
    await postWebhook(ctx.app, apiOrder({ amount: 1000, discountPercent: 10, amountPaid: 900 }));
    const res = await dailyTotals(ctx.app, "c_1", "2026-02-10", "2026-02-10");
    expect(res.json()).toEqual([{ date: "2026-02-10", total: 2500, gross: 2500, discount: 100, net: 2400 }]);
  });

  it("принимает суммы и скидку строками", async () => {
    await postWebhook(ctx.app, apiOrder({ amount: "1000.00", discountPercent: "10", amountPaid: "900.00" }));
    const res = await dailyTotals(ctx.app, "c_1", "2026-02-10", "2026-02-10");
    expect(res.json()).toEqual([{ date: "2026-02-10", total: 1000, gross: 1000, discount: 100, net: 900 }]);
  });

  it("суммы точны до копейки", async () => {
    await postWebhook(ctx.app, apiOrder({ amount: 5249, discountPercent: 10, amountPaid: 4723.9 }));
    await postWebhook(ctx.app, apiOrder({ amount: 1353, discountPercent: 10, amountPaid: 1217.61 }));
    const res = await dailyTotals(ctx.app, "c_1", "2026-02-10", "2026-02-10");
    expect(res.json()).toEqual([{ date: "2026-02-10", total: 6602, gross: 6602, discount: 660.49, net: 5941.51 }]);
  });

  it("день определяет по смещению таймзоны на момент заказа", async () => {
    ctx.api.customers.set("c_1", "Europe/Berlin");
    await postWebhook(ctx.app, apiOrder({ amount: 100, createdAt: "2026-03-27T23:30:00Z" }));
    await postWebhook(ctx.app, apiOrder({ amount: 200, createdAt: "2026-03-28T22:30:00Z" }));
    await postWebhook(ctx.app, apiOrder({ amount: 400, createdAt: "2026-03-29T22:30:00Z" }));
    await postWebhook(ctx.app, apiOrder({ amount: 800, createdAt: "2026-03-30T21:30:00Z" }));
    const res = await dailyTotals(ctx.app, "c_1", "2026-03-28", "2026-03-30");
    expect(res.json().map((d: { date: string; total: number }) => [d.date, d.total])).toEqual([
      ["2026-03-28", 300],
      ["2026-03-29", 0],
      ["2026-03-30", 1200],
    ]);
  });

  it("таймзона клиента берётся из API один раз", async () => {
    await dailyTotals(ctx.app, "c_1", "2026-02-10", "2026-02-10");
    ctx.api.customers.set("c_1", "UTC");
    await dailyTotals(ctx.app, "c_1", "2026-02-10", "2026-02-10");
    const { rows } = await ctx.db.query(`SELECT timezone FROM customers WHERE id = 'c_1'`);
    expect(rows[0].timezone).toBe("Europe/Moscow");
  });

  it("валидирует даты", async () => {
    expect((await dailyTotals(ctx.app, "c_1", "2026-02-30", "2026-03-01")).statusCode).toBe(400);
    expect((await dailyTotals(ctx.app, "c_1", "2026-03-02", "2026-03-01")).statusCode).toBe(400);
  });

  it("неизвестный клиент — 404", async () => {
    const res = await dailyTotals(ctx.app, "nobody", "2026-02-10", "2026-02-10");
    expect(res.statusCode).toBe(404);
  });
});
