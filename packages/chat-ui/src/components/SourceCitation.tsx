'use client';

export function SourceCitation({ label, url }: { label: string; url?: string }) {
  if (url) {
    return (
      <a href={url} className="text-xs underline">
        {label}
      </a>
    );
  }
  return <span className="text-xs opacity-70">{label}</span>;
}
