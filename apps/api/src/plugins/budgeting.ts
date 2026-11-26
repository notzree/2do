import { z } from "zod";
import { Temporal } from "@js-temporal/polyfill";
import type { TaskPlugin } from "../interfaces/task-plugins.ts";
import { choiceField, numberField, textField } from "../interfaces/plugin-fields.ts";
import { dateField, logDay, logWorkflow, metric } from "./session-log.ts";

// Each currency has its own metric. Its confirmed log is stored in integer minor units.
const currencies = ["CAD", "USD", "EUR", "GBP", "JPY"] as const;
const factor = (currency: string) => (currency === "JPY" ? 1 : 100);
const currencySchema = z.enum(currencies);
const amount = numberField({
  key: "amount",
  label: "Expected amount",
  min: 0,
  inlayLabel: "Amount",
});
const currency = choiceField({
  key: "currency",
  label: "Currency",
  options: [...currencies],
  inlayLabel: "Currency",
});
const merchant = textField({ key: "merchant", label: "Merchant", maxLength: 120 });
const category = choiceField({
  key: "category",
  label: "Category",
  options: ["food", "groceries", "transport", "housing", "fitness", "shopping", "other"],
});
const data = z.strictObject({
  amount: amount.schema.optional(),
  currency: currencySchema.optional(),
  merchant: merchant.schema.optional(),
  category: category.schema.optional(),
});
const payment = z.strictObject({
  day: z.iso.date(),
  minor: z.int().nonnegative(),
  currency: currencySchema,
});
const moneyId = (unit: string) => "budgeting.spend-" + unit.toLowerCase();
const format = (value: number, unit: string) =>
  new Intl.NumberFormat("en", {
    style: "currency",
    currency: unit,
    currencyDisplay: "code",
  }).format(value);
function minorUnits(value: number, unit: string) {
  const scaled = value * factor(unit),
    rounded = Math.round(scaled);
  return z
    .int()
    .nonnegative()
    .refine(() => Math.abs(scaled - rounded) < 1e-7, "Invalid precision for this currency")
    .parse(rounded);
}
// Scan the complete numeric token first. A suffix currency must never match just its last digits.
function scanPayment(text: string): { amount?: number; currency?: string; rangeEndpoint?: number } {
  if (/\b(?:refund(?:ed)?|under|less than|at most|up to|budget of|no more than)\b/i.test(text))
    return {};

  const tokens = text.matchAll(
    /(?:(?<prefix>\b(?:CAD|USD|EUR|GBP|JPY))\s*)?(?:(?<symbol>[$€£¥])\s*)?(?<number>\d+(?:[.,'’ \u00a0\u202f]+\d+)*)(?:\s*(?<endSymbol>[$€£¥]))?(?:\s*(?<suffix>CAD|USD|EUR|GBP|JPY)\b)?/gi,
  );
  let found: { amount: number; currency?: string } | undefined;
  for (const token of tokens) {
    const { prefix, symbol, number, endSymbol, suffix } = token.groups!;
    if (!prefix && !symbol && !endSymbol && !suffix) continue;
    const before = text.slice(0, token.index);
    const after = text.slice(token.index + token[0].length);
    if (found || (/[\p{L}\d.,'’]$/u.test(before) && !symbol) || /^[\p{L}\d]/u.test(after))
      return {};
    const symbolUnits: Record<string, string> = { "€": "EUR", "£": "GBP", "¥": "JPY" };
    const units = [prefix, suffix, symbolUnits[symbol], symbolUnits[endSymbol]]
      .filter(Boolean)
      .map((unit) => unit!.toUpperCase());
    if (
      new Set(units).size > 1 ||
      ([symbol, endSymbol].includes("$") && units.length && !["CAD", "USD"].includes(units[0]))
    )
      return {};
    const currency = units[0];
    const amount = parseAmount(number, currency);
    if (amount === undefined) return {};
    if (/\d\s*(?:[-−–—/]|\bto)\s*$/i.test(before) || /^\s*(?:[-−–—/]|to\b)\s*\d/i.test(after))
      return { rangeEndpoint: amount };
    if (/[-−]\s*$/.test(before)) return {};
    found = { amount, ...(currency && { currency }) };
  }
  return found ?? {};
}

function paymentFromTitle(text: string) {
  const payment = scanPayment(text);
  return payment.rangeEndpoint === undefined ? payment : {};
}

function parseAmount(token: string, currency?: string): number | undefined {
  const normalized = token.replace(/[\u00a0\u202f]/g, " ").replaceAll("’", "'");
  const plain = /^(\d+)(?:[.,](\d{1,2}))?$/.exec(normalized);
  let whole: string, fraction: string;
  if (plain) {
    whole = plain[1];
    fraction = plain[2] ?? "";
  } else {
    // Group separators must repeat every three digits and differ from the decimal separator.
    const grouped = /^([1-9]\d{0,2}([., '])\d{3}(?:\2\d{3})*)(?:([.,])(\d{1,2}))?$/.exec(
      normalized,
    );
    if (!grouped || grouped[2] === grouped[3]) return;
    whole = grouped[1].split(grouped[2]).join("");
    fraction = grouped[4] ?? "";
  }
  const decimals = currency === "JPY" ? 0 : 2;
  if (!decimals && /[1-9]/.test(fraction)) return;
  const minor = Number(whole + fraction.slice(0, decimals).padEnd(decimals, "0"));
  const amount = minor / 10 ** decimals;
  if (Number.isSafeInteger(minor) && Math.round(amount * 10 ** decimals) === minor) return amount;
}
// Used only for the v1 upgrade. Recognize a partial token saved by the original extractor.
function isLegacyPartialAmount(
  title: string,
  saved: number,
  parsed: ReturnType<typeof scanPayment>,
) {
  const { amount: corrected, rangeEndpoint } = parsed;
  if (rangeEndpoint === saved) return true;
  if ((corrected === undefined && rangeEndpoint === undefined) || corrected === saved) return false;
  const oldMatches = [
    ...title.matchAll(
      /(?:\b(?:CAD|USD|EUR|GBP|JPY)\s*[$€£¥]?\s*|[$€£¥]\s*)(\d+(?:,\d{3})*(?:\.\d+)?)(?![\d,.]\d)|\b(\d+(?:\.\d+)?)\s*(?:CAD|USD|EUR|GBP|JPY)\b/gi,
    ),
  ];
  if (oldMatches.length !== 1) return false;
  const [, prefixAmount, suffixAmount] = oldMatches[0];
  return Number((prefixAmount ?? suffixAmount).replaceAll(",", "")) === saved;
}
function cleanExpenseDraft(draft: Record<string, unknown>, titles: readonly string[]) {
  const { amount, ...rest } = draft;
  if (typeof amount !== "number") return draft;
  const sources = [...new Set(titles)].map((title) => ({ title, parsed: scanPayment(title) }));
  // A later title can corroborate an edited estimate even if the original capture produced a partial.
  if (sources.some(({ parsed }) => parsed.amount === amount)) return draft;
  return sources.some(({ title, parsed }) => isLegacyPartialAmount(title, amount, parsed))
    ? rest
    : draft;
}
const workflow = logWorkflow({
  schema: payment,
  action: {
    id: "pay",
    label: "Record payment",
    fields: [
      dateField,
      { kind: "number", key: "amount", label: "Paid amount", min: 0, required: true },
      {
        kind: "choice",
        key: "currency",
        label: "Payment currency",
        options: [...currencies],
        required: true,
      },
    ],
  },
  defaults({ task, data, timeZone, today }) {
    const fields: Record<string, string | number> = { day: logDay(task, timeZone, today) };
    if (typeof data.amount === "number") fields.amount = data.amount;
    if (typeof data.currency === "string") fields.currency = data.currency;
    return fields;
  },
  record(input) {
    const unit = currencySchema.parse(input.currency);
    return payment.parse({
      day: input.day,
      currency: unit,
      minor: minorUnits(z.number().parse(input.amount), unit),
    });
  },
  form: (e) => ({ day: e.day, currency: e.currency, amount: e.minor / factor(e.currency) }),
  measure: (e) => [
    {
      metricId: moneyId(e.currency),
      metricVersion: 1,
      sourceKey: "payment",
      day: e.day,
      value: e.minor / factor(e.currency),
    },
  ],
});
export const budgetingPlugin: TaskPlugin = {
  id: "budgeting",
  label: "Budgeting",
  description: "Record payments and compare confirmed spending with monthly limits.",
  metrics: currencies.map((unit) => metric(moneyId(unit), "Spending (" + unit + ")", unit)),
  subtypes: [
    {
      id: "budgeting.expense",
      label: "Expense",
      captureCommand: "expense",
      icon: "card",
      schemaVersion: 2,
      migrations: { 1: cleanExpenseDraft },
      schema: data,
      initialData: {},
      view: (_, data) => data,
      editor: [{ fields: [amount.field, currency.field, merchant.field, category.field] }],
      workflow,
      classification: {
        instructions:
          "Does the task primarily describe buying, paying for, or recording a purchase or bill? A price paid to a merchant, including paying for a meal, is an expense. Include planned purchases and paid expenses. A meal or workout without a spending intent is insufficient. Exclude merely researching a price or discussing budgets.",
      },
      extraction: {
        merchant:
          "Explicit name of the seller or merchant, copied from the title. Omit when absent.",
      },
      fromTitle: paymentFromTitle,
    },
  ],
  goalSubtypes: [
    {
      id: "budgeting.monthly-limit",
      label: "Monthly spending limit",
      version: 1,
      fields: [
        { kind: "month", key: "month", label: "Budget month" },
        { kind: "choice", key: "currency", label: "Currency", options: [...currencies] },
        { kind: "number", key: "limit", label: "Monthly limit", min: 0 },
      ],
      metrics: currencies.map(moneyId),
      validate(data) {
        minorUnits(Number(data.limit), String(data.currency));
      },
      period(data) {
        const start = Temporal.PlainDate.from(data.month + "-01");
        return { from: start.toString(), to: start.add({ months: 1 }).toString() };
      },
      evaluate(data, rows, today) {
        const unit = String(data.currency),
          limit = Number(data.limit);
        const payments = rows.filter(
          (r) => r.metricId === moneyId(unit) && r.day <= today && r.value !== null,
        );
        const paid =
          payments.reduce((sum, r) => sum + Math.round(r.value! * factor(unit)), 0) / factor(unit);
        const closed = String(data.month) < today.slice(0, 7);
        return {
          satisfied: closed && payments.length > 0 && paid <= limit,
          label:
            data.month +
            " · " +
            format(paid, unit) +
            " logged · " +
            format(limit - paid, unit) +
            " remaining" +
            (!payments.length ? " · No payments logged" : ""),
        };
      },
    },
  ],
};
