// NOTE: This is your Home.tsx with sidebar/hamburger integrated.
// I kept your original code intact and only added the sidebar state/import and replaced
// the header logout button with a hamburger button that opens the sidebar.

import React, { useState, useEffect, useMemo, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { auth, db } from "../firebase";
import { signOut, onAuthStateChanged } from "firebase/auth";
import type { User } from "firebase/auth";
import {
  collection,
  query,
  where,
  onSnapshot,
  serverTimestamp,
  doc,
  increment,
  writeBatch,
} from "firebase/firestore";
import type { Timestamp } from "firebase/firestore";
import VoiceEntry from "../components/VoiceEntry";
import Sidebar from "../components/Sidebar";
import {
  buildEntryMessage,
  makeNotice,
  openWhatsApp,
  whatsappUrl,
} from "../utils/whatsapp";
import type { SavedNotice } from "../utils/whatsapp";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

interface Customer {
  id: string;
  name: string;
  phone: string;
  totalBalance: number; // Positive = Lene hain, Negative = Dene hain
}

type TxType = "GAVE" | "GOT";

interface Transaction {
  id: string;
  amount: number;
  type: TxType;
  createdAt: Timestamp | null; // serverTimestamp pending ho to null
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const fmt = (n: number) => `Rs. ${Math.abs(n).toLocaleString()}`;

// Duplicate check ke liye: extra spaces aur capital/small ka farq ignore
const normName = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
const digitsOnly = (s: string) => s.replace(/\D/g, "");

function balanceInfo(balance: number) {
  if (balance > 0)
    return { label: "Aapne lene hain", text: "text-emerald-700" };
  if (balance < 0) return { label: "Aapne dene hain", text: "text-red-600" };
  return { label: "Hisaab barabar", text: "text-slate-500" };
}

function txTime(createdAt: Timestamp | null) {
  if (!createdAt) return "Just now";
  return createdAt.toDate().toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/* ------------------------------------------------------------------ */
/* Theme (sab colors/styles yahan se control hote hain)                */
/* ------------------------------------------------------------------ */

const cardCls =
  "bg-white border border-slate-100 rounded-2xl shadow-sm shadow-slate-200/60";

const inputCls =
  "w-full h-10 bg-slate-50/60 border border-slate-200 rounded-xl px-3.5 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:bg-white focus:border-emerald-500 focus:ring-4 focus:ring-emerald-500/10 transition";

const primaryBtn =
  "h-10 px-4 bg-emerald-600 hover:bg-emerald-700 active:scale-[0.98] text-white text-sm font-semibold rounded-xl shadow-sm shadow-emerald-600/20 transition";

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

export default function Home() {
  const navigate = useNavigate();

  // Sidebar state (NEW)
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);

  // Auth (auth.currentUser refresh par pehle null hota hai, isliye listener)
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);

  // Internet hai ya nahi (offline patti aur mic ke liye)
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);

  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState("");
  const [search, setSearch] = useState("");
  // Upar ke cards dabane par list sirf "lene wale" ya "dene wale" dikhaye
  const [balanceFilter, setBalanceFilter] = useState<"ALL" | "LENE" | "DENE">(
    "ALL",
  );
  const listRef = useRef<HTMLElement | null>(null);

  // Selected customer sirf ID rakhi hai, taake balance hamesha live rahe
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Transactions ke saath customer ki ID, taake customer badalne par purani list na dikhe
  const [txState, setTxState] = useState<{
    customerId: string;
    list: Transaction[];
  }>({
    customerId: "",
    list: [],
  });
  const transactions = useMemo(
    () => (txState.customerId === selectedId ? txState.list : []),
    [txState.customerId, txState.list, selectedId],
  );

  // Modals
  const [isCustomerModalOpen, setIsCustomerModalOpen] = useState(false);
  const [isTxModalOpen, setIsTxModalOpen] = useState(false);

  // Form
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [amount, setAmount] = useState("");
  const [txType, setTxType] = useState<TxType>("GAVE");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formError, setFormError] = useState("");

  const selectedCustomer = useMemo(
    () => customers.find((c) => c.id === selectedId) || null,
    [customers, selectedId],
  );

  // Entry save hone ke baad "WhatsApp par bhejein" notice
  const [notice, setNotice] = useState<SavedNotice | null>(null);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 15000);
    return () => clearTimeout(t);
  }, [notice]);

  // Har transaction ke BAAD customer ka balance kya tha (WhatsApp message ke liye)
  const balanceAfterTx = useMemo(() => {
    const map: Record<string, number> = {};
    if (!selectedCustomer) return map;
    let running = selectedCustomer.totalBalance;
    for (const tx of transactions) {
      map[tx.id] = running;
      running -= tx.type === "GAVE" ? tx.amount : -tx.amount;
    }
    return map;
  }, [selectedCustomer, transactions]);

  // 1. Auth listener
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setAuthReady(true);
      if (!u) navigate("/login");
    });
    return () => unsub();
  }, [navigate]);

  // 2. Customers (real-time)
  useEffect(() => {
    if (!user) return;

    const q = query(
      collection(db, "customers"),
      where("userId", "==", user.uid),
    );
    const unsub = onSnapshot(
      q,
      (snap) => {
        const list: Customer[] = snap.docs.map((d) => ({
          id: d.id,
          name: d.data().name || "",
          phone: d.data().phone || "",
          totalBalance: d.data().totalBalance || 0,
        }));
        list.sort((a, b) => a.name.localeCompare(b.name));
        setCustomers(list);
        setFetchError("");
        setLoading(false);
      },
      (err) => {
        console.error("Customers fetch error:", err);
        setFetchError("Data load nahi ho saka. Internet check karein.");
        setLoading(false);
      },
    );
    return () => unsub();
  }, [user]);

  // 3. Transactions of selected customer (sorting client par, taake index na chahiye)
  useEffect(() => {
    if (!user || !selectedId) return;

    const q = query(
      collection(db, "transactions"),
      where("userId", "==", user.uid),
      where("customerId", "==", selectedId),
    );
    const unsub = onSnapshot(
      q,
      (snap) => {
        const list: Transaction[] = snap.docs.map((d) => ({
          id: d.id,
          amount: d.data().amount,
          type: d.data().type,
          createdAt: d.data().createdAt,
        }));
        // Pending (null) timestamp sabse upar
        const ms = (t: Transaction) =>
          t.createdAt ? t.createdAt.toMillis() : Number.MAX_SAFE_INTEGER;
        list.sort((a, b) => ms(b) - ms(a));
        setTxState({ customerId: selectedId, list });
      },
      (err) => console.error("Transactions fetch error:", err),
    );
    return () => unsub();
  }, [user, selectedId]);

  const filteredCustomers = useMemo(() => {
    const s = search.trim().toLowerCase();
    return customers.filter((c) => {
      if (balanceFilter === "LENE" && !(c.totalBalance > 0)) return false;
      if (balanceFilter === "DENE" && !(c.totalBalance < 0)) return false;
      return !s || c.name.toLowerCase().includes(s) || c.phone.includes(s);
    });
  }, [customers, search, balanceFilter]);

  // Naya customer add karte waqt: same naam ya same phone ka khata pehle se hai?
  const duplicateCustomer = useMemo(() => {
    if (!isCustomerModalOpen) return null;
    const n = normName(customerName);
    const p = digitsOnly(customerPhone);
    if (!n && p.length < 7) return null;
    return (
      customers.find(
        (c) =>
          (n && normName(c.name) === n) ||
          (p.length >= 7 && digitsOnly(c.phone) === p),
      ) || null
    );
  }, [isCustomerModalOpen, customers, customerName, customerPhone]);

  const totalLeneHain = customers
    .filter((c) => c.totalBalance > 0)
    .reduce((acc, c) => acc + c.totalBalance, 0);

  const totalDeneHain = customers
    .filter((c) => c.totalBalance < 0)
    .reduce((acc, c) => acc + Math.abs(c.totalBalance), 0);

  // const netBalance = totalLeneHain - totalDeneHain;

  const leneCount = customers.filter((c) => c.totalBalance > 0).length;
  const deneCount = customers.filter((c) => c.totalBalance < 0).length;

  // Card dabane par filter lagta hai, dobara dabane par hat jata hai
  const toggleFilter = (f: "LENE" | "DENE") => {
    const next = balanceFilter === f ? "ALL" : f;
    setBalanceFilter(next);
    if (next !== "ALL") {
      listRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  };

  /* ---------------- Form helpers ---------------- */

  const resetForm = () => {
    setCustomerName("");
    setCustomerPhone("");
    setAmount("");
    setTxType("GAVE");
    setFormError("");
  };

  const openCustomerModal = () => {
    resetForm();
    setIsCustomerModalOpen(true);
  };

  const openTxModal = () => {
    resetForm();
    setIsTxModalOpen(true);
  };

  const closeModals = () => {
    if (isSubmitting) return;
    setIsCustomerModalOpen(false);
    setIsTxModalOpen(false);
    resetForm();
  };

  const parseAmount = () => {
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) return null;
    return Math.round(n * 100) / 100;
  };

  /* ---------------- Actions ---------------- */

  // Naya customer + pehli transaction ek hi batch me (dono ya koi nahi)
  const handleAddCustomer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || isSubmitting) return;

    const name = customerName.trim();
    const numAmount = parseAmount();
    if (!name) return setFormError("Customer ka naam likhein.");
    if (numAmount === null) return setFormError("Sahi amount likhein.");

    setIsSubmitting(true);
    setFormError("");
    try {
      const batch = writeBatch(db);
      const txRef = doc(collection(db, "transactions"));
      let customerId: string;

      if (duplicateCustomer) {
        // Khata pehle se hai: naya banane ke bajaye usi me entry add hogi
        customerId = duplicateCustomer.id;
        batch.update(doc(db, "customers", customerId), {
          totalBalance: increment(txType === "GAVE" ? numAmount : -numAmount),
        });
      } else {
        const customerRef = doc(collection(db, "customers"));
        customerId = customerRef.id;
        batch.set(customerRef, {
          userId: user.uid,
          name,
          phone: customerPhone.trim(),
          totalBalance: txType === "GAVE" ? numAmount : -numAmount,
          createdAt: serverTimestamp(),
        });
      }
      batch.set(txRef, {
        userId: user.uid,
        customerId,
        amount: numAmount,
        type: txType,
        createdAt: serverTimestamp(),
      });

      // Offline mein server ka jawab nahi aata, isliye intezar nahi karte
      batch.commit().catch((err) => console.error("Sync error:", err));
      setNotice(
        makeNotice({
          name: duplicateCustomer ? duplicateCustomer.name : name,
          phone: duplicateCustomer
            ? duplicateCustomer.phone
            : customerPhone.trim(),
          amount: numAmount,
          type: txType,
          balanceAfter:
            (duplicateCustomer ? duplicateCustomer.totalBalance : 0) +
            (txType === "GAVE" ? numAmount : -numAmount),
        }),
      );
      if (duplicateCustomer) setSelectedId(duplicateCustomer.id);
      setIsCustomerModalOpen(false);
      resetForm();
    } catch (err) {
      console.error("Error adding customer:", err);
      setFormError("Data save nahi ho saka. Dobara koshish karein.");
    } finally {
      setIsSubmitting(false);
    }
  };

  // Balance update + transaction record ek hi batch me
  const handleAddTransaction = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !selectedCustomer || isSubmitting) return;

    const numAmount = parseAmount();
    if (numAmount === null) return setFormError("Sahi amount likhein.");

    setIsSubmitting(true);
    setFormError("");
    try {
      const batch = writeBatch(db);
      const txRef = doc(collection(db, "transactions"));

      batch.update(doc(db, "customers", selectedCustomer.id), {
        totalBalance: increment(txType === "GAVE" ? numAmount : -numAmount),
      });
      batch.set(txRef, {
        userId: user.uid,
        customerId: selectedCustomer.id,
        amount: numAmount,
        type: txType,
        createdAt: serverTimestamp(),
      });

      batch.commit().catch((err) => console.error("Sync error:", err));
      setNotice(
        makeNotice({
          name: selectedCustomer.name,
          phone: selectedCustomer.phone,
          amount: numAmount,
          type: txType,
          balanceAfter:
            selectedCustomer.totalBalance +
            (txType === "GAVE" ? numAmount : -numAmount),
        }),
      );
      setIsTxModalOpen(false);
      resetForm();
    } catch (err) {
      console.error("Error adding transaction:", err);
      setFormError("Transaction save nahi saki. Dobara koshish karein.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleLogout = async () => {
    try {
      await signOut(auth);
      navigate("/login");
    } catch (err) {
      console.error("Logout Error:", err);
    }
  };

  /* ---------------- Render ---------------- */

  if (!authReady) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 text-sm text-slate-500">
        Loading...
      </div>
    );
  }

  const selInfo = selectedCustomer
    ? balanceInfo(selectedCustomer.totalBalance)
    : null;

  // Header: replaced header logout button with hamburger that opens sidebar
  return (
    <div className="min-h-screen bg-slate-50 font-sans text-slate-900">
      {/* Header */}
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

            {/* Hamburger button (3 lines) */}
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

      {/* Sidebar component */}
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

      {/* Offline patti */}
      {!online && (
        <div className="bg-amber-50 border-b border-amber-100 text-amber-800 text-xs text-center py-1.5 px-4">
          Internet nahi hai. Entries phone mein save hoti rahengi, net aate hi
          sync ho jayengi.
        </div>
      )}

      <main className="max-w-3xl mx-auto px-4 pt-6 pb-28 space-y-5">
        {selectedCustomer && selInfo ? (
          /* ---------------- Customer detail ---------------- */
          <>
            <button
              onClick={() => setSelectedId(null)}
              className="text-sm font-medium text-slate-600 hover:text-emerald-700 transition"
            >
              ← Customers
            </button>

            <section
              className={`${cardCls} p-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4`}
            >
              <div className="flex items-center gap-3 min-w-0">
                <Avatar name={selectedCustomer.name} size="lg" />
                <div className="min-w-0">
                  <h2 className="text-lg font-semibold text-slate-900 truncate">
                    {selectedCustomer.name}
                  </h2>
                  <p className="text-sm text-slate-500">
                    {selectedCustomer.phone || "No phone number"}
                  </p>
                </div>
              </div>

              <div className="sm:text-right">
                <p
                  className={`text-2xl font-bold tabular-nums ${selInfo.text}`}
                >
                  {fmt(selectedCustomer.totalBalance)}
                </p>
                <p className="text-xs text-slate-500">{selInfo.label}</p>
              </div>
            </section>

            <section className={`${cardCls} overflow-hidden`}>
              <div className="px-5 py-3.5 border-b border-slate-100 flex items-center justify-between">
                <h3 className="text-sm font-semibold text-slate-900">
                  Transaction History
                </h3>
                <button onClick={openTxModal} className={primaryBtn}>
                  + Add Transaction
                </button>
              </div>

              {transactions.length === 0 ? (
                <p className="py-12 text-center text-sm text-slate-500">
                  Abhi koi transaction mojood nahi hai.
                </p>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-slate-50/70 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">
                      <th className="px-5 py-2.5 font-semibold">Date</th>
                      <th className="px-3 py-2.5 font-semibold">Type</th>
                      <th className="px-5 py-2.5 font-semibold text-right">
                        Amount
                      </th>
                      <th className="pr-5 py-2.5 font-semibold text-right">
                        Message
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {transactions.map((tx) => {
                      const gave = tx.type === "GAVE";
                      return (
                        <tr key={tx.id} className="hover:bg-slate-50/60">
                          <td className="px-5 py-3 text-slate-600">
                            {txTime(tx.createdAt)}
                          </td>
                          <td className="px-3 py-3">
                            <span
                              className={`inline-block px-2.5 py-0.5 rounded-full text-xs font-semibold ${
                                gave
                                  ? "bg-red-50 text-red-700"
                                  : "bg-emerald-50 text-emerald-700"
                              }`}
                            >
                              {gave ? "Udhar Diya" : "Vasool Kiya"}
                            </span>
                          </td>
                          <td
                            className={`px-5 py-3 text-right font-semibold tabular-nums ${
                              gave ? "text-red-600" : "text-emerald-700"
                            }`}
                          >
                            {gave ? "-" : "+"} Rs. {tx.amount.toLocaleString()}
                          </td>
                          <td className="pr-5 py-3 text-right">
                            <button
                              type="button"
                              onClick={() =>
                                openWhatsApp(
                                  whatsappUrl(
                                    selectedCustomer.phone,
                                    buildEntryMessage({
                                      name: selectedCustomer.name,
                                      amount: tx.amount,
                                      type: tx.type,
                                      balanceAfter:
                                        balanceAfterTx[tx.id] ??
                                        selectedCustomer.totalBalance,
                                    }),
                                  ),
                                )
                              }
                              className="text-xs font-semibold text-emerald-700 hover:text-emerald-800 hover:underline"
                            >
                              WhatsApp
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </section>
          </>
        ) : (
          /* ---------------- Dashboard ---------------- */
          <>
            {/* Summary */}
            <section className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <StatCard
                label="To Receive"
                value={`Rs. ${totalLeneHain.toLocaleString()}`}
                tone="text-emerald-700"
                hint={`${leneCount} people, click`}
                active={balanceFilter === "LENE"}
                onClick={() => toggleFilter("LENE")}
              />
              <StatCard
                label="To Pay"
                value={`Rs. ${totalDeneHain.toLocaleString()}`}
                tone="text-red-600"
                hint={`${deneCount} people, click`}
                active={balanceFilter === "DENE"}
                onClick={() => toggleFilter("DENE")}
              />
            </section>

            {/* Customers */}
            <section
              ref={listRef}
              className={`${cardCls} overflow-hidden scroll-mt-20`}
            >
              <div className="px-5 py-4 border-b border-slate-100 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                <div>
                  <h2 className="text-sm font-semibold text-slate-900">
                    {balanceFilter === "LENE"
                      ? "Jin se lene hain"
                      : balanceFilter === "DENE"
                        ? "Jinhein dene hain"
                        : "Customers"}
                  </h2>
                  <p className="text-xs text-slate-500">
                    {balanceFilter === "ALL" ? (
                      `${customers.length} khate`
                    ) : (
                      <>
                        {filteredCustomers.length} khate ·{" "}
                        <button
                          type="button"
                          onClick={() => setBalanceFilter("ALL")}
                          className="font-semibold text-emerald-700 hover:underline"
                        >
                          Sab dikhayein
                        </button>
                      </>
                    )}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    placeholder="Search name or phone"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    className={`${inputCls} sm:w-56`}
                  />
                  <button
                    onClick={openCustomerModal}
                    className={`${primaryBtn} shrink-0`}
                  >
                    + Add Customer
                  </button>
                </div>
              </div>

              {loading ? (
                <div className="divide-y divide-slate-100">
                  {[0, 1, 2].map((i) => (
                    <div
                      key={i}
                      className="px-5 py-4 flex items-center gap-3 animate-pulse"
                    >
                      <div className="w-9 h-9 rounded-full bg-slate-100" />
                      <div className="flex-1 space-y-2">
                        <div className="h-3 w-32 bg-slate-100 rounded" />
                        <div className="h-3 w-24 bg-slate-100 rounded" />
                      </div>
                    </div>
                  ))}
                </div>
              ) : fetchError ? (
                <p className="py-12 text-center text-sm text-red-600">
                  {fetchError}
                </p>
              ) : filteredCustomers.length === 0 ? (
                <div className="py-12 text-center">
                  <p className="text-sm text-slate-500">
                    {customers.length === 0
                      ? "Abhi koi customer nahi hai. Pehla khata add karein."
                      : "Koi match nahi mila."}
                  </p>
                </div>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {filteredCustomers.map((c) => {
                    const info = balanceInfo(c.totalBalance);
                    return (
                      <li key={c.id}>
                        <button
                          onClick={() => setSelectedId(c.id)}
                          className="w-full px-5 py-3.5 flex items-center justify-between gap-3 text-left hover:bg-emerald-50/40 transition"
                        >
                          <div className="flex items-center gap-3 min-w-0">
                            <Avatar name={c.name} />
                            <div className="min-w-0">
                              <p className="text-sm font-medium text-slate-900 truncate">
                                {c.name}
                              </p>
                              <p className="text-xs text-slate-500">
                                {c.phone || "No phone number"}
                              </p>
                            </div>
                          </div>
                          <div className="text-right shrink-0">
                            <p
                              className={`text-sm font-semibold tabular-nums ${info.text}`}
                            >
                              {fmt(c.totalBalance)}
                            </p>
                            <p className="text-xs text-slate-500">
                              {info.label}
                            </p>
                          </div>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          </>
        )}
      </main>

      {/* Bol kar entry (AI) */}
      {user && (
        <VoiceEntry
          user={user}
          customers={customers}
          onSaved={setNotice}
          online={online}
        />
      )}

      {/* Entry save hone ke baad: WhatsApp par bhejne ka button */}
      {notice && (
        <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-40 w-[calc(100%-2rem)] max-w-md bg-slate-900 text-white rounded-2xl shadow-lg px-4 py-3 flex flex-wrap items-center gap-x-3 gap-y-2">
          <p className="flex-1 min-w-40 text-sm leading-snug">{notice.text}</p>
          <button
            type="button"
            onClick={() => {
              openWhatsApp(notice.whatsappUrl);
              setNotice(null);
            }}
            className="shrink-0 h-9 px-3 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-900 text-sm font-semibold transition"
          >
            {notice.hasPhone
              ? "WhatsApp par bhejein"
              : "WhatsApp (number chunein)"}
          </button>
          <button
            type="button"
            onClick={() => setNotice(null)}
            aria-label="Band karein"
            className="shrink-0 text-slate-400 hover:text-white text-lg leading-none px-1"
          >
            ×
          </button>
        </div>
      )}

      {/* Add Customer Modal */}
      {isCustomerModalOpen && (
        <Modal title="Naya Customer" onClose={closeModals}>
          <form onSubmit={handleAddCustomer} className="space-y-4">
            <Field label="Customer Name">
              <input
                type="text"
                autoFocus
                placeholder="e.g. Ali Raza"
                value={customerName}
                onChange={(e) => setCustomerName(e.target.value)}
                className={inputCls}
              />
            </Field>

            <Field label="Phone Number (optional)">
              <input
                type="tel"
                placeholder="e.g. 03001234567"
                value={customerPhone}
                onChange={(e) => setCustomerPhone(e.target.value)}
                className={inputCls}
              />
            </Field>

            {duplicateCustomer && (
              <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-800">
                <span className="font-medium">{duplicateCustomer.name}</span> ka
                khata pehle se mojood hai ({fmt(duplicateCustomer.totalBalance)}
                ). Naya khata nahi banega, entry usi me add hogi.
              </div>
            )}

            <Field label="Pehli Entry">
              <TypeToggle value={txType} onChange={setTxType} />
            </Field>

            <Field label="Amount (PKR)">
              <input
                type="number"
                inputMode="decimal"
                min="0"
                placeholder="e.g. 1500"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className={inputCls}
              />
            </Field>

            <FormFooter
              error={formError}
              submitting={isSubmitting}
              onCancel={closeModals}
              submitLabel={duplicateCustomer ? "Entry Add Karein" : "Save"}
            />
          </form>
        </Modal>
      )}

      {/* Add Transaction Modal */}
      {isTxModalOpen && selectedCustomer && (
        <Modal
          title={`Transaction: ${selectedCustomer.name}`}
          onClose={closeModals}
        >
          <form onSubmit={handleAddTransaction} className="space-y-4">
            <Field label="Type">
              <TypeToggle value={txType} onChange={setTxType} />
            </Field>

            <Field label="Amount (PKR)">
              <input
                type="number"
                inputMode="decimal"
                min="0"
                autoFocus
                placeholder="e.g. 500"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className={inputCls}
              />
            </Field>

            <FormFooter
              error={formError}
              submitting={isSubmitting}
              onCancel={closeModals}
            />
          </form>
        </Modal>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Small UI pieces                                                     */
/* ------------------------------------------------------------------ */

function Avatar({ name, size = "md" }: { name: string; size?: "md" | "lg" }) {
  const dim = size === "lg" ? "w-11 h-11 text-base" : "w-9 h-9 text-sm";
  return (
    <div
      className={`${dim} shrink-0 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-100 font-semibold flex items-center justify-center`}
    >
      {name.charAt(0).toUpperCase()}
    </div>
  );
}

function StatCard({
  label,
  value,
  tone,
  hint,
  active = false,
  onClick,
}: {
  label: string;
  value: string;
  tone: string;
  hint?: string;
  active?: boolean;
  onClick?: () => void;
}) {
  const body = (
    <>
      <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
        {label}
      </p>
      <p className={`mt-2 text-2xl font-bold tabular-nums ${tone}`}>{value}</p>
      {hint && <p className="mt-1 text-xs text-slate-400">{hint}</p>}
    </>
  );

  // Click na ho to pehle jaisa sada card
  if (!onClick) {
    return <div className={`${cardCls} px-5 py-4`}>{body}</div>;
  }

  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`${cardCls} w-full px-5 py-4 text-left transition hover:border-emerald-200 hover:shadow-md ${
        active ? "ring-2 ring-emerald-500 border-emerald-200" : ""
      }`}
    >
      {body}
    </button>
  );
}

function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-sm flex items-end sm:items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white w-full max-w-md rounded-2xl border border-slate-100 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-900 truncate">
            {title}
          </h3>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-slate-400 hover:text-slate-600 text-lg leading-none px-1"
          >
            ×
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-xs font-semibold uppercase tracking-wider text-slate-500 mb-1.5">
        {label}
      </label>
      {children}
    </div>
  );
}

function TypeToggle({
  value,
  onChange,
}: {
  value: TxType;
  onChange: (v: TxType) => void;
}) {
  const base = "h-10 rounded-xl text-sm font-semibold border transition";
  return (
    <div className="grid grid-cols-2 gap-2">
      <button
        type="button"
        onClick={() => onChange("GAVE")}
        className={`${base} ${
          value === "GAVE"
            ? "bg-red-50 border-red-300 text-red-700"
            : "bg-white border-slate-200 text-slate-500 hover:bg-slate-50"
        }`}
      >
        Udhar Diya
      </button>
      <button
        type="button"
        onClick={() => onChange("GOT")}
        className={`${base} ${
          value === "GOT"
            ? "bg-emerald-50 border-emerald-300 text-emerald-700"
            : "bg-white border-slate-200 text-slate-500 hover:bg-slate-50"
        }`}
      >
        Vasool Kiya
      </button>
    </div>
  );
}

function FormFooter({
  error,
  submitting,
  onCancel,
  submitLabel = "Save",
}: {
  error: string;
  submitting: boolean;
  onCancel: () => void;
  submitLabel?: string;
}) {
  return (
    <>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <div className="flex justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={onCancel}
          disabled={submitting}
          className="h-10 px-4 bg-white border border-slate-200 hover:bg-slate-50 text-slate-700 rounded-xl text-sm font-medium transition"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={submitting}
          className="h-10 px-5 bg-emerald-600 hover:bg-emerald-700 active:scale-[0.98] disabled:opacity-60 disabled:cursor-not-allowed text-white rounded-xl text-sm font-semibold shadow-sm shadow-emerald-600/20 transition"
        >
          {submitting ? "Saving..." : submitLabel}
        </button>
      </div>
    </>
  );
}
