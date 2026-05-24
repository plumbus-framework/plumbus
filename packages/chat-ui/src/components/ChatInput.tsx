'use client';

export function ChatInput({
  pending,
  onSend,
  className,
}: {
  pending: boolean;
  onSend: (text: string) => void;
  className?: string;
}) {
  return (
    <form
      className={className}
      onSubmit={(e) => {
        e.preventDefault();
        const form = e.currentTarget;
        const fd = new FormData(form);
        const text = String(fd.get('message') ?? '').trim();
        if (text) onSend(text);
        form.reset();
      }}
    >
      <textarea name="message" rows={2} disabled={pending} />
      <button type="submit" disabled={pending}>
        Send
      </button>
    </form>
  );
}
