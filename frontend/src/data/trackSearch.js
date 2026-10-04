function normalize(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function isSubsequence(needle, haystack) {
  let index = 0;
  for (const character of haystack) {
    if (character === needle[index]) index += 1;
    if (index === needle.length) return true;
  }
  return false;
}

function withinOneEdit(first, second) {
  if (Math.abs(first.length - second.length) > 1) return false;
  if (first.length === second.length) {
    let mismatches = 0;
    for (let index = 0; index < first.length; index += 1) {
      if (first[index] !== second[index]) mismatches += 1;
    }
    if (mismatches <= 1) return true;
    if (mismatches === 2) {
      for (let index = 0; index < first.length - 1; index += 1) {
        if (first[index] === second[index + 1] && first[index + 1] === second[index]
          && first.slice(0, index) === second.slice(0, index)
          && first.slice(index + 2) === second.slice(index + 2)) return true;
      }
    }
    return false;
  }
  let a = 0;
  let b = 0;
  let edits = 0;
  while (a < first.length && b < second.length) {
    if (first[a] === second[b]) { a += 1; b += 1; continue; }
    if (++edits > 1) return false;
    if (first.length >= second.length) a += 1;
    if (first.length <= second.length) b += 1;
  }
  return edits + Number(a < first.length || b < second.length) <= 1;
}

export function matchesTrackSearch(query, ...titles) {
  const terms = normalize(query).split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  return titles.some((title) => {
    const words = normalize(title).split(/\s+/).filter(Boolean);
    const joined = words.join("");
    return terms.every((term) => (
      joined.includes(term)
      || (term.length >= 3 && isSubsequence(term, joined))
      || (term.length >= 4 && words.some((word) => withinOneEdit(term, word)))
    ));
  });
}
