import { useId } from "react";
import type { ReactNode } from "react";
import "../styles/munshi.css";
import { CloseIcon } from "./Icons";
import { useModal } from "../hooks/useModal";

export default function Modal({
  title,
  onClose,
  children,
  top = false,
  dismissOnBackdrop = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  top?: boolean;
  dismissOnBackdrop?: boolean;
}) {
  const ref = useModal(onClose);
  const titleId = useId();

  return (
    <div
      className="mn-overlay"
      data-top={top ? "true" : undefined}
      onMouseDown={(e) => {
        if (dismissOnBackdrop && e.target === e.currentTarget) onClose();
      }}
    >
      <div ref={ref} className="mn-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <div className="mn-dialog-head">
          <h2 className="mn-h" id={titleId}>
            {title}
          </h2>
          <button type="button" className="mn-iconbtn" onClick={onClose} aria-label="Close">
            <CloseIcon />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
