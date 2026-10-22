import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { User } from "firebase/auth";
import {
  collection,
  doc,
  increment,
  serverTimestamp,
  writeBatch,
} from "firebase/firestore";
import { db } from "../firebase";
import { makeNotice, normalizePkPhone } from "../utils/whatsapp";
import type { SavedNotice } from "../utils/whatsapp";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

type TxType = "GAVE" | "GOT";

interface CustomerLite {
  id: string;
  name: string;
  phone: string;
  totalBalance: number;
}

// Browser ke speech API ki minimal types (TypeScript mein built-in nahi hoti)
interface SRResult {
  isFinal: boolean;
  0: { transcript: string };
}
interface SRResultEvent {
  results: { length: number; [i: number]: SRResult };
}
interface SpeechRec {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  maxAlternatives: number;
  onresult: ((e: SRResultEvent) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  abort: () => void;
}

function getSpeechCtor(): (new () => SpeechRec) | null {
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRec;
    webkitSpeechRecognition?: new () => SpeechRec;
  };
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

const API_URL: string =
  import.meta.env.VITE_API_URL || "https://munshi-ai-red.vercel.app";

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
const fmt = (n: number) => `Rs. ${Math.abs(n).toLocaleString()}`;

function balanceLabel(n: number) {
  if (n > 0) return "lene hain";
  if (n < 0) return "dene hain";
  return "barabar";
}

// Bole hue naam se milte julte maujooda khate dhoondna
function findCandidates(customers: CustomerLite[], rawName: string) {
  const n = norm(rawName);
  if (!n) return { exact: null as CustomerLite | null, candidates: [] as CustomerLite[] };

  const exact = customers.find((c) => norm(c.name) === n) ?? null;
  if (exact) return { exact, candidates: [exact] };

  // "Ali" bola ho to "Ali Raza" aur "Ali Hassan" dono mil jayein
  const tokens = n.split(" ");
  const candidates = customers.filter((c) => {
    const ct = norm(c.name).split(" ");
    return tokens.every((t) => ct.includes(t));
  });
  return { exact: null, candidates };
}

const inputCls =
  "w-full h-10 bg-slate-50/60 border border-slate-200 rounded-xl px-3.5 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:bg-white focus:border-emerald-500 focus:ring-4 focus:ring-emerald-500/10 transition";

const labelCls =
  "block text-xs font-semibold uppercase tracking-wider text-slate-500 mb-1.5";

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

export default function VoiceEntry({
  user,
  customers,
  onSaved,
  online,
}: {
  user: User;
  customers: CustomerLite[];
  onSaved: (notice: SavedNotice) => void;
  online: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [listening, setListening] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [parsing, setParsing] = useState(false);
  const [parsed, setParsed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // Samjhi hui entry (user theek bhi kar sakta hai)
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [phone, setPhone] = useState(""); // naye khate ya bina number wale khate ke liye
  const [txType, setTxType] = useState<TxType | null>(null);
  const [choice, setChoice] = useState<string | null>(null); // customer id ya "new"

  const recRef = useRef<SpeechRec | null>(null);
  const finalRef = useRef("");
  // Aakhri dafa jo bhi sunai diya (final ya interim) — end par isi ka fallback hoga
  const spokenRef = useRef("");

  /* ---------------- Naam matching ---------------- */

  const { exact, candidates } = useMemo(
    () => findCandidates(customers, name),
    [customers, name],
  );

  // exact mila to wahi; warna user ka chuna hua; warna 1 hi option ho to wahi
  const effective: string | null = exact
    ? exact.id
    : (choice ??
      (candidates.length === 0 ? "new" : candidates.length === 1 ? candidates[0].id : null));

  const target = customers.find((c) => c.id === effective) ?? null;

  const numAmount = (() => {
    const n = Number(amount);
    return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
  })();

  // Number mangna hai jab khata naya ho, ya maujooda khate mein number na ho
  const needsPhone = effective === "new" || (target !== null && !target.phone);
  const phoneEntered = phone.trim().length > 0;
  const phoneInvalid = needsPhone && phoneEntered && normalizePkPhone(phone) === null;

  const canSave =
    parsed &&
    !saving &&
    !phoneInvalid &&
    numAmount !== null &&
    txType !== null &&
    effective !== null &&
    (effective !== "new" || name.trim().length > 0);

  /* ---------------- AI se entry samajhna ---------------- */

  const parseText = async (text: string) => {
    const t = text.trim();
    if (!t) {
      setError("Pehle bolein ya likhein ke kya entry karni hai.");
      return;
    }
    setParsing(true);
    setError("");
    try {
      const token = await user.getIdToken();
      const res = await fetch(`${API_URL}/api/parse-entry`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ text: t, customers: customers.map((c) => c.name) }),
      });
      const data: {
        name?: string | null;
        amount?: number | null;
        type?: TxType | null;
        error?: string;
      } = await res.json().catch(() => ({}));

      if (!res.ok) throw new Error(`${res.status}: ${data.error || "Server error"}`);

      setName(data.name ?? "");
      setAmount(data.amount ? String(data.amount) : "");
      setTxType(data.type ?? null);
      setChoice(null);
      setParsed(true);

      if (!data.name || !data.amount || !data.type) {
        setError("Kuch cheezein samajh nahi aayin. Neeche check kar ke theek kar lein.");
      }
    } catch (err) {
      console.error("Parse error:", err);
      setError(
        "AI se rabta nahi ho saka. Text check kar ke dobara koshish karein, ya neeche khud bhar dein.",
      );
      // AI na chale tab bhi dukandar khud bhar sake
      setParsed(true);
    } finally {
      setParsing(false);
    }
  };

  // Recognition ka callback hamesha latest parseText chalaye
  const parseRef = useRef(parseText);
  useEffect(() => {
    parseRef.current = parseText;
  });

  /* ---------------- Mic ---------------- */

  const stopRecognition = () => {
    const rec = recRef.current;
    if (!rec) return;
    rec.onresult = null;
    rec.onerror = null;
    rec.onend = null;
    rec.abort();
    recRef.current = null;
  };

  const startListening = () => {
    const Ctor = getSpeechCtor();
    if (!Ctor) {
      setError(
        "Is browser mein awaz ki sahulat nahi hai (Chrome use karein). Neeche likh kar bhi entry ho sakti hai.",
      );
      return;
    }

    stopRecognition();
    setError("");
    setParsed(false);
    finalRef.current = "";
    spokenRef.current = "";
    setTranscript("");

    const rec = new Ctor();
    rec.lang = "ur-PK";
    rec.interimResults = true;
    rec.continuous = false;
    rec.maxAlternatives = 1;

    rec.onresult = (e) => {
      let finalText = "";
      let interim = "";
      for (let i = 0; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalText += r[0].transcript;
        else interim += r[0].transcript;
      }
      finalRef.current = finalText;
      const full = `${finalText} ${interim}`.trim();
      if (full) spokenRef.current = full;
      setTranscript(full);
    };

    rec.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        setError("Mic ki ijazat nahi mili. Browser settings mein mic allow karein.");
      } else if (e.error === "no-speech") {
        setError("Awaz sunai nahi di. Dobara koshish karein.");
      } else if (e.error !== "aborted") {
        setError("Awaz pehchanne mein masla hua. Dobara koshish karein ya likh dein.");
      }
    };

    rec.onend = () => {
      setListening(false);
      recRef.current = null;
      // Chrome aksar interim (non-final) result par hi band ho jata hai —
      // sirf final par depend karenge to kuch nahi hoga. Dono ka fallback.
      const t = finalRef.current.trim() || spokenRef.current.trim();
      if (t) void parseRef.current(t);
      else
        setError("Kuch sunai nahi diya. Mic ke paas bol kar dobara koshish karein, ya neeche likh dein.");
    };

    recRef.current = rec;
    setListening(true);
    try {
      rec.start();
    } catch {
      setListening(false);
    }
  };

  const stopListening = () => {
    // onend khud baqi kaam kar dega
    recRef.current?.abort();
  };

  // Component hatay to mic band
  useEffect(() => stopRecognition, []);

  /* ---------------- Open / close ---------------- */

  const resetAll = () => {
    setTranscript("");
    setParsed(false);
    setParsing(false);
    setError("");
    setName("");
    setAmount("");
    setPhone("");
    setTxType(null);
    setChoice(null);
    finalRef.current = "";
    spokenRef.current = "";
  };

  const openModal = () => {
    if (!online) return;
    resetAll();
    setOpen(true);
    startListening();
  };

  const closeModal = () => {
    if (saving) return;
    stopRecognition();
    setListening(false);
    setOpen(false);
    resetAll();
  };

  /* ---------------- Save (Home.tsx wali batch logic jaisi hi) ---------------- */

  const handleSave = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSave || numAmount === null || txType === null || effective === null) return;

    setSaving(true);
    setError("");
    try {
      const batch = writeBatch(db);
      const txRef = doc(collection(db, "transactions"));
      const delta = txType === "GAVE" ? numAmount : -numAmount;
      let customerId: string;

      if (effective === "new") {
        const customerRef = doc(collection(db, "customers"));
        customerId = customerRef.id;
        batch.set(customerRef, {
          userId: user.uid,
          name: name.trim().replace(/\s+/g, " "),
          phone: phone.trim(),
          totalBalance: delta,
          createdAt: serverTimestamp(),
        });
      } else {
        customerId = effective;
        batch.update(doc(db, "customers", customerId), {
          totalBalance: increment(delta),
          // Khate mein number nahi tha aur ab diya gaya hai to wo bhi save ho jaye
          ...(needsPhone && phoneEntered ? { phone: phone.trim() } : {}),
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

      // Home page par "WhatsApp par bhejein" wala notice dikhane ke liye
      onSaved(
        makeNotice({
          name: target?.name ?? name.trim().replace(/\s+/g, " "),
          phone: target?.phone || phone.trim(),
          amount: numAmount,
          type: txType,
          balanceAfter: (target?.totalBalance ?? 0) + delta,
        }),
      );
      stopRecognition();
      setOpen(false);
      resetAll();
    } catch (err) {
      console.error("Voice entry save error:", err);
      setError("Entry save nahi ho saki. Dobara koshish karein.");
    } finally {
      setSaving(false);
    }
  };

  /* ---------------- Render ---------------- */

  const toggleBase = "h-10 rounded-xl text-sm font-semibold border transition";

  return (
    <>
      {/* Floating mic button (offline mein band) */}
      <button
        type="button"
        onClick={openModal}
        disabled={!online}
        aria-label="Bol kar entry karein"
        title={online ? "" : "Bol kar entry ke liye internet chahiye"}
        className="fixed bottom-6 right-6 z-30 w-14 h-14 rounded-full bg-emerald-600 hover:bg-emerald-700 active:scale-95 text-white shadow-lg shadow-emerald-600/30 flex items-center justify-center transition disabled:bg-slate-400 disabled:shadow-none disabled:cursor-not-allowed disabled:active:scale-100"
      >
        <MicIcon className="w-6 h-6" />
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-sm flex items-end sm:items-center justify-center p-4"
          onClick={closeModal}
        >
          <div
            className="bg-white w-full max-w-md max-h-[92dvh] overflow-y-auto rounded-2xl border border-slate-100 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between sticky top-0 bg-white rounded-t-2xl">
              <h3 className="text-sm font-semibold text-slate-900">
                Bol kar entry
              </h3>
              <button
                type="button"
                onClick={closeModal}
                aria-label="Close"
                className="text-slate-400 hover:text-slate-600 text-lg leading-none px-1"
              >
                ×
              </button>
            </div>

            <form onSubmit={handleSave} className="p-5 space-y-4">
              {/* Step 1: bolna ya likhna */}
              <div>
                <label className={labelCls}>Aap ne kya kaha</label>
                <textarea
                  rows={2}
                  value={transcript}
                  onChange={(e) => setTranscript(e.target.value)}
                  placeholder='e.g. "Ali Raza ko 1500 udhar diya"'
                  className="w-full bg-slate-50/60 border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:bg-white focus:border-emerald-500 focus:ring-4 focus:ring-emerald-500/10 transition resize-none"
                />

                <div className="mt-2 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={listening ? stopListening : startListening}
                    disabled={parsing || saving}
                    className={`h-10 px-4 rounded-xl text-sm font-semibold flex items-center gap-2 transition disabled:opacity-60 ${
                      listening
                        ? "bg-red-50 text-red-700 border border-red-200"
                        : "bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100"
                    }`}
                  >
                    <MicIcon
                      className={`w-4 h-4 ${listening ? "animate-pulse" : ""}`}
                    />
                    {listening ? "Sun raha hoon... (rukein)" : "Dobara bolein"}
                  </button>

                  <button
                    type="button"
                    onClick={() => void parseText(transcript)}
                    disabled={parsing || saving || listening || !transcript.trim()}
                    className="h-10 px-4 bg-white border border-slate-200 hover:bg-slate-50 text-slate-700 rounded-xl text-sm font-medium transition disabled:opacity-60"
                  >
                    {parsing ? "Samajh raha hoon..." : "Samjho"}
                  </button>
                </div>
              </div>

              {error && (
                <p className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-xl px-3 py-2">
                  {error}
                </p>
              )}

              {/* Step 2: confirm */}
              {parsed && (
                <div className="space-y-4 pt-1 border-t border-slate-100">
                  <p className="text-xs text-slate-500 pt-3">
                    Save karne se pehle check kar lein. Kuch ghalat ho to yahin theek karein.
                  </p>

                  <div>
                    <label className={labelCls}>Customer Name</label>
                    <input
                      type="text"
                      value={name}
                      onChange={(e) => {
                        setName(e.target.value);
                        setChoice(null);
                      }}
                      placeholder="Customer ka naam"
                      className={inputCls}
                    />

                    {name.trim() && exact && (
                      <p className="mt-1.5 text-xs text-emerald-700">
                        Maujooda khata mil gaya: {exact.name} ({fmt(exact.totalBalance)}{" "}
                        {balanceLabel(exact.totalBalance)})
                      </p>
                    )}

                    {name.trim() && !exact && (
                      <div className="mt-2 space-y-1.5">
                        {candidates.length > 0 && (
                          <p className="text-xs text-slate-500">
                            Kis ke khate mein entry karni hai?
                          </p>
                        )}
                        {candidates.map((c) => (
                          <button
                            key={c.id}
                            type="button"
                            onClick={() => setChoice(c.id)}
                            className={`w-full text-left px-3 py-2 rounded-xl border text-sm transition ${
                              effective === c.id
                                ? "border-emerald-400 bg-emerald-50 text-emerald-800"
                                : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                            }`}
                          >
                            {c.name}{" "}
                            <span className="text-xs text-slate-500">
                              ({fmt(c.totalBalance)} {balanceLabel(c.totalBalance)})
                            </span>
                          </button>
                        ))}
                        <button
                          type="button"
                          onClick={() => setChoice("new")}
                          className={`w-full text-left px-3 py-2 rounded-xl border text-sm transition ${
                            effective === "new"
                              ? "border-emerald-400 bg-emerald-50 text-emerald-800"
                              : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                          }`}
                        >
                          Naya khata banayein: {name.trim()}
                        </button>
                      </div>
                    )}
                  </div>

                  {name.trim() && needsPhone && (
                    <div>
                      <label className={labelCls}>Phone Number (optional)</label>
                      <input
                        type="tel"
                        inputMode="tel"
                        value={phone}
                        onChange={(e) => setPhone(e.target.value)}
                        placeholder="e.g. 03001234567"
                        className={inputCls}
                      />
                      {phoneInvalid ? (
                        <p className="mt-1.5 text-xs text-red-600">
                          Number sahi nahi lagta. Jaise 03001234567 likhein.
                        </p>
                      ) : (
                        <p className="mt-1.5 text-xs text-slate-500">
                          WhatsApp par message bhejne ke liye number zaroori hai.
                        </p>
                      )}
                    </div>
                  )}

                  <div>
                    <label className={labelCls}>Type</label>
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        onClick={() => setTxType("GAVE")}
                        className={`${toggleBase} ${
                          txType === "GAVE"
                            ? "bg-red-50 border-red-300 text-red-700"
                            : "bg-white border-slate-200 text-slate-500 hover:bg-slate-50"
                        }`}
                      >
                        Udhar Diya
                      </button>
                      <button
                        type="button"
                        onClick={() => setTxType("GOT")}
                        className={`${toggleBase} ${
                          txType === "GOT"
                            ? "bg-emerald-50 border-emerald-300 text-emerald-700"
                            : "bg-white border-slate-200 text-slate-500 hover:bg-slate-50"
                        }`}
                      >
                        Vasool Kiya
                      </button>
                    </div>
                  </div>

                  <div>
                    <label className={labelCls}>Amount (PKR)</label>
                    <input
                      type="number"
                      inputMode="decimal"
                      min="0"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      placeholder="e.g. 1500"
                      className={inputCls}
                    />
                  </div>

                  <div className="flex justify-end gap-2 pt-1">
                    <button
                      type="button"
                      onClick={closeModal}
                      disabled={saving}
                      className="h-10 px-4 bg-white border border-slate-200 hover:bg-slate-50 text-slate-700 rounded-xl text-sm font-medium transition"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={!canSave}
                      className="h-10 px-5 bg-emerald-600 hover:bg-emerald-700 active:scale-[0.98] disabled:opacity-60 disabled:cursor-not-allowed text-white rounded-xl text-sm font-semibold shadow-sm shadow-emerald-600/20 transition"
                    >
                      {saving ? "Saving..." : "Entry Save Karein"}
                    </button>
                  </div>
                </div>
              )}
            </form>
          </div>
        </div>
      )}
    </>
  );
}

function MicIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
        d="M19 11a7 7 0 01-14 0m7 7v3m-4 0h8M12 3a3 3 0 00-3 3v5a3 3 0 006 0V6a3 3 0 00-3-3z"
      />
    </svg>
  );
}