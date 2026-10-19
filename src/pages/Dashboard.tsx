import { useCallback, useEffect, useMemo, useState } from "react";
import { onAuthStateChanged, signOut } from "firebase/auth";
import type { User } from "firebase/auth";
import { useNavigate } from "react-router-dom";
import { collection, onSnapshot, query, where } from "firebase/firestore";
import type { DocumentData } from "firebase/firestore";
import { auth, db } from "../firebase";
import "../styles/munshi.css";
import Sidebar from "../components/Sidebar";
import NewSaleModal from "../components/NewSaleModal";
import type { CustomerOption } from "../components/NewSaleModal";
import ReceiptModal from "../components/ReceiptModal";
import ReceivePaymentModal from "../components/ReceivePaymentModal";
import AddExpenseModal from "../components/AddExpenseModal";
import { ArrowDownIcon, ArrowUpIcon, ChatIcon, PlusIcon } from "../components/Icons";
import {
  ESTIMATED_MARGIN,
  buildReminderText,
  formatRs,
  getShopName,
  parseItems,
  round2,
  waLink,
} from "../lib/Sales";
import type { SaleItem, SavedSale } from "../lib/Sales";

/* ------------------------------------------------------------------ */
/* Types and parsing                                                   */
/* ------------------------------------------------------------------ */

type Tx = {
  id: string;
  amount: number;
  type: "GAVE" | "GOT";
  createdAt: Date;
  customerId: string | null;
  customerName: string;
  items: SaleItem[];
  receiptNo: string | null;
  paid: number;
  source: string | null;
  profit: number | null;
  profitEstimated: boolean;
  note: string;
};

type Expense = { id: string; amount: number; category: string; note: string; createdAt: Date };

type Activity = {
  id: string;
  kind: "sale" | "payment" | "expense";
  date: Date;
  title: string;
  sub: string;
  amount: number;
  tx: Tx | null;
};

type Range = "today" | "7" | "30" | "all";

const RANGES: { key: Range; label: string; days: number | null; title: string; prev: string }[] = [
  { key: "today", label: "Today", days: 1, title: "today", prev: "yesterday" },
  { key: "7", label: "7 days", days: 7, title: "in the last 7 days", prev: "the previous 7 days" },
  { key: "30", label: "30 days", days: 30, title: "in the last 30 days", prev: "the previous 30 days" },
  { key: "all", label: "All time", days: null, title: "of all time", prev: "" },
];

const EMPTY_TX: Tx[] = [];
const EMPTY_EXPENSES: Expense[] = [];
const EMPTY_CUSTOMERS: CustomerOption[] = [];

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

// A document that was just written has no server timestamp yet: treat it as "now".
const toDate = (v: unknown): Date => {
  const ts = v as { toDate?: () => Date } | null | undefined;
  return ts && typeof ts.toDate === "function" ? ts.toDate() : new Date();
};

function toCustomer(id: string, d: DocumentData): CustomerOption {
  const name =
    (typeof d.name === "string" && d.name) || (typeof d.customerName === "string" && d.customerName) || "Customer";
  const phoneRaw = d.phone ?? d.phoneNumber ?? d.mobile;
  return {
    id,
    name,
    phone: typeof phoneRaw === "string" && phoneRaw ? phoneRaw : null,
    totalBalance: num(d.totalBalance),
  };
}

function toTx(id: string, d: DocumentData): Tx {
  return {
    id,
    amount: num(d.amount),
    type: d.type === "GOT" ? "GOT" : "GAVE",
    createdAt: toDate(d.createdAt),
    customerId: typeof d.customerId === "string" ? d.customerId : null,
    customerName: typeof d.customerName === "string" && d.customerName ? d.customerName : "Customer",
    items: parseItems(d.items),
    receiptNo: typeof d.receiptNo === "string" ? d.receiptNo : null,
    paid: num(d.paid),
    source: typeof d.source === "string" ? d.source : null,
    profit: d.profit === undefined || d.profit === null ? null : num(d.profit),
    profitEstimated: d.profitEstimated === true,
    note: typeof d.note === "string" ? d.note : "",
  };
}

function toExpense(id: string, d: DocumentData): Expense {
  return {
    id,
    amount: num(d.amount),
    category: typeof d.category === "string" && d.category ? d.category : "Other",
    note: typeof d.note === "string" ? d.note : "",
    createdAt: toDate(d.createdAt),
  };
}

/* ------------------------------------------------------------------ */
/* Date helpers                                                        */
/* ------------------------------------------------------------------ */

function startOfDay(ms: number, back = 0): Date {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - back);
  return d;
}

const dayKey = (d: Date): string => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

const daysBetween = (later: number, earlier: Date): number =>
  Math.round((startOfDay(later).getTime() - startOfDay(earlier.getTime()).getTime()) / 86400000);

const agoLabel = (days: number): string => (days <= 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`);

const shortDate = (d: Date): string =>
  `${d.toLocaleDateString("en-PK", { day: "numeric", month: "short" })}, ${d.toLocaleTimeString("en-PK", {
    hour: "numeric",
    minute: "2-digit",
  })}`;

const rs = (n: number): string => round2(n).toLocaleString("en-PK");

/* ------------------------------------------------------------------ */
/* Aggregation                                                         */
/* ------------------------------------------------------------------ */

type Summary = {
  sales: number;
  bills: number;
  cash: number;
  credit: number;
  expenses: number;
  profit: number;
  estimated: boolean;
  topItems: { name: string; unit: string; qty: number; revenue: number }[];
};

function summarise(txs: Tx[], expenses: Expense[], from: number, to: number): Summary {
  const within = (d: Date) => {
    const t = d.getTime();
    return t >= from && t < to;
  };

  const list = txs.filter((t) => within(t.createdAt));
  const sales = list.filter((t) => t.type === "GAVE");

  let gross = 0;
  let estimated = false;
  for (const t of sales) {
    if (t.profit !== null) {
      gross += t.profit;
      if (t.profitEstimated) estimated = true;
    } else {
      gross += t.amount * ESTIMATED_MARGIN;
      estimated = true;
    }
  }

  const spent = expenses.filter((e) => within(e.createdAt)).reduce((s, e) => s + e.amount, 0);

  const itemMap = new Map<string, { name: string; unit: string; qty: number; revenue: number }>();
  for (const t of sales) {
    for (const it of t.items) {
      const key = `${it.name.toLowerCase()}|${it.unit}`;
      const cur = itemMap.get(key) ?? { name: it.name, unit: it.unit, qty: 0, revenue: 0 };
      cur.qty += it.qty;
      cur.revenue += it.qty * it.price;
      itemMap.set(key, cur);
    }
  }

  return {
    sales: round2(sales.reduce((s, t) => s + t.amount, 0)),
    bills: sales.length,
    cash: round2(list.filter((t) => t.type === "GOT").reduce((s, t) => s + t.amount, 0)),
    credit: round2(sales.reduce((s, t) => s + Math.max(0, t.amount - t.paid), 0)),
    expenses: round2(spent),
    profit: Math.round(gross - spent),
    estimated,
    topItems: [...itemMap.values()].sort((a, b) => b.revenue - a.revenue).slice(0, 5),
  };
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

export default function Dashboard() {
  const [uid, setUid] = useState<string | null | undefined>(undefined);
  const [customers, setCustomers] = useState<CustomerOption[] | null>(null);
  const [txs, setTxs] = useState<Tx[] | null>(null);
  const [expenses, setExpenses] = useState<Expense[]>(EMPTY_EXPENSES);
  const [expensesBlocked, setExpensesBlocked] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const navigate = useNavigate();

  const [range, setRange] = useState<Range>("today");
  const [now, setNow] = useState(() => Date.now());
  const [sel, setSel] = useState(6);

  const [saleOpen, setSaleOpen] = useState(false);
  const [pay, setPay] = useState<{ customerId: string } | null>(null);
  const [expenseOpen, setExpenseOpen] = useState(false);
  const [receipt, setReceipt] = useState<SavedSale | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // Keep "today" correct if the page stays open past midnight.
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), 3500);
    return () => window.clearTimeout(id);
  }, [toast]);

  const handleLogout = async () => {
    try {
      await signOut(auth);
      navigate("/login");
    } catch (err) {
      console.error("Logout Error:", err);
    }
  };

  // Wait for Firebase Auth instead of reading auth.currentUser once (it can be null on first render).
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      setUid(u ? u.uid : null);
      setUser(u ?? null);
      if (!u) {
        setCustomers([]);
        setTxs([]);
      }
    });
    return unsub;
  }, []);

  useEffect(() => {
    if (!uid) return;

    const onError = (err: unknown) => {
      console.error("Dashboard load error:", err);
      setLoadError("Could not load your data. Check your internet connection and Firestore rules.");
    };

    const unsubCustomers = onSnapshot(
      query(collection(db, "customers"), where("userId", "==", uid)),
      (snap) => {
        setCustomers(snap.docs.map((d) => toCustomer(d.id, d.data())));
        setLoadError(null);
      },
      onError
    );

    const unsubTx = onSnapshot(
      query(collection(db, "transactions"), where("userId", "==", uid)),
      (snap) => {
        const list = snap.docs.map((d) => toTx(d.id, d.data()));
        list.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        setTxs(list);
        setLoadError(null);
      },
      onError
    );

    // Expenses are optional: if the rules are not published yet, the rest of the page still works.
    const unsubExpenses = onSnapshot(
      query(collection(db, "expenses"), where("userId", "==", uid)),
      (snap) => {
        setExpenses(snap.docs.map((d) => toExpense(d.id, d.data())));
        setExpensesBlocked(false);
      },
      (err) => {
        console.error("Expenses load error:", err);
        setExpensesBlocked(true);
      }
    );

    return () => {
      unsubCustomers();
      unsubTx();
      unsubExpenses();
    };
  }, [uid]);

  const customerList = customers ?? EMPTY_CUSTOMERS;
  const txList = txs ?? EMPTY_TX;
  const cfg = RANGES.find((r) => r.key === range) ?? RANGES[0];

  const from = cfg.days === null ? 0 : startOfDay(now, cfg.days - 1).getTime();
  const prevFrom = cfg.days === null ? null : startOfDay(now, cfg.days * 2 - 1).getTime();

  const stats = useMemo(
    () => summarise(txList, expenses, from, Number.POSITIVE_INFINITY),
    [txList, expenses, from]
  );

  const prevSales = useMemo(
    () => (prevFrom === null ? null : summarise(txList, EMPTY_EXPENSES, prevFrom, from).sales),
    [txList, prevFrom, from]
  );
  const delta = prevSales !== null && prevSales > 0 ? Math.round(((stats.sales - prevSales) / prevSales) * 100) : null;

  const week = useMemo(() => {
    const days = Array.from({ length: 7 }, (_, i) => {
      const d = startOfDay(now, 6 - i);
      return {
        key: dayKey(d),
        label: i === 6 ? "Today" : d.toLocaleDateString("en-PK", { weekday: "short" }),
        long: d.toLocaleDateString("en-PK", { weekday: "long", day: "numeric", month: "short" }),
        amount: 0,
      };
    });
    for (const t of txList) {
      if (t.type !== "GAVE") continue;
      const slot = days.find((d) => d.key === dayKey(t.createdAt));
      if (slot) slot.amount += t.amount;
    }
    return days.map((d) => ({ ...d, amount: round2(d.amount) }));
  }, [txList, now]);
  const weekMax = Math.max(...week.map((d) => d.amount), 0);
  const selDay = week[Math.min(sel, week.length - 1)];

  const lastSeen = useMemo(() => {
    const m = new Map<string, Date>();
    for (const t of txList) {
      const key = t.customerId ?? t.customerName;
      if (!m.has(key)) m.set(key, t.createdAt);
    }
    return m;
  }, [txList]);

  const debtors = useMemo(() => {
    return customerList
      .filter((c) => c.totalBalance > 0)
      .sort((a, b) => b.totalBalance - a.totalBalance)
      .map((c) => {
        const a = lastSeen.get(c.id);
        const b = lastSeen.get(c.name);
        const last = a && b ? (a > b ? a : b) : (a ?? b ?? null);
        return { customer: c, days: last ? daysBetween(now, last) : null };
      });
  }, [customerList, lastSeen, now]);

  const toReceive = debtors.reduce((s, d) => s + d.customer.totalBalance, 0);
  const toPay = customerList.filter((c) => c.totalBalance < 0).reduce((s, c) => s + Math.abs(c.totalBalance), 0);
  const maxDebt = debtors.length > 0 ? debtors[0].customer.totalBalance : 0;
  const stale = debtors.filter((d) => d.days === null || d.days >= 7);
  const staleTotal = stale.reduce((s, d) => s + d.customer.totalBalance, 0);
  const topItemMax = stats.topItems.length > 0 ? stats.topItems[0].revenue : 0;

  const activity = useMemo<Activity[]>(() => {
    const rows: Activity[] = [];
    for (const t of txList) {
      if (t.source === "sale-payment") continue;
      if (t.type === "GAVE") {
        const names = t.items.slice(0, 2).map((i) => i.name).join(", ");
        const more = t.items.length > 2 ? ` +${t.items.length - 2} more` : "";
        const due = Math.max(0, t.amount - t.paid);
        const base = t.items.length > 0 ? `${names}${more}` : "Credit given";
        rows.push({
          id: t.id,
          kind: "sale",
          date: t.createdAt,
          title: t.customerName,
          sub: due > 0 && t.paid > 0 ? `${base}, ${formatRs(due)} due` : base,
          amount: t.amount,
          tx: t,
        });
      } else {
        rows.push({
          id: t.id,
          kind: "payment",
          date: t.createdAt,
          title: t.customerName,
          sub: t.note || "Payment received",
          amount: t.amount,
          tx: t,
        });
      }
    }
    for (const e of expenses) {
      rows.push({
        id: `exp-${e.id}`,
        kind: "expense",
        date: e.createdAt,
        title: e.category,
        sub: e.note || "Expense",
        amount: e.amount,
        tx: null,
      });
    }
    return rows.sort((a, b) => b.date.getTime() - a.date.getTime()).slice(0, 10);
  }, [txList, expenses]);

  const insight = (() => {
    if (txList.length === 0 && debtors.length === 0) {
      return { head: "Nothing recorded yet.", body: "Create your first sale and this page will start tracking sales, collections and profit." };
    }
    if (stale.length > 0) {
      return {
        head: stale.length === 1 ? "1 overdue balance." : `${stale.length} overdue balances.`,
        body: `${formatRs(staleTotal)} is owed by customers with no activity for 7 days or more. Send a reminder from the list below.`,
      };
    }
    if (debtors.length > 0) {
      return {
        head: "Collections.",
        body: `${formatRs(toReceive)} to collect from ${debtors.length} ${debtors.length === 1 ? "customer" : "customers"}, all with recent activity.`,
      };
    }
    return { head: "All settled.", body: "No customer owes you anything right now." };
  })();

  const openReceipt = useCallback(
    (t: Tx) => {
      const phone =
        customerList.find((c) => (t.customerId ? c.id === t.customerId : c.name === t.customerName))?.phone ?? null;
      setReceipt({
        receiptNo: t.receiptNo ?? t.id.slice(0, 8).toUpperCase(),
        createdAt: t.createdAt,
        customerName: t.customerName,
        customerPhone: phone,
        items: t.items,
        total: t.amount,
        paid: t.paid,
        balanceDue: round2(Math.max(0, t.amount - t.paid)),
        profit: t.profit ?? 0,
        profitEstimated: t.profitEstimated,
        note: t.note,
      });
    },
    [customerList]
  );

  const loading = uid === undefined || (uid !== null && (customers === null || txs === null));

  if (loading && !loadError) {
    return (
      <div className="mn mn-page">
        <div className="mn-sheet" aria-busy="true" aria-label="Loading">
          <div className="mn-skel" style={{ height: 30, width: 200 }} />
          <div className="mn-skel" style={{ height: 14, width: 140, marginTop: 10 }} />
          <div className="mn-skel" style={{ height: 64, width: 260, marginTop: 36 }} />
          <div className="mn-skel" style={{ height: 160, marginTop: 28 }} />
        </div>
      </div>
    );
  }

  if (loadError && (customers === null || txs === null)) {
    return (
      <div className="mn mn-page">
        <div className="mn-sheet">
          <h1 className="mn-title">Shop summary</h1>
          <p className="mn-error" role="alert" style={{ marginTop: 12 }}>
            {loadError}
          </p>
        </div>
      </div>
    );
  }

  const shop = getShopName();
  const todayLabel = new Date(now).toLocaleDateString("en-PK", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  return (
    <>
      {/* Header (Home wala hi: logo + hamburger) */}
      <header className="bg-white border-b border-slate-100 shadow-sm shadow-slate-200/40 sticky top-0 z-10">
        <div className="max-w-3xl mx-auto px-4 h-14 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 shrink-0 rounded-xl overflow-hidden flex items-center justify-center">
              <img
                src="/favicon.png"
                alt="Munshi AI"
                className="w-full h-full object-contain"
              />
            </div>

            <div className="leading-tight">
              <h1 className="text-sm font-bold text-slate-900">Munshi AI</h1>
              <p className="text-[11px] text-slate-500">Digital Khata</p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {user?.email && (
              <span className="hidden sm:block text-xs text-slate-500 max-w-45 truncate">
                {user.email}
              </span>
            )}

            <button
              onClick={() => setIsSidebarOpen(true)}
              aria-label="Open menu"
              className="w-10 h-10 flex items-center justify-center rounded-xl border border-slate-200 bg-white hover:bg-slate-50 transition"
            >
              <span className="sr-only">Open menu</span>
              <div className="flex flex-col justify-center gap-1">
                <span className="block w-5 h-0.5 bg-slate-700" />
                <span className="block w-5 h-0.5 bg-slate-700" />
                <span className="block w-5 h-0.5 bg-slate-700" />
              </div>
            </button>
          </div>
        </div>
      </header>

      <Sidebar
        open={isSidebarOpen}
        onClose={() => setIsSidebarOpen(false)}
        onNavigate={(path) => navigate(path)}
        onLogout={handleLogout}
        userEmail={user?.email ?? null}
        userPhone={user?.phoneNumber ?? null}
        userPhotoUrl={user?.photoURL ?? null}
        userDisplayName={user?.displayName ?? null}
      />

      <div className="mn mn-page">
      <div className="mn-sheet">
        <header className="mn-head">
          <div>
            <h1 className="mn-title">{shop === "My Shop" ? "Shop summary" : shop}</h1>
            <p className="mn-sub">{todayLabel}</p>
          </div>
          <div className="mn-head-actions">
            <button type="button" className="mn-btn mn-btn-primary" onClick={() => setSaleOpen(true)} disabled={!uid}>
              <PlusIcon size={16} /> New sale
            </button>
            <button type="button" className="mn-btn" onClick={() => setPay({ customerId: "" })} disabled={!uid}>
              Receive payment
            </button>
            <button type="button" className="mn-btn" onClick={() => setExpenseOpen(true)} disabled={!uid}>
              Add expense
            </button>
          </div>
        </header>

        {loadError && (
          <p className="mn-error" role="alert" style={{ marginTop: 16 }}>
            {loadError}
          </p>
        )}

        <div className="mn-toolbar">
          <div className="mn-seg" role="group" aria-label="Time period">
            {RANGES.map((r) => (
              <button key={r.key} type="button" aria-pressed={range === r.key} onClick={() => setRange(r.key)}>
                {r.label}
              </button>
            ))}
          </div>
        </div>

        {/* Hero: the one number a shopkeeper checks first, then the books behind it */}
        <section className="mn-hero" aria-label="Sales summary">
          <div>
            <p className="mn-label">Sales {cfg.title}</p>
            <p className="mn-figure mn-num">
              <small>Rs.</small>
              {rs(stats.sales)}
            </p>
            {delta !== null && (
              <span className="mn-delta" data-dir={delta > 0 ? "up" : delta < 0 ? "down" : "flat"}>
                {delta > 0 ? <ArrowUpIcon size={14} /> : delta < 0 ? <ArrowDownIcon size={14} /> : null}
                {delta === 0
                  ? `No change vs ${cfg.prev}`
                  : `${Math.abs(delta) > 500 ? "500%+" : `${Math.abs(delta)}%`} vs ${cfg.prev}`}
              </span>
            )}

            <ul className="mn-ledger">
              <li>
                <span className="mn-key">Bills issued</span>
                <span className="mn-lead" aria-hidden="true" />
                <span className="mn-val mn-num">{stats.bills}</span>
              </li>
              <li>
                <span className="mn-key">Cash received</span>
                <span className="mn-lead" aria-hidden="true" />
                <span className="mn-val mn-num" data-tone="good">
                  {formatRs(stats.cash)}
                </span>
              </li>
              <li>
                <span className="mn-key">Sold on credit</span>
                <span className="mn-lead" aria-hidden="true" />
                <span className="mn-val mn-num" data-tone="warn">
                  {formatRs(stats.credit)}
                </span>
              </li>
              <li>
                <span className="mn-key">Expenses</span>
                <span className="mn-lead" aria-hidden="true" />
                <span className="mn-val mn-num">{expensesBlocked ? "Unavailable" : formatRs(stats.expenses)}</span>
              </li>
              <li>
                <span className="mn-key">
                  Net profit {stats.estimated && <em>(estimated)</em>}
                </span>
                <span className="mn-lead" aria-hidden="true" />
                <span className="mn-val mn-num">{formatRs(stats.profit)}</span>
              </li>
            </ul>
            {expensesBlocked && (
              <p className="mn-error" style={{ marginTop: 8 }}>
                Expenses cannot load yet. Publish the updated Firestore rules.
              </p>
            )}
          </div>

          <div>
            <h2 className="mn-h">Sales, last 7 days</h2>
            <div className="mn-chart-head">
              <p className="mn-chart-date">{selDay.long}</p>
              <p className="mn-chart-value mn-num">{formatRs(selDay.amount)}</p>
            </div>
            <div className="mn-chart" role="group" aria-label="Sales for the last 7 days">
              {week.map((d, i) => (
                <button
                  key={d.key}
                  type="button"
                  className="mn-bar-col"
                  data-active={i === sel}
                  aria-pressed={i === sel}
                  aria-label={`${d.long}: ${formatRs(d.amount)}`}
                  onClick={() => setSel(i)}
                >
                  <span
                    className="mn-bar"
                    style={{
                      height: d.amount > 0 && weekMax > 0 ? `${Math.max(4, Math.round((d.amount / weekMax) * 100))}%` : "2px",
                    }}
                  />
                </button>
              ))}
            </div>
            <div className="mn-axis" aria-hidden="true">
              {week.map((d) => (
                <span key={d.key}>{d.label}</span>
              ))}
            </div>
            <details className="mn-table-view">
              <summary>View as table</summary>
              <table>
                <thead>
                  <tr>
                    <th scope="col">Day</th>
                    <th scope="col">Sales</th>
                  </tr>
                </thead>
                <tbody>
                  {week.map((d) => (
                    <tr key={d.key}>
                      <td>{d.long}</td>
                      <td className="mn-num">{formatRs(d.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          </div>
        </section>

        {/* Balances */}
        <section className="mn-section" aria-label="Balances">
          <div className="mn-strip">
            <div>
              <p className="mn-label">To collect</p>
              <p className="mn-strip-figure mn-num">{formatRs(toReceive)}</p>
              <p className="mn-strip-note">
                {debtors.length === 0
                  ? "No customer owes you"
                  : `${debtors.length} ${debtors.length === 1 ? "customer owes" : "customers owe"} you`}
              </p>
            </div>
            <div>
              <p className="mn-label">Cash received {cfg.title}</p>
              <p className="mn-strip-figure mn-num">{formatRs(stats.cash)}</p>
              <p className="mn-strip-note">Includes payments on old balances</p>
            </div>
            <div>
              <p className="mn-label">You owe</p>
              <p className="mn-strip-figure mn-num">{formatRs(toPay)}</p>
              <p className="mn-strip-note">Customer advances and supplier balances</p>
            </div>
          </div>
        </section>

        <section className="mn-section" aria-label="Collections note">
          <p className="mn-note">
            <strong>{insight.head}</strong> {insight.body}
          </p>
        </section>

        {/* Collections and top items */}
        <section className="mn-section">
          <div className="mn-cols">
            <div>
              <h2 className="mn-h">Who owes you</h2>
              <p className="mn-hsub">Largest balances first</p>
              {debtors.length === 0 ? (
                <div className="mn-empty">
                  <strong>Nothing to collect.</strong>
                  Every customer account is settled.
                </div>
              ) : (
                <ul className="mn-list">
                  {debtors.slice(0, 6).map(({ customer: c, days }) => (
                    <li key={c.id}>
                      <div className="mn-row">
                        <div className="mn-row-main">
                          <span className="mn-avatar" aria-hidden="true">
                            {c.name.charAt(0).toUpperCase()}
                          </span>
                          <div style={{ minWidth: 0 }}>
                            <p className="mn-name">{c.name}</p>
                            <p className="mn-small">
                              {days === null ? "No activity recorded" : `Last activity ${agoLabel(days)}`}
                            </p>
                          </div>
                        </div>
                        <span className="mn-amount mn-num">{formatRs(c.totalBalance)}</span>
                      </div>
                      <div className="mn-meter" aria-hidden="true">
                        <i style={{ width: `${maxDebt > 0 ? Math.max(4, Math.round((c.totalBalance / maxDebt) * 100)) : 0}%` }} />
                      </div>
                      <div className="mn-row-actions">
                        <a
                          className="mn-btn mn-btn-sm"
                          href={waLink(c.phone, buildReminderText(c.name, c.totalBalance, shop))}
                          target="_blank"
                          rel="noopener noreferrer"
                          aria-label={`Send WhatsApp reminder to ${c.name}`}
                        >
                          <ChatIcon size={14} /> Remind
                        </a>
                        <button type="button" className="mn-btn mn-btn-sm" onClick={() => setPay({ customerId: c.id })}>
                          Receive payment
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div>
              <h2 className="mn-h">Top items</h2>
              <p className="mn-hsub">By sales value {cfg.title}</p>
              {stats.topItems.length === 0 ? (
                <div className="mn-empty">
                  <strong>No item sales yet.</strong>
                  Items appear here once you record bills with items.
                </div>
              ) : (
                <ul className="mn-list">
                  {stats.topItems.map((it) => (
                    <li key={`${it.name}-${it.unit}`}>
                      <div className="mn-row">
                        <div style={{ minWidth: 0 }}>
                          <p className="mn-name">{it.name}</p>
                          <p className="mn-small mn-num">
                            {round2(it.qty)} {it.unit} sold
                          </p>
                        </div>
                        <span className="mn-amount mn-num">{formatRs(it.revenue)}</span>
                      </div>
                      <div className="mn-meter" aria-hidden="true">
                        <i style={{ width: `${topItemMax > 0 ? Math.max(4, Math.round((it.revenue / topItemMax) * 100)) : 0}%` }} />
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </section>

        {/* Recent activity */}
        <section className="mn-section">
          <h2 className="mn-h">Recent activity</h2>
          <p className="mn-hsub">Bills, payments and expenses</p>
          {activity.length === 0 ? (
            <div className="mn-empty">
              <strong>No activity yet.</strong>
              Create your first bill with New sale.
            </div>
          ) : (
            <ul className="mn-bills">
              {activity.map((a) => (
                <li key={a.id} className="mn-bill">
                  <span className="mn-bill-date">{shortDate(a.date)}</span>
                  <div style={{ minWidth: 0 }}>
                    <p className="mn-name">{a.title}</p>
                    <p className="mn-small">{a.sub}</p>
                  </div>
                  <span className="mn-bill-amount mn-num" data-type={a.kind === "payment" ? "GOT" : a.kind}>
                    {a.kind === "payment" ? "+ " : a.kind === "expense" ? "- " : ""}
                    {formatRs(a.amount)}
                  </span>
                  {a.kind === "sale" && a.tx && a.tx.items.length > 0 ? (
                    <button type="button" className="mn-bill-link" onClick={() => a.tx && openReceipt(a.tx)}>
                      View receipt
                    </button>
                  ) : (
                    <span />
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {saleOpen && uid && (
        <NewSaleModal
          userId={uid}
          customers={customerList}
          onClose={() => setSaleOpen(false)}
          onSaved={(sale) => {
            setSaleOpen(false);
            setReceipt(sale);
          }}
        />
      )}

      {pay && uid && (
        <ReceivePaymentModal
          userId={uid}
          customers={customerList}
          initialCustomerId={pay.customerId}
          onClose={() => setPay(null)}
          onSaved={(message) => {
            setPay(null);
            setToast(message);
          }}
        />
      )}

      {expenseOpen && uid && (
        <AddExpenseModal
          userId={uid}
          onClose={() => setExpenseOpen(false)}
          onSaved={(message) => {
            setExpenseOpen(false);
            setToast(message);
          }}
        />
      )}

      {receipt && <ReceiptModal sale={receipt} onClose={() => setReceipt(null)} />}

      {toast && (
        <div className="mn-toast" role="status">
          {toast}
        </div>
      )}
      </div>
    </>
  );
}
