import { useMemo, useState } from "react";
import "../styles/munshi.css";
import Modal from "./Modal";
import { MicIcon, PlusIcon, TrashIcon } from "./Icons";
import { useSpeech } from "../hooks/useSpeech";

import {
  WALK_IN,
  describeSaveError,
  formatRs,
  lineTotal,
  parseSpokenItems,
  round2,
  saleTotal,
  saveSale,
} from "../lib/Sales";
import type { SaleItem, SavedSale } from "../lib/Sales";

export type CustomerOption = {
  id: string;
  name: string;
  phone: string | null;
  totalBalance: number;
};

type Row = {
  key: string;
  name: string;
  qty: string;
  unit: string;
  price: string;
  cost: string;
};

const UNIT_OPTIONS = [
  "pc",
  "kg",
  "g",
  "L",
  "dozen",
  "packet",
  "bottle",
  "bori",
  "peti",
  "m",
];

let rowSeq = 0;
const newRow = (patch: Partial<Row> = {}): Row => {
  rowSeq += 1;
  return {
    key: `row-${rowSeq}`,
    name: "",
    qty: "1",
    unit: "pc",
    price: "",
    cost: "",
    ...patch,
  };
};

const toItem = (r: Row): SaleItem | null => {
  const name = r.name.trim();
  const qty = Number(r.qty);
  const price = Number(r.price);
  if (!name || !(qty > 0) || !(price > 0)) return null;
  const costNum = r.cost.trim() === "" ? NaN : Number(r.cost);
  const base = { name, qty, unit: r.unit, price };
  return Number.isFinite(costNum) && costNum >= 0
    ? { ...base, cost: costNum }
    : base;
};

const balanceNote = (c: CustomerOption): string => {
  if (c.totalBalance > 0)
    return `${c.name} currently owes you ${formatRs(c.totalBalance)}.`;
  if (c.totalBalance < 0)
    return `You currently owe ${c.name} ${formatRs(Math.abs(c.totalBalance))}.`;
  return `${c.name} has no outstanding balance.`;
};

export default function NewSaleModal({
  userId,
  customers,
  onClose,
  onSaved,
}: {
  userId: string;
  customers: CustomerOption[];
  onClose: () => void;
  onSaved: (sale: SavedSale) => void;
}) {
  const [customerId, setCustomerId] = useState("");
  const [rows, setRows] = useState<Row[]>(() => [newRow()]);
  const [paidInput, setPaidInput] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [showCost, setShowCost] = useState(false);
  const [lang, setLang] = useState<"ur-PK" | "en-US">("ur-PK");
  const [heard, setHeard] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [customerPhone, setCustomerPhone] = useState("");

  const customer = customers.find((c) => c.id === customerId) ?? null;

  const items = useMemo(
    () => rows.map(toItem).filter((i): i is SaleItem => i !== null),
    [rows],
  );
  const total = saleTotal(items);
  // Walk-in customers pay in full. Registered customers default to credit.
  const paid = customer
    ? paidInput === null
      ? 0
      : Math.min(total, Math.max(0, Number(paidInput) || 0))
    : total;
  const due = round2(total - paid);

  const addFromVoice = (text: string) => {
    setHeard(text);
    const parsed = parseSpokenItems(text);
    if (parsed.length === 0) {
      setError(
        "Could not understand that. Try: 2 kilo chawal 150, 1 dozen anday 300",
      );
      return;
    }
    setError(null);
    const fresh = parsed.map((p) =>
      newRow({
        name: p.name,
        qty: String(p.qty),
        unit: p.unit,
        price: p.price > 0 ? String(p.price) : "",
      }),
    );
    setRows((prev) => [
      ...prev.filter((r) => r.name.trim() || r.price.trim()),
      ...fresh,
    ]);
  };

  const speech = useSpeech(lang, addFromVoice);

  const updateRow = (key: string, patch: Partial<Row>) =>
    setRows((prev) =>
      prev.map((r) => (r.key === key ? { ...r, ...patch } : r)),
    );

  const removeRow = (key: string) =>
    setRows((prev) =>
      prev.length === 1 ? [newRow()] : prev.filter((r) => r.key !== key),
    );

  const submit = async () => {
    if (items.length === 0) {
      setError("Add at least one item with a name, quantity and rate.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const sale = await saveSale({
        userId,
        customerId: customer?.id ?? null,
        customerName: customer?.name ?? WALK_IN,
        customerPhone: customerPhone.trim() || null,
        items,
        paid,
        note: note.trim(),
      });
      onSaved(sale);
    } catch (err) {
      console.error("Save sale failed:", err);
      setError(describeSaveError(err));
      setSaving(false);
    }
  };

  return (
    <Modal title="New sale" onClose={onClose}>
      <div className="mn-dialog-body">
        <div className="mn-field">
          <label htmlFor="sale-customer">Customer</label>
          <select
            id="sale-customer"
            className="mn-input"
            value={customerId}
            onChange={(e) => {
              const selectedId = e.target.value;
              const selectedCustomer =
                customers.find((c) => c.id === selectedId) ?? null;

              setCustomerId(selectedId);
              setPaidInput(null);
              setCustomerPhone(selectedCustomer?.phone ?? "");
            }}
          >
            <option value="">Walk-in customer (cash sale)</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.totalBalance > 0
                  ? ` (owes ${formatRs(c.totalBalance)})`
                  : ""}
              </option>
            ))}
          </select>
          <p className="mn-voice-note">
            {customer
              ? balanceNote(customer)
              : "Walk-in sales are recorded as paid in full."}
          </p>
        </div>

        <div className="mn-field">
          <label htmlFor="sale-customer-phone">Customer phone number</label>
          <input
            id="sale-customer-phone"
            className="mn-input"
            type="tel"
            inputMode="tel"
            placeholder="e.g. 03001234567"
            value={customerPhone}
            onChange={(e) => setCustomerPhone(e.target.value)}
          />
        </div>

        <div>
          <div className="mn-items-head">
            <span className="mn-field-label" style={{ margin: 0 }}>
              Items
            </span>
            <div className="mn-voice-controls">
              <div className="mn-seg" role="group" aria-label="Voice language">
                <button
                  type="button"
                  aria-pressed={lang === "ur-PK"}
                  onClick={() => setLang("ur-PK")}
                >
                  اردو
                </button>
                <button
                  type="button"
                  aria-pressed={lang === "en-US"}
                  onClick={() => setLang("en-US")}
                >
                  English
                </button>
              </div>
              {speech.supported && (
                <button
                  type="button"
                  className="mn-mic"
                  data-live={speech.listening ? "true" : "false"}
                  onClick={speech.listening ? speech.stop : speech.start}
                >
                  <MicIcon size={16} />
                  {speech.listening ? "Stop" : "Speak"}
                </button>
              )}
            </div>
          </div>

          {!speech.supported && (
            <p className="mn-voice-note">
              Voice input works in Chrome and Edge.
            </p>
          )}
          {speech.interim && <p className="mn-voice-note">{speech.interim}</p>}
          {speech.error && <p className="mn-error">{speech.error}</p>}
          {heard && !speech.listening && (
            <p className="mn-voice-note">
              Heard: &ldquo;{heard}&rdquo;. Check the rows below.
            </p>
          )}
          <p className="mn-voice-note">
            Say items like &ldquo;2 kilo chawal 150, 1 dozen anday 300&rdquo;:
            quantity first, rate last.
          </p>

          {rows.map((r) => {
            const item = toItem(r);
            return (
              <div key={r.key} className="mn-item">
                <div className="mn-item-top">
                  <input
                    className="mn-input"
                    value={r.name}
                    onChange={(e) => updateRow(r.key, { name: e.target.value })}
                    placeholder="Item name"
                    aria-label="Item name"
                  />
                  <button
                    type="button"
                    className="mn-iconbtn"
                    onClick={() => removeRow(r.key)}
                    aria-label="Remove item"
                  >
                    <TrashIcon size={16} />
                  </button>
                </div>
                <div className="mn-item-grid">
                  <input
                    className="mn-input mn-num"
                    value={r.qty}
                    onChange={(e) => updateRow(r.key, { qty: e.target.value })}
                    inputMode="decimal"
                    placeholder="Qty"
                    aria-label="Quantity"
                  />
                  <select
                    className="mn-input"
                    value={r.unit}
                    onChange={(e) => updateRow(r.key, { unit: e.target.value })}
                    aria-label="Unit"
                  >
                    {UNIT_OPTIONS.map((u) => (
                      <option key={u} value={u}>
                        {u}
                      </option>
                    ))}
                  </select>
                  <input
                    className="mn-input mn-num"
                    value={r.price}
                    onChange={(e) =>
                      updateRow(r.key, { price: e.target.value })
                    }
                    inputMode="decimal"
                    placeholder="Rate"
                    aria-label="Rate per unit"
                  />
                  <span className="mn-item-total mn-num">
                    {item ? formatRs(lineTotal(item)) : "-"}
                  </span>
                </div>
                {showCost && (
                  <input
                    className="mn-input mn-num"
                    value={r.cost}
                    onChange={(e) => updateRow(r.key, { cost: e.target.value })}
                    inputMode="decimal"
                    placeholder="Purchase cost per unit (optional)"
                    aria-label="Purchase cost per unit"
                  />
                )}
              </div>
            );
          })}

          <div
            style={{ display: "flex", justifyContent: "center", marginTop: 8 }}
          >
            <button
              type="button"
              className="mn-add"
              onClick={() => setRows((prev) => [...prev, newRow()])}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                padding: "8px 12px",
                borderRadius: 10,
                background: "#ffffff",
                border: "1px solid #ececec",
                color: "#065f46",
                fontWeight: 600,
              }}
            >
              <PlusIcon size={14} /> Add another item
            </button>
          </div>

          <label className="mn-check">
            <input
              type="checkbox"
              checked={showCost}
              onChange={(e) => setShowCost(e.target.checked)}
            />
            Enter purchase cost to track exact profit
          </label>
        </div>

        {customer && (
          <div className="mn-field">
            <label htmlFor="sale-paid">Received now</label>
            <input
              id="sale-paid"
              className="mn-input mn-input-num mn-num"
              value={paidInput ?? ""}
              onChange={(e) => setPaidInput(e.target.value)}
              inputMode="decimal"
              placeholder="0"
            />
            <div className="mn-quick" style={{ marginTop: 8 }}>
              <button
                type="button"
                className="mn-btn mn-btn-sm"
                onClick={() => setPaidInput(String(total))}
              >
                Paid in full
              </button>
              <button
                type="button"
                className="mn-btn mn-btn-sm"
                onClick={() => setPaidInput(null)}
              >
                Put on credit
              </button>
            </div>
          </div>
        )}

        <div className="mn-field">
          <label htmlFor="sale-note">Note (optional)</label>
          <input
            id="sale-note"
            className="mn-input"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>

        {error && (
          <p className="mn-error" role="alert">
            {error}
          </p>
        )}
      </div>

      <div className="mn-dialog-foot">
        <div>
          <p className="mn-foot-total mn-num">{formatRs(total)}</p>
          <p
            className="mn-foot-sub"
            data-tone={customer && due > 0 ? "warn" : undefined}
          >
            {customer && due > 0
              ? `Balance due ${formatRs(due)}`
              : total > 0
                ? "Paid in full"
                : "Add items to continue"}
          </p>
        </div>
        <button
          type="button"
          className="mn-btn mn-btn-primary"
          onClick={submit}
          disabled={saving}
        >
          {saving ? "Saving..." : "Save and view receipt"}
        </button>
      </div>
    </Modal>
  );
}
