'use client';

export function ConfirmationDialog({
  pendingConfirmation,
  onConfirm,
  onReject,
}: {
  pendingConfirmation: {
    actionId: string;
    confirmationMessage: string;
  } | null;
  onConfirm: () => void;
  onReject: () => void;
}) {
  if (!pendingConfirmation) return null;
  return (
    <div role="dialog">
      <p>{pendingConfirmation.confirmationMessage}</p>
      <button type="button" onClick={onConfirm}>
        Confirm
      </button>
      <button type="button" onClick={onReject}>
        Cancel
      </button>
    </div>
  );
}
