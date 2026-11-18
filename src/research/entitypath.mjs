export const ENTITY_PATH = /^((?:\/[a-z]{2})?\/(?:company|companies|firma|firmen|empresa|entreprise|societe|azienda|bedrijf|supplier|suppliers|seller|vendor|store)\/([^/]+))/i;
export const ENTITY_ID = /(\d{5,})(?:[/_-]|$)/;

export function entityIdOf(url) {
  try {
    const match = new URL(url).pathname.match(ENTITY_PATH);
    return match ? (match[2].match(ENTITY_ID)?.[1] ?? null) : null;
  } catch {
    return null;
  }
}

export function directoryEntityKey({ name, profileUrl = null, pageHost, sharedStems, fallback }) {
  const id = profileUrl ? entityIdOf(profileUrl) : null;
  const stem = String(pageHost ?? '').replace(/^www\./, '').split('.')[0];
  return id && sharedStems.has(stem) ? `${name}|${id}` : (profileUrl ?? fallback);
}
