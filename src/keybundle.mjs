import crypto from 'node:crypto';

const PREFIX = 'frl1.';
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const MIN_PASSPHRASE = 10;

export class BundleError extends Error {}

function keyFrom(passphrase, salt) {
  if (String(passphrase).length < MIN_PASSPHRASE) throw new BundleError(`use a passphrase of at least ${MIN_PASSPHRASE} characters`);
  return crypto.scryptSync(String(passphrase), salt, 32, SCRYPT);
}

export function sealKeys(keys, passphrase) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyFrom(passphrase, salt), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(keys), 'utf8'), cipher.final()]);
  return PREFIX + Buffer.concat([salt, iv, cipher.getAuthTag(), body]).toString('base64url');
}

export function openKeys(bundle, passphrase) {
  const text = String(bundle ?? '').replace(/\s+/g, '');
  if (!text.startsWith(PREFIX)) throw new BundleError('this is not a free-research-llm key bundle (it must start with "frl1.")');
  const raw = Buffer.from(text.slice(PREFIX.length), 'base64url');
  if (raw.length < 45) throw new BundleError('the bundle is cut off: copy all of it');
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyFrom(passphrase, raw.subarray(0, 16)), raw.subarray(16, 28));
  decipher.setAuthTag(raw.subarray(28, 44));
  try {
    const keys = JSON.parse(Buffer.concat([decipher.update(raw.subarray(44)), decipher.final()]).toString('utf8'));
    return Object.fromEntries(Object.entries(keys).filter(([name, value]) => /^[A-Z][A-Z0-9_]*$/.test(name) && typeof value === 'string' && value));
  } catch {
    throw new BundleError('wrong passphrase, or the bundle was changed');
  }
}
