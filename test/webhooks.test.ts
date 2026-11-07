import { describe, expect, it } from "vitest";
import { apiOrder, postWebhook, setupTestApp } from "./helpers.js";

const ctx = setupTestApp();

describe("POST /webhooks/order", () => {
  it("создаёт заказ", async () => {
    const res = await postWebhook(ctx.app, apiOrder());
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ result: "created" });
  });

  it("повтор того же события ничего не меняет", async () => {
    const o = apiOrder();
    await postWebhook(ctx.app, o);
    expect((await postWebhook(ctx.app, o)).json()).toEqual({ result: "stale" });
  });

  it("устаревшее событие после нового игнорируется", async () => {
    const o = apiOrder({ status: "paid", updatedAt: "2026-02-10T12:00:00Z" });
    await postWebhook(ctx.app, { ...o, status: "refunded", updatedAt: "2026-02-11T12:00:00Z" });
    expect((await postWebhook(ctx.app, o)).json()).toEqual({ result: "stale" });
    const { rows } = await ctx.db.query(`SELECT status FROM orders WHERE id = $1`, [o.id]);
    expect(rows[0].status).toBe("refunded");
  });

  it("новое событие обновляет заказ", async () => {
    const o = apiOrder({ status: "pending" });
    await postWebhook(ctx.app, o);
    const res = await postWebhook(ctx.app, { ...o, status: "paid", updatedAt: "2026-02-11T00:00:00Z" });
    expect(res.json()).toEqual({ result: "updated" });
  });

  it("невалидное тело — 400", async () => {
    const res = await postWebhook(ctx.app, { id: "x" });
    expect(res.statusCode).toBe(400);
  });

  it("невалидный amountPaid — 400", async () => {
    for (const amountPaid of ["abc", "", "  ", 1e20]) {
      const res = await postWebhook(ctx.app, apiOrder({ amountPaid }));
      expect(res.statusCode, `amountPaid: ${JSON.stringify(amountPaid)}`).toBe(400);
    }
  });

  it("amountPaid больше amount — 400, равный amount принимается", async () => {
    expect((await postWebhook(ctx.app, apiOrder({ amount: 100, amountPaid: 150 }))).statusCode).toBe(400);
    expect((await postWebhook(ctx.app, apiOrder({ amount: 100, amountPaid: 100 }))).statusCode).toBe(200);
  });

  it("параллельная доставка версий не откатывает заказ к старой", async () => {
    const olds = Array.from({ length: 20 }, () => apiOrder({ status: "paid", updatedAt: "2026-02-10T12:00:00Z" }));
    const deliveries = olds.flatMap((old) => {
      const fresh = { ...old, status: "refunded", updatedAt: "2026-02-10T13:00:00Z" };
      return [fresh, old, fresh, old];
    });

    const responses = await Promise.all(deliveries.map((o) => postWebhook(ctx.app, o)));

    const { rows } = await ctx.db.query(`SELECT status, count(*)::int AS n FROM orders GROUP BY status`);
    expect(rows).toEqual([{ status: "refunded", n: 20 }]);
    expect(responses.filter((r) => r.json().result === "created")).toHaveLength(20);
  });
});
