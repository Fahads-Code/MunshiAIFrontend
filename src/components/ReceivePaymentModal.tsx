import { useMemo, useState } from "react";
import "../styles/munshi.css";
import Modal from "./Modal";
import type { CustomerOption } from "./NewSaleModal";
import { describeSaveError, formatRs, recordPayment, round2 } from "../lib/Sales";

export default function ReceivePaymentModal({
  userId,
  customers,
  initialCustomerId,
  onClose,
  onSaved,
}: {
  userId: string;
  customers: CustomerOption[];
  initialCustomerId: string;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const sorted = useMemo(() => [...customers].sort((a, b) => b.totalBalance - a.totalBalance), [customers]);
  const [customerId, setCustomerId] = useState(initialCustomerId);
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const customer = customers.find((c) => c.id === customerId) ?? null;
  const value = Number(amount);
  const valid = customer !== null && Number.isFinite(value) && value > 0;
  const after = customer && valid ? round2(customer.totalBalance - value) : null;

  const submit = async () => {
    if (!customer || !valid) {
      setError("Choose a customer and enter the amount received.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await recordPayment({
        userId,
        customerId: customer.id,
        customerName: customer.name,
        amount: value,
        note: note.trim(),
      });
      onSaved(`Recorded ${formatRs(value)} from ${customer.name}`);
    } catch (err) {
      console.error("Record payment failed:", err);
      setError(describeSaveError(err));
      setSaving(false);
    }
  };

  const summary =
    after === null
      ? customer
        ? customer.totalBalance > 0
          ? `Balance ${formatRs(customer.totalBalance)}`
          : "No balance due"
        : "Select a customer"
      : after > 0
        ? `Remaining balance ${formatRs(after)}`
        : after === 0
          ? "Account will be settled"
          : `Overpaid by ${formatRs(Math.abs(after))} (kept as advance)`;

  return (
    <Modal title="Receive payment" onClose={onClose}>
      <div className="mn-dialog-body">
        <div className="mn-field">
          <label htmlFor="pay-customer">Customer</label>
          <select
            id="pay-customer"
            className="mn-input"
            value={customerId}
            onChange={(e) => setCustomerId(e.target.value)}
          >
            <option value="">Select customer</option>
            {sorted.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.totalBalance > 0 ? ` (owes ${formatRs(c.totalBalance)})` : ""}
              </option>
            ))}
          </select>
        </div>

        <div className="mn-field">
          <label htmlFor="pay-amount">Amount received</label>
          <input
            id="pay-amount"
            className="mn-input mn-input-num mn-num"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputMode="decimal"
            placeholder="0"
          />
          <div className="mn-quick" style={{ marginTop: 8 }}>
            <button
              type="button"
              className="mn-btn mn-btn-sm"
              disabled={!customer || customer.totalBalance <= 0}
              onClick={() => customer && setAmount(String(customer.totalBalance))}
            >
              Full balance
            </button>
          </div>
        </div>

        <div className="mn-field">
          <label htmlFor="pay-note">Note (optional)</label>
          <input id="pay-note" className="mn-input" value={note} onChange={(e) => setNote(e.target.value)} />
        </div>

        {error && (
          <p className="mn-error" role="alert">
            {error}
          </p>
        )}
      </div>

      <div className="mn-dialog-foot">
        <p className="mn-foot-sub" style={{ margin: 0 }}>
          {summary}
        </p>
        <button type="button" className="mn-btn mn-btn-primary" onClick={submit} disabled={saving}>
          {saving ? "Saving..." : "Record payment"}
        </button>
      </div>
    </Modal>
  );
}
