export function clausesOf(question) {
  return String(question ?? '').split(/,|;/).map((c) => c.trim()).filter(Boolean);
}
