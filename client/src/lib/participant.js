// The participant code (P01, P02, ...) is the researcher's study ID: students never see it. Only admin tools type one.

const CODE = /^P\s*-?\s*(\d{1,3})$/i;

// The same rule as the server: "p7", "P 7" and "P007" all mean P07. null when it isn't a code.
export function normalizeCode(text) {
  const m = CODE.exec(String(text ?? '').trim());
  return m ? `P${String(Number(m[1])).padStart(2, '0')}` : null;
}
