import { useEffect, useRef, useState } from "react";
import DigitalQueuePass from "./DigitalQueuePass";
import QueueTicketActions from "./QueueTicketActions";
import { fetchExistingQueueTicket } from "../lib/queueTicket";

export default function QueueTicketDialog({ ticket, onClose, onTicketUpdate }) {
  const dialogRef = useRef(null);
  const fullscreenRef = useRef(null);
  const closeRef = useRef(onClose);
  const sessionRef = useRef(null);
  const revisionRef = useRef(0);
  const verifiedRef = useRef(null);
  const retryRef = useRef(null);
  const [verifiedTicket, setVerifiedTicket] = useState(null);
  const [photoMode, setPhotoMode] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  const [fullscreenAvailable, setFullscreenAvailable] = useState(false);
  closeRef.current = onClose;

  useEffect(() => {
    if (!ticket) return undefined;
    const dialog = dialogRef.current;
    const fullscreenTarget = fullscreenRef.current;
    const previousFocus = document.activeElement;
    const session = { patientId: String(ticket.patientId), cancelled: false, inFlight: false, deliveryPending: false, timer: null, scheduleRefresh: null };
    sessionRef.current = session;
    revisionRef.current += 1;
    verifiedRef.current = null;
    setPhotoMode(false);
    setVerifiedTicket(null);
    setChecking(true);
    setError("");
    setFullscreenAvailable(!!document.fullscreenEnabled && typeof fullscreenTarget?.requestFullscreen === "function");
    if (!dialog.open) dialog.showModal();

    function scheduleRefresh() {
      clearTimeout(session.timer);
      if (!session.cancelled && !session.deliveryPending && !session.inFlight) {
        session.timer = setTimeout(refresh, 5000);
      }
    }

    async function refresh() {
      if (session.cancelled || session.inFlight || session.deliveryPending) return;
      clearTimeout(session.timer);
      session.inFlight = true;
      const revision = revisionRef.current;
      // Successful background reads keep Photo Mode free of loading controls.
      if (!verifiedRef.current) setChecking(true);
      try {
        const fresh = await fetchExistingQueueTicket(ticket.patientId);
        if (!session.cancelled && revisionRef.current === revision) {
          verifiedRef.current = fresh;
          setVerifiedTicket(fresh);
          setError("");
        }
      } catch (failure) {
        if (!session.cancelled && revisionRef.current === revision) {
          // An auth/read failure must never leave a waiting pass looking valid.
          verifiedRef.current = null;
          setVerifiedTicket(null);
          setError(failure.message || "The current ticket could not be verified.");
        }
      } finally {
        session.inFlight = false;
        if (!session.cancelled) {
          setChecking(false);
          scheduleRefresh();
        }
      }
    }
    session.scheduleRefresh = scheduleRefresh;
    retryRef.current = refresh;
    refresh();
    return () => {
      session.cancelled = true;
      clearTimeout(session.timer);
      if (sessionRef.current === session) {
        sessionRef.current = null;
        retryRef.current = null;
        verifiedRef.current = null;
      }
      if (document.fullscreenElement === fullscreenTarget) document.exitFullscreen?.().catch(() => {});
      if (dialog.open) dialog.close();
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [ticket?.patientId]);

  // The parent identifies the record. Only this session's authenticated reads
  // and refreshed delivery results may set status; parent polls can arrive late.
  const currentTicket = verifiedTicket && String(verifiedTicket.patientId) === String(ticket?.patientId)
    ? verifiedTicket : null;
  const currentSession = sessionRef.current;
  async function enterFullscreen() {
    const fullscreenTarget = fullscreenRef.current;
    try {
      // The Fullscreen API rejects <dialog>; its content is an eligible div.
      await fullscreenTarget.requestFullscreen();
      if (sessionRef.current === currentSession && !currentSession?.cancelled) setPhotoMode(true);
      else if (document.fullscreenElement === fullscreenTarget) document.exitFullscreen?.().catch(() => {});
    } catch {
      if (sessionRef.current === currentSession && !currentSession?.cancelled) {
        setError("Full screen is unavailable. Photo Mode still shows a clean ticket.");
      }
    }
  }

  function togglePhotoMode() {
    if (photoMode && document.fullscreenElement === fullscreenRef.current) document.exitFullscreen?.().catch(() => {});
    setPhotoMode(value => !value);
  }

  function updateTicket(fresh) {
    if (!currentSession || currentSession.cancelled || sessionRef.current !== currentSession || String(fresh.patientId) !== currentSession.patientId) return;
    revisionRef.current += 1;
    verifiedRef.current = fresh;
    setVerifiedTicket(fresh);
    setError("");
    onTicketUpdate?.(fresh);
  }

  function beginDeliveryVerification() {
    const session = currentSession;
    if (!session || session.cancelled || sessionRef.current !== session) return undefined;
    // Invalidate a read already running and prevent later polls from overtaking
    // the delivery read. The returned lease also resumes polling on unmount.
    revisionRef.current += 1;
    session.deliveryPending = true;
    clearTimeout(session.timer);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (session.cancelled || sessionRef.current !== session) return;
      session.deliveryPending = false;
      session.scheduleRefresh();
    };
  }

  if (!ticket) return null;
  return (
    <dialog ref={dialogRef} className={`queue-ticket-dialog${photoMode ? " queue-ticket-dialog--photo" : ""}`} aria-labelledby="queue-ticket-dialog-title" onCancel={event => { event.preventDefault(); closeRef.current?.(); }}>
      <div ref={fullscreenRef} className="queue-ticket-dialog__content">
        <div className="queue-ticket-dialog__controls">
          <div>
            <h2 id="queue-ticket-dialog-title">{photoMode ? "Digital Queue Pass · Photo Mode" : "Digital Queue Pass"}</h2>
            {!photoMode && <p>Photograph this pass from the monitor, download an image, or print the same ticket.</p>}
          </div>
          <div className="queue-ticket-dialog__toolbar">
            <button type="button" className="queue-ticket-button" onClick={togglePhotoMode} disabled={!photoMode && (checking || !currentTicket)}>{photoMode ? "Exit Photo Mode" : "Photo Mode"}</button>
            {!photoMode && fullscreenAvailable && <button type="button" className="queue-ticket-button" onClick={enterFullscreen} disabled={checking || !currentTicket}>Full Screen</button>}
            <button type="button" className="queue-ticket-button" autoFocus onClick={() => closeRef.current?.()} aria-label="Close digital queue pass">Close</button>
          </div>
        </div>
        {checking && <p className="queue-ticket-dialog__message" role="status">Verifying the saved queue ticket…</p>}
        {error && <p className="queue-ticket-error" role="alert">{error}</p>}
        {error && !currentTicket && <button type="button" className="queue-ticket-button" onClick={() => retryRef.current?.()} disabled={checking}>Retry Verification</button>}
        {currentTicket && <div className="queue-ticket-dialog__ticket"><DigitalQueuePass ticket={currentTicket} /></div>}
        {!photoMode && currentTicket && <div className="queue-ticket-dialog__delivery"><QueueTicketActions ticket={currentTicket} onTicketUpdate={updateTicket} onVerificationStart={beginDeliveryVerification} disabled={checking} /></div>}
      </div>
    </dialog>
  );
}
