'use client';

export function ConfirmationDialog({
  pendingConfirmation,
  onConfirm,
  onReject,
  busy = false,
}: {
  pendingConfirmation: {
    actionId: string;
    confirmationMessage: string;
  } | null;
  onConfirm: () => void;
  /** Cancel button = decline; posts a `reject` decision to the server. */
  onReject: () => void;
  busy?: boolean;
}) {
  if (!pendingConfirmation) return null;
  return (
    <div role="dialog">
      <p>{pendingConfirmation.confirmationMessage}</p>
      <button type="button" onClick={onConfirm} disabled={busy}>
        Confirm
      </button>
      <button type="button" onClick={onReject} disabled={busy}>
        Cancel
      </button>
    </div>
  );
}
