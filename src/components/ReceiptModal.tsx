import { useEffect, useRef, useState } from "react";
import "../styles/munshi.css";
import Modal from "./Modal";
import { toBlob } from "html-to-image";
import { ChatIcon, CheckIcon, PrintIcon } from "./Icons";
import {
  DEFAULT_SHOP,
  buildReceiptText,
  formatDateTime,
  formatRs,
  getShopName,
  lineTotal,
  setShopName,
} from "../lib/Sales";
import type { SavedSale } from "../lib/Sales";

export default function ReceiptModal({
  sale,
  onClose,
}: {
  sale: SavedSale;
  onClose: () => void;
}) {
  const [shop, setShop] = useState<string>(getShopName);
  // const [copied, setCopied] = useState(false);

  const name = shop.trim() || DEFAULT_SHOP;
  const text = buildReceiptText(sale, name);
  const settled = sale.balanceDue <= 0;

  const changeShop = (value: string) => {
    setShop(value);
    setShopName(value);
  };

  // The image is prepared in advance...
  const blobRef = useRef<Blob | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    blobRef.current = null;
    const timer = setTimeout(async () => {
      const node = document.getElementById("receipt-print");
      if (!node) return;
      try {
        const blob = await toBlob(node, {
          pixelRatio: 3,
          backgroundColor: "#ffffff",
          cacheBust: true,
        });
        if (!cancelled && blob) {
          blobRef.current = blob;
          setReady(true);
        }
      } catch (err) {
        console.error("Receipt image failed:", err);
      }
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      setReady(false);
    };
  }, [name, sale]);

  // Step 1: copy the image. Step 2: open the customer's chat and paste.
  const [step, setStep] = useState<"idle" | "copied" | "saved">("idle");

  let phone = (sale.customerPhone ?? "").replace(/\D/g, "").replace(/^00+/, "");
  if (phone.length === 11 && phone.startsWith("0"))
    phone = `92${phone.slice(1)}`;
  else if (phone.length === 10 && phone.startsWith("3")) phone = `92${phone}`;
  const hasNumber = /^92\d{10}$/.test(phone);
  const chatUrl = hasNumber ? `https://wa.me/${phone}` : "https://wa.me/";

  const copyImage = async () => {
    const blob = blobRef.current;
    if (!blob) return;
    try {
      await navigator.clipboard.write([
        new ClipboardItem({ "image/png": blob }),
      ]);
      setStep("copied");
      return;
    } catch (err) {
      console.error("Clipboard image failed:", err);
    }
    const file = new File([blob], `Receipt-${sale.receiptNo}.png`, {
      type: "image/png",
    });
    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({
          files: [file],
          title: `Receipt ${sale.receiptNo}`,
          text,
        });
        return;
      } catch {
        // cancelled
      }
    }
    const href = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = href;
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 60000);
    setStep("saved");
  };

  // Helper: split "Rs. 420" into currency + amount nodes for reliable alignment.
  const renderRs = (formatted?: string | null) => {
    const s = (formatted ?? "").toString();
    // match "Rs.", "Rs", "Rs." with optional space followed by amount
    const m = s.match(/^(Rs\.?)\s*(.*)$/i);
    if (m) {
      return (
        <>
          <span className="mn-currency">{m[1]}</span>
          <span className="mn-amount">{m[2]}</span>
        </>
      );
    }
    // fallback: render whole string as amount
    return <span className="mn-amount">{s}</span>;
  };

  return (
    <Modal title="Receipt" onClose={onClose} top dismissOnBackdrop>
      <div className="mn-receipt-body">
        <div className="mn-field">
          <label htmlFor="receipt-shop">Shop name on receipt</label>
          <input
            id="receipt-shop"
            className="mn-input"
            value={shop}
            onChange={(e) => changeShop(e.target.value)}
          />
        </div>

        <article
          id="receipt-print"
          className="mn-slip"
          aria-label={`Receipt ${sale.receiptNo}`}
        >
          <p className="mn-slip-shop">{name}</p>
          <p className="mn-slip-kind">Sales receipt</p>

          <dl className="mn-slip-meta">
            <div>
              <dt>Receipt no.</dt>
              <dd className="mn-num">{sale.receiptNo}</dd>
            </div>
            <div>
              <dt>Date</dt>
              <dd>{formatDateTime(sale.createdAt)}</dd>
            </div>
            <div className="mn-span">
              <dt>Customer</dt>
              <dd>{sale.customerName}</dd>
            </div>
          </dl>

          <ul className="mn-slip-items">
            {sale.items.map((it, idx) => (
              <li key={`${it.name}-${idx}`}>
                <span className="mn-it-name">{it.name}</span>
                <span className="mn-it-calc mn-num">
                  {it.qty} {it.unit} &times; {formatRs(it.price)}
                </span>
                <span className="mn-it-amt mn-num">
                  {renderRs(formatRs(lineTotal(it)))}
                </span>
              </li>
            ))}
          </ul>

          <ul className="mn-slip-totals">
            <li className="mn-grand">
              <span>Total</span>
              <span className="mn-lead" aria-hidden="true" />
              <span className="mn-num">{renderRs(formatRs(sale.total))}</span>
            </li>
            <li>
              <span>Paid</span>
              <span className="mn-lead" aria-hidden="true" />
              <span className="mn-num">{renderRs(formatRs(sale.paid))}</span>
            </li>
            {!settled && (
              <li>
                <span>Balance due</span>
                <span className="mn-lead" aria-hidden="true" />
                <span className="mn-num">
                  {renderRs(formatRs(sale.balanceDue))}
                </span>
              </li>
            )}
          </ul>

          <div className="mn-stamp-wrap">
            <span className="mn-stamp" data-state={settled ? "paid" : "due"}>
              {settled ? "PAID" : "BALANCE DUE"}
            </span>
          </div>

          {sale.note && <p className="mn-slip-note">Note: {sale.note}</p>}
          <p className="mn-slip-foot">
            <strong>Thank you for your business.</strong>
          </p>
        </article>
      </div>

      <div className="mn-receipt-foot">
        <ol className="mn-wa-steps" aria-label="How to share receipt">
          <li data-state={step === "idle" ? "current" : "done"}>
            <span className="mn-wa-dot">
              {step === "idle" ? "1" : <CheckIcon size={12} />}
            </span>
            Prepare Receipt
          </li>

          <li data-state={step === "idle" ? "todo" : "current"}>
            <span className="mn-wa-dot">2</span>
            Open WhatsApp
          </li>

          <li data-state="todo">
            <span className="mn-wa-dot">3</span>
            Attach & Send
          </li>
        </ol>

        {step !== "idle" && (
          <p className="mn-wa-note" role="status">
            {step === "copied" ? (
              <>
                <strong>Receipt is ready!</strong> Open WhatsApp and paste the
                image if your device supports it. Otherwise, save the image and
                attach it from your Gallery.
              </>
            ) : (
              <>
                <strong>Receipt saved!</strong> Open WhatsApp, tap + or the
                attachment icon, choose Gallery, select your receipt, and tap
                Send.
              </>
            )}
          </p>
        )}

        {step === "idle" ? (
          <button
            type="button"
            className="mn-btn mn-btn-wa"
            onClick={copyImage}
            disabled={!ready}
          >
            <ChatIcon size={18} />
            <span>{ready ? "Send Receipt on WhatsApp" : "Please Wait..."}</span>
          </button>
        ) : (
          <a
            className="mn-btn mn-btn-wa"
            href={chatUrl}
            target="_blank"
            rel="noreferrer"
          >
            <ChatIcon size={18} />
            <span>{hasNumber ? "Open WhatsApp Chat" : "Open WhatsApp"}</span>
          </a>
        )}

        {/* Sub container wrapper */}
        <div
          className="mn-receipt-sub"
          style={{ display: "flex", gap: "12px", marginTop: "16px" }}
        >
          <button
            type="button"
            className="mn-btn"
            onClick={() => window.print()}
            style={{
              flex: 1,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              gap: "8px",
              padding: "10px 16px",
              border: "1px solid #e2e8f0",
              borderRadius: "8px",
              cursor: "pointer",
            }}
          >
            <PrintIcon size={16} />
            <span>Print Receipt</span>
          </button>

          <button
            type="button"
            className="mn-btn"
            onClick={onClose}
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              padding: "10px 20px",
              border: "1px solid #e2e8f0",
              borderRadius: "8px",
              cursor: "pointer",
            }}
          >
            <span>Close</span>
          </button>
        </div>
      </div>
    </Modal>
  );
}