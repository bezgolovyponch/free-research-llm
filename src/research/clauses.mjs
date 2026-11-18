export function clausesOf(question) {
  return String(question ?? '').split(/,|;/).map((c) => c.trim()).filter(Boolean);
}

const SENTENCE_END = /[.!?]\s+\S|\n/;

export function sentencesOf(pieces) {
  let sentence = 0;
  return (pieces ?? []).map((piece) => {
    const at = sentence;
    if (SENTENCE_END.test(String(piece ?? '').trim())) sentence += 1;
    return at;
  });
}
