// Extracts the first JSON object from a string. Handles fenced code blocks
// (```json ... ```), prose-wrapped JSON, and bare JSON. Returns null if none.
export function extractJsonObject(raw: string): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();

  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch && fenceMatch[1]) {
    const inside = fenceMatch[1].trim();
    if (inside.startsWith("{")) return findBalancedObject(inside);
  }

  if (trimmed.startsWith("{")) {
    return findBalancedObject(trimmed);
  }

  const firstBrace = trimmed.indexOf("{");
  if (firstBrace >= 0) {
    return findBalancedObject(trimmed.slice(firstBrace));
  }

  return null;
}

function findBalancedObject(s: string): string | null {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return s.slice(0, i + 1);
    }
  }
  return null;
}
