// L1→L2 productive grader (v2 plan §5).
// Maps user typed answer → SRS eval suggestion via edit distance.

import { Eval } from "./srs.js";

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array(n + 1);
  for (let j = 0; j <= n; j += 1) prev[j] = j;
  for (let i = 1; i <= m; i += 1) {
    const curr = [i];
    for (let j = 1; j <= n; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = curr;
  }
  return prev[n];
}

/**
 * Suggest an SRS eval based on user input vs. expected word.
 *  - Exact (case-insensitive) → Good
 *  - Edit distance == 1 → Hard
 *  - First letter match AND length within ±1 → Hard
 *  - Otherwise → Again
 */
export function gradeProductive(input, expected) {
  const a = (input || "").trim().toLowerCase();
  const b = (expected || "").trim().toLowerCase();
  if (!a) return { eval: Eval.Again, reason: "空" };
  if (a === b) return { eval: Eval.Good, reason: "完全匹配" };
  const d = levenshtein(a, b);
  if (d === 1) return { eval: Eval.Hard, reason: "1 字差" };
  if (a[0] === b[0] && Math.abs(a.length - b.length) <= 1) {
    return { eval: Eval.Hard, reason: "首字母 + 长度对" };
  }
  return { eval: Eval.Again, reason: `差 ${d} 字` };
}
