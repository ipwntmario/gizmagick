// Cache only deterministic JSON calculations, never authorization, database
// reads, leases, storage checks or publication progress. Exact input text and
// every context value must match; changed data is calculated again.
const entries = [];
const MAX_CHARACTERS = 2 * 1024 * 1024;
const MAX_ENTRIES = 12;
let characters = 0;

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export async function calculateJsonOnce(parts, calculate) {
  if (!parts.every(part => typeof part === 'string')) throw new TypeError('JSON cache keys must contain exact text inputs.');
  const index = entries.findIndex(entry => entry.parts.length === parts.length && entry.parts.every((part, i) => part === parts[i]));
  if (index !== -1) {
    const [entry] = entries.splice(index, 1); entries.push(entry);
    return entry.value;
  }
  const value = freeze(await calculate()); // Failures never become cached successes.
  const size = parts.reduce((sum, part) => sum + part.length, 0);
  if (size > MAX_CHARACTERS) return value;
  while (entries.length && (entries.length >= MAX_ENTRIES || characters + size > MAX_CHARACTERS)) characters -= entries.shift().size;
  entries.push({ parts: [...parts], value, size }); characters += size;
  return value;
}
