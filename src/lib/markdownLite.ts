/* ------------------------------------------------------------------ */
/* Chhota markdown helper (assistant ke jawab dikhane ke liye)         */
/* Pehle har cheez ko escape karta hai, phir sirf apne tags lagata hai */
/* is liye jawab mein koi HTML/script chalne ka khatra nahi.           */
/* ------------------------------------------------------------------ */

function escapeHtml(str: string) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function inline(str: string) {
  let out = escapeHtml(str);
  out = out.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[^\w])__(.+?)__(?!\w)/g, "$1<strong>$2</strong>");
  out = out.replace(/(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g, "$1<em>$2</em>");
  out = out.replace(/(^|[^\w])_([^_]+?)_(?!\w)/g, "$1<em>$2</em>");
  out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
  return out;
}

const isHeading = (l: string) => /^#{1,3}\s+/.test(l);
const isTableLine = (l: string) => /^\|.*\|$/.test(l);
const isSeparator = (l: string) =>
  /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/.test(l);
const isBullet = (l: string) => /^[-*•]\s+/.test(l);
const isNumbered = (l: string) => /^\d+[.)]\s+/.test(l);
const isQuote = (l: string) => /^>\s?/.test(l);
const startsBlock = (l: string) =>
  isHeading(l) || isTableLine(l) || isBullet(l) || isNumbered(l) || isQuote(l);

const splitCells = (l: string) =>
  l
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());

export function renderMarkdownLite(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i].trim();

    if (!line) {
      i++;
      continue;
    }

    // Heading
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      out.push(`<h${level}>${inline(h[2])}</h${level}>`);
      i++;
      continue;
    }

    // Table
    if (isTableLine(line)) {
      const rows: string[] = [];
      while (i < lines.length && isTableLine(lines[i].trim())) {
        rows.push(lines[i].trim());
        i++;
      }
      const hasHead = rows.length >= 2 && isSeparator(rows[1]);
      const head = hasHead ? splitCells(rows[0]) : null;
      const body = (hasHead ? rows.slice(2) : rows).map(splitCells);
      const th = head
        ? `<thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead>`
        : "";
      const tb = `<tbody>${body
        .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`)
        .join("")}</tbody>`;
      out.push(`<div class="md-table"><table>${th}${tb}</table></div>`);
      continue;
    }

    // Lists (bullet ya numbered)
    if (isBullet(line) || isNumbered(line)) {
      const ordered = isNumbered(line);
      const items: string[] = [];
      while (i < lines.length) {
        const l = lines[i].trim();
        if (ordered ? !isNumbered(l) : !isBullet(l)) break;
        items.push(
          `<li>${inline(l.replace(/^[-*•]\s+/, "").replace(/^\d+[.)]\s+/, ""))}</li>`,
        );
        i++;
      }
      const tag = ordered ? "ol" : "ul";
      out.push(`<${tag}>${items.join("")}</${tag}>`);
      continue;
    }

    // Quote
    if (isQuote(line)) {
      const parts: string[] = [];
      while (i < lines.length && isQuote(lines[i].trim())) {
        parts.push(inline(lines[i].trim().replace(/^>\s?/, "")));
        i++;
      }
      out.push(`<blockquote>${parts.join("<br>")}</blockquote>`);
      continue;
    }

    // Paragraph: agle khaali ya khaas line tak
    const parts: string[] = [];
    while (i < lines.length) {
      const l = lines[i].trim();
      if (!l || startsBlock(l)) break;
      parts.push(inline(l));
      i++;
    }
    out.push(`<p>${parts.join("<br>")}</p>`);
  }

  return out.join("");
}

// Copy ke liye: markdown ki nishaniyan hata kar saaf text
export function plainText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/(^|[^\w])__(.+?)__(?!\w)/g, "$1$2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^#{1,3}\s+/gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// WhatsApp ke liye: **mota** ko *mota* banata hai (WhatsApp ka tareeqa)
export function whatsappText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/^#{1,3}\s+(.*)$/gm, "**$1**")
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^>\s?/gm, "")
    .replace(/^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}