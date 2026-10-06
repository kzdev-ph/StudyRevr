// CSV writing for the research export (RFC 4180: comma-separated, quoted when needed, CRLF line ends).
// Text that a spreadsheet would run as a formula (starting with = + - @, or a tab / carriage return) gets a leading
// apostrophe, so a lesson title or answer can never execute in Excel or Sheets. Numbers are written as they are.

const FORMULA = /^[=+\-@\t\r]/;

export function csvCell(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'boolean') return value ? '1' : '0';
  let text = String(value);
  if (FORMULA.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

// columns: names in order; rows: objects keyed by those names.
export function toCsv(columns, rows) {
  const lines = [columns.map(csvCell).join(',')];
  for (const row of rows) lines.push(columns.map((c) => csvCell(row[c])).join(','));
  return `${lines.join('\r\n')}\r\n`;
}
