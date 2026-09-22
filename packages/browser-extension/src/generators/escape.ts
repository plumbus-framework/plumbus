/** Escape for embedding in generated single-quoted JS/TS string literals. */
export function escapeJsStringLiteral(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/** Escape text embedded in generated HTML (not JSX). */
export function escapeHtmlText(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Escape text embedded as JSX child text (HTML entities + brace literals). */
export function escapeJsxText(s: string): string {
  return escapeHtmlText(s).replace(/\{/g, '&lbrace;').replace(/\}/g, '&rbrace;');
}
