import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function fetchArxivAbstract(arxivId) {
  const url = 'https://export.arxiv.org/abs/' + arxivId;
  const result = spawnSync('curl', ['-sL', '--max-time', '30', url], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  if (result.status !== 0) throw new Error('curl failed for ' + url + ': ' + result.stderr);
  const html = result.stdout;
  const match = html.match(/<blockquote class="abstract mathjax">([\s\S]*?)<\/blockquote>/);
  if (!match) throw new Error('abstract not found in ' + url);
  return match[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

async function fetchPdfText(pdfUrl) {
  const result = spawnSync('curl', ['-sL', '--max-time', '60', pdfUrl], { encoding: 'buffer', maxBuffer: 50 * 1024 * 1024 });
  if (result.status !== 0) throw new Error('curl failed for ' + pdfUrl + ': ' + result.stderr);
  const pdfBuffer = result.stdout;
  const tmpPdf = path.join('/tmp', 'fetch-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.pdf');
  await fs.writeFile(tmpPdf, pdfBuffer);
  try {
    const pdftotext = spawnSync('pdftotext', [tmpPdf, '-'], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
    if (pdftotext.status !== 0) throw new Error('pdftotext failed: ' + pdftotext.stderr);
    return pdftotext.stdout.replace(/\s+/g, ' ').trim();
  } finally {
    await fs.rm(tmpPdf, { force: true });
  }
}

async function fetchSourceText(method) {
  const url = method.url || method.source_url;
  if (!url) throw new Error('no url for ' + method.id);
  if (url.includes('arxiv.org/abs/')) {
    const arxivId = url.split('/abs/')[1].split('v')[0];
    return fetchArxivAbstract(arxivId);
  }
  if (url.endsWith('.pdf') || url.includes('.pdf')) {
    return fetchPdfText(url);
  }
  throw new Error('unsupported source type for ' + method.id + ': ' + url);
}

async function verifyMethod(method) {
  const text = await fetchSourceText(method);
  const normQuote = method.quote.replace(/\s+/g, ' ').trim();
  const normText = text.replace(/\s+/g, ' ').trim();
  if (!normText.includes(normQuote)) {
    throw new Error('quote not found in fetched source for ' + method.id);
  }
  return true;
}

async function main() {
  const methodsPath = path.join(ROOT, 'src', 'research', 'methods.json');
  const methods = JSON.parse(await fs.readFile(methodsPath, 'utf8'));
  const verified = methods.filter((m) => m.status === 'verified');
  const failures = [];
  for (const method of verified) {
    try {
      await verifyMethod(method);
      console.log('OK ' + method.id);
    } catch (error) {
      console.error('FAIL ' + method.id + ': ' + error.message);
      failures.push(method.id);
    }
  }
  if (failures.length > 0) {
    console.error('\n' + failures.length + ' method(s) failed verification');
    process.exitCode = 1;
  } else {
    console.log('\nAll ' + verified.length + ' verified method(s) passed');
  }
}

main();