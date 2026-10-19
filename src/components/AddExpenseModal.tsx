import { useState } from "react";
import "../styles/munshi.css";
import Modal from "./Modal";
import { EXPENSE_CATEGORIES, addExpense, describeSaveError, formatRs } from "../lib/Sales";

export default function AddExpenseModal({
  userId,
  onClose,
  onSaved,
}: {
  userId: string;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const [amount, setAmount] = useState("");
  const [category, setCategory] = useState<string>(EXPENSE_CATEGORIES[0]);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const value = Number(amount);
  const valid = Number.isFinite(value) && value > 0;

  const submit = async () => {
    if (!valid) {
      setError("Enter the expense amount.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await addExpense({ userId, amount: value, category, note: note.trim() });
      onSaved(`Expense saved: ${category}, ${formatRs(value)}`);
    } catch (err) {
      console.error("Add expense failed:", err);
      setError(describeSaveError(err));
      setSaving(false);
    }
  };

  return (
    <Modal title="Add expense" onClose={onClose}>
      <div className="mn-dialog-body">
        <div className="mn-field">
          <label htmlFor="exp-amount">Amount</label>
          <input
            id="exp-amount"
            className="mn-input mn-input-num mn-num"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputMode="decimal"
            placeholder="0"
          />
        </div>

        <div className="mn-field">
          <span className="mn-field-label">Category</span>
          <div className="mn-chip-row" role="group" aria-label="Expense category">
            {EXPENSE_CATEGORIES.map((c) => (
              <button key={c} type="button" className="mn-chip" aria-pressed={category === c} onClick={() => setCategory(c)}>
                {c}
              </button>
            ))}
          </div>
        </div>

        <div className="mn-field">
          <label htmlFor="exp-note">Note (optional)</label>
          <input id="exp-note" className="mn-input" value={note} onChange={(e) => setNote(e.target.value)} />
        </div>

        {error && (
          <p className="mn-error" role="alert">
            {error}
          </p>
        )}
      </div>

      <div className="mn-dialog-foot">
        <p className="mn-foot-sub" style={{ margin: 0 }}>
          Expenses are subtracted from profit.
        </p>
        <button type="button" className="mn-btn mn-btn-primary" onClick={submit} disabled={saving}>
          {saving ? "Saving..." : "Save expense"}
        </button>
      </div>
    </Modal>
  );
}
