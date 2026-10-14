import { useEffect, useRef, useState } from "react";
import { downloadQueueTicket, fetchExistingQueueTicket, openThermalTicketWindow, printQueueTicket } from "../lib/queueTicket";

export default function QueueTicketActions({ ticket, onView, onTicketUpdate, onVerificationStart, disabled = false }) {
  const lock = useRef(false);
  const aliveRef = useRef(true);
  const popupRef = useRef(null);
  const verificationCleanupRef = useRef(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      if (popupRef.current && !popupRef.current.closed) popupRef.current.close();
      popupRef.current = null;
      verificationCleanupRef.current?.();
      verificationCleanupRef.current = null;
    };
  }, []);

  async function deliver(action) {
    if (!ticket || disabled || lock.current || !aliveRef.current) return;
    lock.current = true;
    setBusy(action);
    setError("");
    setNotice("");
    let popup;
    let finishVerification;
    try {
      // Opening synchronously preserves the existing browser-print behavior.
      if (action === "print") {
        popup = openThermalTicketWindow();
        popupRef.current = popup;
      }
      // Dialogs pause their status polling until this read and delivery finish.
      // Release on unmount too, so entering Photo Mode cannot leave it paused.
      const releaseVerification = onVerificationStart?.();
      if (typeof releaseVerification === "function") {
        let released = false;
        finishVerification = () => {
          if (released) return;
          released = true;
          releaseVerification();
        };
        verificationCleanupRef.current = finishVerification;
      }
      const freshTicket = await fetchExistingQueueTicket(ticket.patientId);
      if (!aliveRef.current) {
        if (popup && !popup.closed) popup.close();
        return;
      }
      onTicketUpdate?.(freshTicket);
      if (action === "view") {
        onView?.(freshTicket);
      } else if (action === "download") {
        const downloaded = await downloadQueueTicket(freshTicket, { isCancelled: () => !aliveRef.current });
        if (aliveRef.current && downloaded !== false) setNotice("Ticket image downloaded. The image is a saved snapshot.");
      } else {
        printQueueTicket(freshTicket, popup);
        popupRef.current = null;
        setNotice("Thermal ticket opened for printing.");
      }
    } catch (failure) {
      if (popup && !popup.closed) popup.close();
      if (aliveRef.current) setError(failure.message || "The ticket could not be delivered. Please retry.");
    } finally {
      finishVerification?.();
      if (verificationCleanupRef.current === finishVerification) verificationCleanupRef.current = null;
      lock.current = false;
      popupRef.current = null;
      if (aliveRef.current) setBusy("");
    }
  }

  return (
    <div className="queue-ticket-actions">
      <div className="queue-ticket-actions__buttons" aria-label="Ticket delivery options">
        {onView && <button type="button" className="queue-ticket-button queue-ticket-button--primary" disabled={!ticket || disabled || !!busy} aria-busy={busy === "view"} onClick={() => deliver("view")}><i className="bi bi-ticket-perforated" aria-hidden="true" />{busy === "view" ? "Opening pass…" : "View Digital Pass"}</button>}
        <button type="button" className="queue-ticket-button" disabled={!ticket || disabled || !!busy} aria-busy={busy === "download"} onClick={() => deliver("download")}><i className="bi bi-download" aria-hidden="true" />{busy === "download" ? "Preparing image…" : "Download Image"}</button>
        <button type="button" className="queue-ticket-button" disabled={!ticket || disabled || !!busy} aria-busy={busy === "print"} onClick={() => deliver("print")}><i className="bi bi-printer" aria-hidden="true" />{busy === "print" ? "Preparing ticket…" : "Print Thermal Ticket"}</button>
      </div>
      {error && <p className="queue-ticket-error" role="alert">{error}</p>}
      {notice && <p className="queue-ticket-notice" role="status">{notice}</p>}
    </div>
  );
}
