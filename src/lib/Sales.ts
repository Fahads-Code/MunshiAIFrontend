import { collection, doc, increment, serverTimestamp, writeBatch } from "firebase/firestore";
import type { WriteBatch } from "firebase/firestore";
import { db } from "../firebase";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export type SaleItem = {
  name: string;
  qty: number;
  unit: string;
  /** rate per unit */
  price: number;
  /** purchase cost per unit (optional, used for real profit) */
  cost?: number;
};

export type SaleDraft = {
  userId: string;
  customerId: string | null;
  customerName: string;
  customerPhone: string | null;
  items: SaleItem[];
  paid: number;
  note: string;
};

export type SavedSale = {
  receiptNo: string;
  createdAt: Date;
  customerName: string;
  customerPhone: string | null;
  items: SaleItem[];
  total: number;
  paid: number;
  balanceDue: number;
  profit: number;
  profitEstimated: boolean;
  note: string;
};

export const WALK_IN = "Walk-in Customer";
export const ESTIMATED_MARGIN = 0.15;

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

export const round2 = (n: number): number => Math.round(n * 100) / 100;

export const formatRs = (n: number): string => {
  const v = round2(n);
  return `${v < 0 ? "-" : ""}Rs. ${Math.abs(v).toLocaleString("en-PK")}`;
};

export const formatDateTime = (d: Date): string =>
  d.toLocaleString("en-PK", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

export const lineTotal = (i: Pick<SaleItem, "qty" | "price">): number => round2(i.qty * i.price);

export const saleTotal = (items: SaleItem[]): number =>
  round2(items.reduce((sum, i) => sum + lineTotal(i), 0));

/** Real profit where cost is known, 15% estimate for items without cost. */
export function saleProfit(items: SaleItem[]): { profit: number; estimated: boolean } {
  let profit = 0;
  let estimated = false;
  for (const i of items) {
    if (i.cost !== undefined) {
      profit += (i.price - i.cost) * i.qty;
    } else {
      profit += i.price * i.qty * ESTIMATED_MARGIN;
      estimated = true;
    }
  }
  return { profit: round2(profit), estimated };
}

export function makeReceiptNo(): string {
  const d = new Date();
  const ymd =
    String(d.getFullYear()).slice(2) +
    String(d.getMonth() + 1).padStart(2, "0") +
    String(d.getDate()).padStart(2, "0");
  const rand = Math.floor(1000 + Math.random() * 9000);
  return `R${ymd}-${rand}`;
}

/** Pakistani phone -> wa.me number (92...). Returns null if unusable. */
export function toWaNumber(phone?: string | null): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 10) return null;
  if (digits.startsWith("92")) return digits;
  if (digits.startsWith("0")) return "92" + digits.slice(1);
  return "92" + digits;
}

/** Safely read items[] coming from Firestore. */
export function parseItems(raw: unknown): SaleItem[] {
  if (!Array.isArray(raw)) return [];
  const out: SaleItem[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const name = typeof e.name === "string" ? e.name : "";
    const qty = Number(e.qty);
    const price = Number(e.price);
    if (!name || !Number.isFinite(qty) || !Number.isFinite(price)) continue;
    const unit = typeof e.unit === "string" ? e.unit : "pc";
    const cost = e.cost === undefined || e.cost === null ? undefined : Number(e.cost);
    out.push(
      cost !== undefined && Number.isFinite(cost)
        ? { name, qty, unit, price, cost }
        : { name, qty, unit, price }
    );
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Saving a bill                                                       */
/* ------------------------------------------------------------------ */

/**
 * Writes, in ONE atomic batch:
 *  1. a GAVE transaction (the sale, with items)
 *  2. a GOT transaction for the cash received now (if any) so ledger pages stay consistent
 *  3. customers/{id}.totalBalance += (total - paid)
 */
export async function saveSale(draft: SaleDraft): Promise<SavedSale> {
  const total = saleTotal(draft.items);
  const hasCustomer = draft.customerId !== null;
  const paid = hasCustomer ? round2(Math.min(total, Math.max(0, draft.paid))) : total;
  const due = round2(total - paid);
  const { profit, estimated } = saleProfit(draft.items);
  const receiptNo = makeReceiptNo();
  const createdAt = new Date();

  // Firestore rejects `undefined`, so strip empty cost fields.
  const cleanItems = draft.items.map((i) =>
    i.cost === undefined
      ? { name: i.name, qty: i.qty, unit: i.unit, price: i.price }
      : { name: i.name, qty: i.qty, unit: i.unit, price: i.price, cost: i.cost }
  );

  const batch = writeBatch(db);

  batch.set(doc(collection(db, "transactions")), {
    userId: draft.userId,
    customerId: draft.customerId,
    customerName: draft.customerName,
    type: "GAVE",
    amount: total,
    paid,
    items: cleanItems,
    profit,
    profitEstimated: estimated,
    receiptNo,
    note: draft.note,
    createdAt: serverTimestamp(),
  });

  if (paid > 0) {
    batch.set(doc(collection(db, "transactions")), {
      userId: draft.userId,
      customerId: draft.customerId,
      customerName: draft.customerName,
      type: "GOT",
      amount: paid,
      source: "sale-payment",
      receiptNo,
      note: `Receipt ${receiptNo} ka cash`,
      createdAt: serverTimestamp(),
    });
  }

  if (draft.customerId && due !== 0) {
    batch.update(doc(db, "customers", draft.customerId), { totalBalance: increment(due) });
  }

  await commitSoon(batch);

  return {
    receiptNo,
    createdAt,
    customerName: draft.customerName,
    customerPhone: draft.customerPhone,
    items: draft.items,
    total,
    paid,
    balanceDue: due,
    profit,
    profitEstimated: estimated,
    note: draft.note,
  };
}

/* ------------------------------------------------------------------ */
/* Text for WhatsApp / copy                                            */
/* ------------------------------------------------------------------ */

export function buildReceiptText(sale: SavedSale, shopName: string): string {
  const lines: string[] = [
    `*${shopName}*`,
    `Receipt ${sale.receiptNo}`,
    formatDateTime(sale.createdAt),
    `Customer: ${sale.customerName}`,
    "",
  ];
  sale.items.forEach((it, idx) => {
    lines.push(`${idx + 1}. ${it.name}  ${it.qty} ${it.unit} x ${it.price} = ${formatRs(lineTotal(it))}`);
  });
  lines.push("", `Total: ${formatRs(sale.total)}`, `Paid: ${formatRs(sale.paid)}`);
  if (sale.balanceDue > 0) lines.push(`Balance due: ${formatRs(sale.balanceDue)}`);
  if (sale.note) lines.push(`Note: ${sale.note}`);
  lines.push("", "Thank you for your business.");
  return lines.join("\n");
}

export function buildReminderText(name: string, amount: number, shopName: string): string {
  return `Assalam o Alaikum ${name},\n\nThis is a friendly reminder from ${shopName}: ${formatRs(amount)} is outstanding on your account. Kindly arrange payment at your earliest convenience.\n\nThank you.`;
}

/** WhatsApp link. Without a saved phone number WhatsApp lets the user pick the contact. */
export function waLink(phone: string | null | undefined, text: string): string {
  const n = toWaNumber(phone);
  return `https://wa.me/${n ?? ""}?text=${encodeURIComponent(text)}`;
}

/* ------------------------------------------------------------------ */
/* Shop name (shown on receipts and reminders)                         */
/* ------------------------------------------------------------------ */

const SHOP_KEY = "munshi_shop_name";
export const DEFAULT_SHOP = "My Shop";

export function getShopName(): string {
  try {
    return localStorage.getItem(SHOP_KEY) || DEFAULT_SHOP;
  } catch {
    return DEFAULT_SHOP;
  }
}

export function setShopName(value: string): void {
  try {
    localStorage.setItem(SHOP_KEY, value);
  } catch {
    // storage unavailable: the name just won't be remembered
  }
}

/* ------------------------------------------------------------------ */
/* Writes: batch helper, payments, expenses                            */
/* ------------------------------------------------------------------ */

/**
 * Commits a batch without leaving the UI waiting forever when offline:
 * Firestore applies the write locally at once and syncs when the network is back.
 */
async function commitSoon(batch: WriteBatch): Promise<void> {
  const commit = batch.commit();
  commit.catch(() => undefined);
  await Promise.race([commit, new Promise<void>((resolve) => setTimeout(resolve, 8000))]);
}

export function describeSaveError(err: unknown): string {
  const code =
    typeof err === "object" && err !== null && "code" in err ? String((err as { code: unknown }).code) : "";
  if (code === "permission-denied") return "Permission denied. Publish the latest Firestore rules and try again.";
  if (code === "unauthenticated") return "You are signed out. Sign in again and retry.";
  return "Could not save. Check your connection and try again.";
}

export type PaymentDraft = {
  userId: string;
  customerId: string;
  customerName: string;
  amount: number;
  note: string;
};

/** Cash received from a customer against their balance. One atomic batch. */
export async function recordPayment(d: PaymentDraft): Promise<void> {
  const amount = round2(d.amount);
  if (!(amount > 0)) throw new Error("invalid-amount");

  const batch = writeBatch(db);
  batch.set(doc(collection(db, "transactions")), {
    userId: d.userId,
    customerId: d.customerId,
    customerName: d.customerName,
    type: "GOT",
    amount,
    source: "payment",
    note: d.note,
    createdAt: serverTimestamp(),
  });
  batch.update(doc(db, "customers", d.customerId), { totalBalance: increment(-amount) });
  await commitSoon(batch);
}

export const EXPENSE_CATEGORIES = ["Rent", "Electricity", "Salary", "Transport", "Food and tea", "Repairs", "Other"] as const;

export type ExpenseDraft = { userId: string; amount: number; category: string; note: string };

export async function addExpense(d: ExpenseDraft): Promise<void> {
  const amount = round2(d.amount);
  if (!(amount > 0)) throw new Error("invalid-amount");

  const batch = writeBatch(db);
  batch.set(doc(collection(db, "expenses")), {
    userId: d.userId,
    amount,
    category: d.category,
    note: d.note,
    createdAt: serverTimestamp(),
  });
  await commitSoon(batch);
}

/* ------------------------------------------------------------------ */
/* Voice text -> items                                                 */
/* ------------------------------------------------------------------ */

const WORD_NUM = new Map<string, number>([
  // Roman Urdu / English
  ["ek", 1], ["aik", 1], ["one", 1], ["do", 2], ["two", 2], ["teen", 3], ["three", 3],
  ["char", 4], ["chaar", 4], ["four", 4], ["paanch", 5], ["panch", 5], ["five", 5],
  ["chay", 6], ["chhe", 6], ["cheh", 6], ["six", 6], ["saat", 7], ["seven", 7],
  ["aath", 8], ["eight", 8], ["nau", 9], ["nine", 9], ["das", 10], ["ten", 10],
  ["bees", 20], ["tees", 30], ["chalis", 40], ["pachas", 50], ["saath", 60],
  ["sattar", 70], ["assi", 80], ["nabbe", 90], ["adha", 0.5], ["aadha", 0.5], ["aadhi", 0.5],
  ["half", 0.5], ["dedh", 1.5], ["derh", 1.5], ["dhai", 2.5], ["dhaai", 2.5],
  // Urdu script
  ["ایک", 1], ["دو", 2], ["تین", 3], ["چار", 4], ["پانچ", 5], ["چھ", 6], ["سات", 7],
  ["آٹھ", 8], ["نو", 9], ["دس", 10], ["بیس", 20], ["تیس", 30], ["چالیس", 40],
  ["پچاس", 50], ["ساٹھ", 60], ["ستر", 70], ["اسی", 80], ["نوے", 90], ["آدھا", 0.5],
  ["ڈیڑھ", 1.5], ["ڈھائی", 2.5],
]);

const MULT = new Map<string, number>([
  ["sau", 100], ["hundred", 100], ["سو", 100],
  ["hazar", 1000], ["hazaar", 1000], ["thousand", 1000], ["ہزار", 1000],
]);

const UNITS = new Map<string, string>([
  ["kg", "kg"], ["kilo", "kg"], ["کلو", "kg"], ["gram", "g"], ["گرام", "g"],
  ["litre", "L"], ["liter", "L"], ["ltr", "L"], ["لیٹر", "L"],
  ["dozen", "dozen"], ["darjan", "dozen"], ["درجن", "dozen"],
  ["packet", "packet"], ["pack", "packet"], ["پیکٹ", "packet"],
  ["piece", "pc"], ["pieces", "pc"], ["pcs", "pc"], ["adad", "pc"], ["عدد", "pc"],
  ["bottle", "bottle"], ["botal", "bottle"], ["بوتل", "bottle"],
  ["bori", "bori"], ["بوری", "bori"], ["peti", "peti"], ["پیٹی", "peti"],
  ["meter", "m"], ["metre", "m"], ["میٹر", "m"],
]);

const FILLER = new Set<string>([
  "rupay", "rupaye", "rupees", "rupee", "rs", "ka", "ki", "ke", "ko", "hai", "of", "for",
  "at", "per", "price", "rate", "qeemat", "روپے", "روپیہ", "روپے", "کا", "کی", "کے", "کو", "ہے",
]);

const isDigits = (t: string): boolean => /^\d+(\.\d+)?$/.test(t);

function readNumber(tokens: string[], start: number): { value: number; next: number } | null {
  const first = tokens[start];
  if (first === undefined) return null;

  if (isDigits(first)) {
    let value = parseFloat(first);
    let next = start + 1;
    const mult = MULT.get(tokens[next] ?? "");
    if (mult !== undefined) {
      value *= mult;
      next += 1;
      // "2 hazar paanch sau" -> 2000 + 500
      const tail = tokens[next] !== undefined && !isDigits(tokens[next]) ? readNumber(tokens, next) : null;
      if (tail) {
        value += tail.value;
        next = tail.next;
      }
    }
    return { value, next };
  }

  if (!WORD_NUM.has(first) && !MULT.has(first)) return null;

  let total = 0;
  let current = 0;
  let next = start;
  while (next < tokens.length) {
    const t = tokens[next];
    const mult = MULT.get(t);
    const word = WORD_NUM.get(t);
    if (mult !== undefined) {
      if (mult >= 1000) {
        total += (current || 1) * mult;
        current = 0;
      } else {
        current = (current || 1) * mult;
      }
      next += 1;
    } else if (word !== undefined) {
      current += word;
      next += 1;
    } else {
      break;
    }
  }
  return { value: total + current, next };
}

function parseSegment(segment: string): SaleItem | null {
  const tokens = segment.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;

  const nums: { value: number; start: number; end: number }[] = [];
  let i = 0;
  while (i < tokens.length) {
    const r = readNumber(tokens, i);
    if (r) {
      nums.push({ value: r.value, start: i, end: r.next - 1 });
      i = r.next;
    } else {
      i += 1;
    }
  }

  const used = new Set<number>();
  for (const n of nums) for (let k = n.start; k <= n.end; k += 1) used.add(k);

  let unit = "pc";
  let unitIdx = -1;
  for (let k = 0; k < tokens.length; k += 1) {
    const u = UNITS.get(tokens[k]);
    if (u !== undefined) {
      unit = u;
      unitIdx = k;
      break;
    }
  }

  let qty = 1;
  let price = 0;
  if (nums.length >= 2) {
    qty = nums[0].value;
    price = nums[nums.length - 1].value;
  } else if (nums.length === 1) {
    const only = nums[0];
    if (unitIdx === only.end + 1) qty = only.value;
    else price = only.value;
  }

  const nameTokens = tokens.filter((t, idx) => !used.has(idx) && idx !== unitIdx && !FILLER.has(t));
  const rawName = nameTokens.join(" ").trim();
  if (!rawName && nums.length === 0) return null;

  const name = rawName ? rawName.charAt(0).toUpperCase() + rawName.slice(1) : "Item";
  return { name, qty: qty > 0 ? qty : 1, unit, price };
}

/**
 * "2 kilo chawal 150, ek dozen anday 300 aur 1 packet chai 500"
 * -> 3 items. Number order: first number = quantity, last number = rate per unit.
 * Works with Roman Urdu, English and Urdu script (ur-PK speech results).
 */
export function parseSpokenItems(text: string): SaleItem[] {
  const normalized = text
    .toLowerCase()
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/(\d),(?=\d{3}\b)/g, "$1")
    .replace(/\.(?!\d)/g, " ");

  const segments = normalized.split(/[,;\n،]|\s(?:aur|and|phir|then|اور|پھر)\s/);
  const items: SaleItem[] = [];
  for (const seg of segments) {
    const item = parseSegment(seg.trim());
    if (item) items.push(item);
  }
  return items;
}
