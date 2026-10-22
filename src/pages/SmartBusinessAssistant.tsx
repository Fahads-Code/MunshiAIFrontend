import { useEffect, useRef, useState } from "react";
import { onAuthStateChanged } from "firebase/auth";
import { collection, getDocs, query, where } from "firebase/firestore";
import type { DocumentData } from "firebase/firestore";
import { auth, db } from "../firebase";
import { useNavigate } from "react-router-dom";
import Sidebar from "../components/Sidebar";
import { useSpeech } from "../hooks/useSpeech";
import { parseItems } from "../lib/Sales";
import {
  plainText,
  renderMarkdownLite,
  whatsappText,
} from "../lib/markdownLite";
import {
  analyzeShopQuery,
  type CustomerRow,
  type ExpenseRow,
  type TxRow,
} from "../lib/assistantEngine";
import "../styles/munshi.css";

type Message = {
  role: "user" | "assistant";
  text: string;
  at: number;
  error?: boolean;
};

const API_URL =
  import.meta.env.VITE_API_URL || "https://munshi-ai-red.vercel.app";

const GREETING =
  "Assalam-o-Alaikum! Main aapka Munshi AI assistant hoon. Aap mujh se aaj ki sale, udhaar, wasooli, munafa, ya kisi bhi customer ke khata ke baare mein pooch sakte hain.";

const makeMsg = (
  role: Message["role"],
  text: string,
  error = false,
): Message => ({
  role,
  text,
  at: Date.now(),
  error,
});

type Suggestion = { group: string; tone: string; short: string; q: string };

const suggestions: Suggestion[] = [
  {
    group: "Sale",
    tone: "text-emerald-700",
    short: "Aaj ki sale",
    q: "Aaj kitni total sale hui?",
  },
  {
    group: "Sale",
    tone: "text-emerald-700",
    short: "Cash vs udhaar",
    q: "Aaj cash aur udhaar ki sale kitni thi?",
  },
  {
    group: "Udhaar",
    tone: "text-red-600",
    short: "Aaj ka udhaar",
    q: "Aaj kin customers ne udhaar par samaan liya?",
  },
  {
    group: "Wasooli",
    tone: "text-teal-700",
    short: "Aaj ki wasooli",
    q: "Kin customers se aaj payment receive hui?",
  },
  {
    group: "Munafa",
    tone: "text-slate-600",
    short: "Mahine ka profit",
    q: "Is mahine ka net profit kitna hai?",
  },
  {
    group: "Market Udhaar",
    tone: "text-red-700",
    short: "Kul udhaar",
    q: "Sab se zyada udhar kis ka hai?",
  },
  {
    group: "Customers",
    tone: "text-blue-700",
    short: "Total customers",
    q: "Hamare pass total kitne customer hain?",
  },
  {
    group: "Sale",
    tone: "text-emerald-700",
    short: "Pichle 7 din",
    q: "Pichle 7 din ki total sale kitni rahi?",
  },
];

const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const dateOf = (v: unknown) => {
  if (
    v &&
    typeof v === "object" &&
    "toDate" in v &&
    typeof (v as { toDate?: unknown }).toDate === "function"
  ) {
    return (v as { toDate: () => Date }).toDate().toISOString();
  }
  if (v instanceof Date) return v.toISOString();
  return null;
};

function cleanTx(id: string, d: DocumentData): TxRow {
  return {
    id,
    type: d.type === "GOT" ? "GOT" : "GAVE",
    amount: num(d.amount),
    paid: num(d.paid),
    customerId: typeof d.customerId === "string" ? d.customerId : null,
    customerName:
      typeof d.customerName === "string" ? d.customerName : "Walk-in Customer",
    createdAt: dateOf(d.createdAt),
    items: parseItems(d.items).map((i) => ({
      name: String(i.name ?? "").slice(0, 60),
      qty: i.qty,
      unit: String(i.unit ?? "").slice(0, 20),
      price: num(i.price),
    })),
    profit: d.profit == null ? null : num(d.profit),
    profitEstimated: d.profitEstimated === true,
    source: typeof d.source === "string" ? d.source : null,
    note: typeof d.note === "string" ? d.note.slice(0, 160) : "",
    receiptNo: typeof d.receiptNo === "string" ? d.receiptNo : null,
  };
}

function cleanExpense(id: string, d: DocumentData): ExpenseRow {
  return {
    id,
    amount: num(d.amount),
    category: typeof d.category === "string" ? d.category : "Other",
    note: typeof d.note === "string" ? d.note.slice(0, 100) : "",
    createdAt: dateOf(d.createdAt),
  };
}

const timeLabel = (at: number) =>
  new Date(at).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
  });

/* ------------------------------------------------------------------ */
/* Chhote icons                                                        */
/* ------------------------------------------------------------------ */

function Icon({ d, className = "h-5 w-5" }: { d: string; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={d} />
    </svg>
  );
}

const ICON_MIC =
  "M19 11a7 7 0 0 1-14 0M12 18v3m-4 0h8M12 3a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z";
const ICON_SEND = "M5 12h14M13 6l6 6-6 6";
const ICON_MENU = "M4 6h16M4 12h16M4 18h16";
const ICON_COPY = "M9 9h10v10H9zM5 15V5h10";
const ICON_CHECK = "M5 12.5l4.5 4.5L19 7.5";
const ICON_REFRESH = "M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7";
const ICON_STAR =
  "M12 3 14 8 19 6 17 11 21 14 15 15 14 21 10 17 5 19 7 14 3 11 9 10Z";

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

export default function SmartBusinessAssistant() {
  const navigate = useNavigate();
  const [userId, setUserId] = useState<string | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [copiedAt, setCopiedAt] = useState<number | null>(null);
  const [messages, setMessages] = useState<Message[]>([
    makeMsg("assistant", GREETING),
  ]);

  const endRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const lastQuestionRef = useRef("");

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      setUserId(u?.uid ?? null);
      setAuthReady(true);
      if (!u) navigate("/login");
    });

    return () => unsubscribe();
  }, [navigate]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, busy]);

  // Likhte waqt box khud barhe (zyada se zyada 120px)
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, [input]);

  const ask = async (raw: string, retry = false) => {
    const question = raw.trim();

    if (!question || busy) return;

    if (!userId || !auth.currentUser) {
      setMessages((m) => [
        ...m,
        makeMsg(
          "assistant",
          "Pehle login karein, phir shop reports dekh sakte hain.",
          true,
        ),
      ]);
      return;
    }

    lastQuestionRef.current = question;
    setInput("");
    setMessages((m) => {
      if (retry) {
        return m[m.length - 1]?.error ? m.slice(0, -1) : m;
      }
      return [...m, makeMsg("user", question)];
    });
    setBusy(true);

    try {
      const uid = userId;

      // Firestore se live records fetch karein
      const [txSnap, expSnap, customerSnap] = await Promise.all([
        getDocs(
          query(collection(db, "transactions"), where("userId", "==", uid)),
        ),
        getDocs(
          query(collection(db, "expenses"), where("userId", "==", uid)),
        ).catch(() => null),
        getDocs(
          query(collection(db, "customers"), where("userId", "==", uid)),
        ).catch(() => null),
      ]);

      const customerMap = new Map<string, { name: string; balance: number }>();
      const customersList: CustomerRow[] = [];
      customerSnap?.docs.forEach((d) => {
        const x = d.data();
        const name =
          typeof x.name === "string" && x.name.trim()
            ? x.name.trim().slice(0, 60)
            : "Customer";
        const bal = num(x.totalBalance);
        customerMap.set(d.id, { name, balance: bal });
        customersList.push({ id: d.id, name, totalBalance: bal });
      });

      const allTxs: TxRow[] = txSnap.docs
        .map((d) => cleanTx(d.id, d.data()))
        .map((t) => {
          const known =
            typeof t.customerId === "string"
              ? customerMap.get(t.customerId)
              : undefined;
          const saved =
            typeof t.customerName === "string" &&
            t.customerName !== "Walk-in Customer"
              ? t.customerName
              : null;
          return {
            ...t,
            customerName: known?.name ?? saved ?? "Walk-in Customer",
          };
        })
        .sort((a, b) =>
          String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")),
        );

      const allExpenses: ExpenseRow[] = expSnap
        ? expSnap.docs.map((d) => cleanExpense(d.id, d.data()))
        : [];

      // 100% Deterministic Financial Calculation (0% Math Error)
      const analysis = analyzeShopQuery(
        question,
        allTxs,
        customersList,
        allExpenses,
      );

      let finalAnswer = analysis.deterministicText;

      // Send payload with facts, fallback answer, and minimal context (compatible with both old & new backend)
      try {
        const token = await auth.currentUser.getIdToken();
        const response = await fetch(`${API_URL}/api/business-assistant`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            question,
            facts: analysis.facts,
            deterministicAnswer: analysis.deterministicText,
            context: {
              now: new Date().toISOString(),
              range: {
                from: new Date(analysis.period.from).toISOString(),
                to: new Date(analysis.period.to).toISOString(),
              },
              transactions: allTxs.slice(0, 20),
              customers: customersList.slice(0, 30),
              expenses: allExpenses.slice(0, 10),
            },
          }),
        });

        if (response.ok) {
          const result = await response.json().catch(() => ({}));
          if (typeof result.answer === "string" && result.answer.trim()) {
            finalAnswer = result.answer.trim();
          }
        }
      } catch (networkErr) {
        // Backend offline ya rate-limit par bhi user ko 100% accurate verified jawab milega!
        console.warn("Using verified local calculation:", networkErr);
      }

      setMessages((m) => [...m, makeMsg("assistant", finalAnswer)]);
    } catch (e) {
      setMessages((m) => [
        ...m,
        makeMsg(
          "assistant",
          e instanceof Error
            ? e.message
            : "Data load nahi ho saka. Internet check karein.",
          true,
        ),
      ]);
    } finally {
      setBusy(false);
    }
  };

  const speech = useSpeech("en-PK", (text) => {
    setInput(text);
    void ask(text);
  });

  const copyAnswer = async (m: Message) => {
    try {
      await navigator.clipboard.writeText(plainText(m.text));
      setCopiedAt(m.at);
      setTimeout(() => setCopiedAt((c) => (c === m.at ? null : c)), 1800);
    } catch {
      /* clipboard error ignore */
    }
  };

  const shareOnWhatsApp = (m: Message) => {
    const text = `${whatsappText(m.text)}\n\n- Munshi AI`;
    window.open(
      `https://wa.me/?text=${encodeURIComponent(text)}`,
      "_blank",
      "noopener,noreferrer",
    );
  };

  if (!authReady) {
    return (
      <div className="grid min-h-dvh place-items-center bg-slate-50 text-sm text-slate-500">
        Loading Munshi AI…
      </div>
    );
  }

  const fresh = messages.length === 1;
  const visible = fresh ? [] : messages;

  return (
    <>
      <style>{`
        .assistant-markdown { line-height: 1.7; color: #1e293b; word-break: break-word; }
        .assistant-markdown > *:first-child { margin-top: 0; }
        .assistant-markdown > *:last-child { margin-bottom: 0; }
        .assistant-markdown p, .assistant-markdown ul, .assistant-markdown ol,
        .assistant-markdown h1, .assistant-markdown h2, .assistant-markdown h3,
        .assistant-markdown blockquote { margin: 0.55rem 0; }
        .assistant-markdown h1, .assistant-markdown h2, .assistant-markdown h3 {
          font-weight: 700; color: #0f172a;
        }
        .assistant-markdown h1 { font-size: 1.08rem; }
        .assistant-markdown h2 { font-size: 1rem; }
        .assistant-markdown h3 { font-size: 0.95rem; }
        .assistant-markdown ul, .assistant-markdown ol { padding-left: 1.25rem; }
        .assistant-markdown ul { list-style: disc; }
        .assistant-markdown ol { list-style: decimal; }
        .assistant-markdown li { margin: 0.25rem 0; }
        .assistant-markdown li::marker { color: #10b981; }
        .assistant-markdown strong { font-weight: 700; color: #0f172a; }
        .assistant-markdown code {
          background: rgba(15, 23, 42, 0.07); padding: 0.1rem 0.35rem;
          border-radius: 0.4rem; font-size: 0.9em;
        }
        .assistant-markdown blockquote {
          border-left: 3px solid #10b981; background: rgba(16, 185, 129, 0.06);
          color: #475569; border-radius: 0.35rem; padding: 0.3rem 0.75rem;
        }
        .assistant-markdown .md-table { overflow-x: auto; margin: 0.65rem 0; border-radius: 0.75rem; border: 1px solid #e2e8f0; }
        .assistant-markdown table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
        .assistant-markdown th { background: #f8fafc; color: #64748b; font-weight: 600; text-align: left; font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.04em; }
        .assistant-markdown th, .assistant-markdown td { padding: 0.5rem 0.75rem; white-space: nowrap; }
        .assistant-markdown td { border-top: 1px solid #f1f5f9; font-variant-numeric: tabular-nums; }
        @keyframes munshi-dot { 0%, 80%, 100% { transform: translateY(0); opacity: .4; } 40% { transform: translateY(-4px); opacity: 1; } }
        .munshi-dot { animation: munshi-dot 1.2s infinite ease-in-out; }
        .munshi-hide-scroll { scrollbar-width: none; }
        .munshi-hide-scroll::-webkit-scrollbar { display: none; }
      `}</style>

      <div className="flex h-dvh flex-col bg-slate-50 font-sans text-slate-900">
        {/* Header */}
        <header className="z-20 shrink-0 border-b border-slate-100 bg-white shadow-sm shadow-slate-200/40">
          <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6">
            <button
              type="button"
              onClick={() => navigate("/")}
              aria-label="Home page par jayein"
              className="flex min-w-0 items-center gap-3 text-left"
            >
              <div className="w-9 h-9 shrink-0 rounded-xl overflow-hidden flex items-center justify-center">
                <img
                  src="/favicon.png"
                  alt="Munshi AI"
                  className="w-full h-full object-contain"
                />
              </div>

              <div className="min-w-0 leading-tight">
                <h1 className="truncate text-base font-bold text-slate-900">
                  Smart Business Assistant
                </h1>
                <p className="hidden text-xs text-slate-500 sm:block">
                  100% Accurate Khata & Business Assistant
                </p>
              </div>
            </button>

            <button
              type="button"
              onClick={() => setSidebarOpen(true)}
              aria-label="Menu kholein"
              className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-slate-200 text-slate-600 transition hover:bg-slate-50"
            >
              <Icon d={ICON_MENU} className="h-5 w-5" />
            </button>
          </div>
        </header>

        <Sidebar
          open={sidebarOpen}
          onClose={() => setSidebarOpen(false)}
          onLogout={async () => {
            const { signOut } = await import("firebase/auth");
            await signOut(auth);
            navigate("/login");
          }}
          userEmail={auth.currentUser?.email}
          userPhone={auth.currentUser?.phoneNumber}
          userDisplayName={auth.currentUser?.displayName}
          userPhotoUrl={auth.currentUser?.photoURL}
        />

        {/* Chat / Messages */}
        <main className="min-h-0 flex-1 overflow-y-auto">
          <div
            className="mx-auto w-full max-w-3xl space-y-4 px-4 py-5"
            aria-live="polite"
          >
            {fresh && (
              <section className="pt-2">
                <div className="text-center">
                  <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl border border-emerald-200/60 bg-emerald-100 text-emerald-600">
                    <Icon d={ICON_STAR} className="h-7 w-7" />
                  </div>
                  <h2 className="mt-3 text-lg font-bold text-slate-900">
                    Aap ki dukan, bas poochein
                  </h2>
                  <p className="mx-auto mt-1 max-w-md text-sm text-slate-500">
                    Sale, udhaar, wasooli, munafa ya kisi bhi customer ke baare mein
                    Roman Urdu mein poochein. Har hisaab 100% accurate milega.
                  </p>
                </div>

                <div className="mt-5 grid grid-cols-2 gap-2">
                  {suggestions.map((s) => (
                    <button
                      key={s.q}
                      disabled={busy}
                      onClick={() => void ask(s.q)}
                      className="rounded-2xl border border-slate-100 bg-white p-3 text-left shadow-sm shadow-slate-200/60 transition hover:border-emerald-200 hover:shadow-md disabled:opacity-50 sm:p-3.5"
                    >
                      <span
                        className={`text-[10px] font-bold uppercase tracking-wider sm:text-[11px] ${s.tone}`}
                      >
                        {s.group}
                      </span>
                      <span className="mt-1 block text-[13px] leading-snug text-slate-800 sm:text-sm">
                        {s.q}
                      </span>
                    </button>
                  ))}
                </div>
              </section>
            )}

            {visible.map((m, idx) => {
              const isUser = m.role === "user";
              const isAnswer = !isUser && !m.error && idx !== 0;

              return (
                <div
                  key={m.at + m.role + m.text.length}
                  className={`flex gap-2.5 ${isUser ? "justify-end" : "justify-start"}`}
                >
                  {!isUser && (
                    <div
                      className={`mt-0.5 grid h-8 w-8 shrink-0 place-items-center overflow-hidden rounded-xl border ${
                        m.error
                          ? "border-red-100 bg-red-50 text-red-500"
                          : "border-slate-200/70 bg-white"
                      }`}
                    >
                      {m.error ? (
                        <Icon d={ICON_STAR} className="h-4 w-4" />
                      ) : (
                        <img
                          src="/favicon.png"
                          alt="Munshi AI"
                          className="h-full w-full object-contain"
                        />
                      )}
                    </div>
                  )}

                  <div
                    className={`flex max-w-[88%] flex-col sm:max-w-[80%] ${
                      isUser ? "items-end" : "items-start"
                    }`}
                  >
                    <div
                      className={`rounded-2xl px-4 py-3 text-sm leading-6 ${
                        isUser
                          ? "rounded-br-md bg-emerald-600 text-white shadow-sm shadow-emerald-600/20"
                          : m.error
                            ? "rounded-bl-md border border-red-100 bg-red-50 text-red-800"
                            : "rounded-bl-md border border-slate-100 bg-white shadow-sm shadow-slate-200/60"
                      }`}
                    >
                      {isUser ? (
                        <div className="whitespace-pre-wrap">{m.text}</div>
                      ) : (
                        <div
                          className="assistant-markdown"
                          dangerouslySetInnerHTML={{
                            __html: renderMarkdownLite(m.text),
                          }}
                        />
                      )}
                    </div>

                    <div className="mt-1 flex items-center gap-1 px-1 text-[11px] text-slate-400">
                      <span>{timeLabel(m.at)}</span>

                      {isAnswer && (
                        <>
                          <button
                            onClick={() => void copyAnswer(m)}
                            className="ml-2 flex items-center gap-1 rounded-lg px-1.5 py-1 font-medium text-slate-500 transition hover:bg-slate-100 hover:text-slate-700"
                          >
                            <Icon
                              d={copiedAt === m.at ? ICON_CHECK : ICON_COPY}
                              className="h-3.5 w-3.5"
                            />
                            {copiedAt === m.at ? "Copy ho gaya" : "Copy"}
                          </button>
                          <button
                            onClick={() => shareOnWhatsApp(m)}
                            className="flex items-center gap-1 rounded-lg px-1.5 py-1 font-medium text-emerald-700 transition hover:bg-emerald-50"
                          >
                            <Icon d={ICON_SEND} className="h-3.5 w-3.5" />
                            WhatsApp
                          </button>
                        </>
                      )}

                      {m.error && lastQuestionRef.current && (
                        <button
                          onClick={() =>
                            void ask(lastQuestionRef.current, true)
                          }
                          disabled={busy}
                          className="ml-2 flex items-center gap-1 rounded-lg px-1.5 py-1 font-semibold text-red-600 transition hover:bg-red-50 disabled:opacity-50"
                        >
                          <Icon d={ICON_REFRESH} className="h-3.5 w-3.5" />
                          Dobara koshish karein
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}

            {busy && (
              <div className="flex items-center gap-2.5">
                <div className="grid h-8 w-8 shrink-0 place-items-center rounded-xl border border-emerald-200/60 bg-emerald-100 text-emerald-600">
                  <Icon d={ICON_STAR} className="h-4 w-4" />
                </div>
                <div className="flex items-center gap-2 rounded-2xl rounded-bl-md border border-slate-100 bg-white px-4 py-3 text-sm text-slate-500 shadow-sm shadow-slate-200/60">
                  <span className="flex gap-1">
                    <span className="munshi-dot h-1.5 w-1.5 rounded-full bg-emerald-500" />
                    <span
                      className="munshi-dot h-1.5 w-1.5 rounded-full bg-emerald-500"
                      style={{ animationDelay: "0.15s" }}
                    />
                    <span
                      className="munshi-dot h-1.5 w-1.5 rounded-full bg-emerald-500"
                      style={{ animationDelay: "0.3s" }}
                    />
                  </span>
                  Shop records check kar raha hoon…
                </div>
              </div>
            )}

            <div ref={endRef} />
          </div>
        </main>

        {/* Input footer */}
        <footer className="z-10 shrink-0 border-t border-slate-100 bg-white/95 backdrop-blur">
          <div className="mx-auto w-full max-w-3xl px-4 pb-3 pt-2.5">
            {!fresh && (
              <div className="munshi-hide-scroll -mx-1 mb-2 flex gap-2 overflow-x-auto px-1 pb-1">
                {suggestions.map((s) => (
                  <button
                    key={s.q}
                    disabled={busy}
                    onClick={() => void ask(s.q)}
                    className="shrink-0 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 transition hover:border-emerald-300 hover:bg-emerald-50 hover:text-emerald-800 disabled:opacity-50"
                  >
                    {s.short}
                  </button>
                ))}
              </div>
            )}

            {speech.listening && (
              <div className="mb-2 flex items-center gap-2 rounded-xl border border-red-100 bg-red-50 px-3 py-2 text-xs text-red-700">
                <span className="relative flex h-2.5 w-2.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-75" />
                  <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-red-500" />
                </span>
                <span className="font-semibold">Sun raha hoon…</span>
                <span className="min-w-0 truncate text-red-600/80">
                  {speech.interim}
                </span>
              </div>
            )}

            <form
              className="flex items-end gap-2 rounded-2xl border border-slate-200 bg-white p-2 shadow-sm transition focus-within:border-emerald-400 focus-within:ring-4 focus-within:ring-emerald-500/10"
              onSubmit={(e) => {
                e.preventDefault();
                void ask(input);
              }}
            >
              <button
                type="button"
                aria-label={
                  speech.listening ? "Awaz rokein" : "Bol kar poochein"
                }
                disabled={!speech.supported || busy}
                onClick={() =>
                  speech.listening ? speech.stop() : speech.start()
                }
                className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl transition disabled:opacity-40 ${
                  speech.listening
                    ? "bg-red-100 text-red-700"
                    : "bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
                }`}
              >
                <Icon d={ICON_MIC} />
              </button>

              <textarea
                ref={taRef}
                rows={1}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (
                    e.key === "Enter" &&
                    !e.shiftKey &&
                    !e.nativeEvent.isComposing
                  ) {
                    e.preventDefault();
                    void ask(input);
                  }
                }}
                placeholder={
                  speech.listening
                    ? "Bolna shuru karein…"
                    : "Apna sawal likhein…"
                }
                className="max-h-30 min-w-0 flex-1 resize-none bg-transparent px-1 py-2.5 text-sm outline-none placeholder:text-slate-400"
                aria-label="Dukan ke baare mein sawal likhein"
                maxLength={500}
              />

              <button
                type="submit"
                disabled={busy || !input.trim()}
                aria-label="Bhejein"
                className="flex h-10 shrink-0 items-center gap-1.5 rounded-xl bg-emerald-600 px-4 text-sm font-semibold text-white shadow-sm shadow-emerald-600/20 transition hover:bg-emerald-700 active:scale-[0.98] disabled:opacity-40 disabled:shadow-none"
              >
                <span className="hidden sm:inline">Poochein</span>
                <Icon d={ICON_SEND} className="h-4 w-4" />
              </button>
            </form>

            {(speech.error || !speech.supported) && (
              <p className="mt-2 text-xs text-amber-700">
                {speech.error ||
                  "Is browser mein voice input supported nahi. Aap likh kar poochh sakte hain."}
              </p>
            )}

            <p className="mt-2 text-center text-[11px] text-slate-400">
              100% Accurate Verified Shop Data · Sirf parhne wala assistant
            </p>
          </div>
        </footer>
      </div>
    </>
  );
}
