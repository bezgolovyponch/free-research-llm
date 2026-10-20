#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { App, ROOT_DIR } from './app.mjs';
import { KeychainSecrets } from './secrets.mjs';
import { toMarkdown } from './report.mjs';

function parseArgs(argv) {
  const args = { question: [], template: 'auto', csv: '', constraints: {}, resume: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--template' || a === '-t') args.template = argv[++i];
    else if (a === '--csv') args.csv = argv[++i];
    else if (a === '--resume') args.resume = argv[++i];
    else if (a === '--set') {
      const [k, ...v] = String(argv[++i]).split('=');
      args.constraints[k] = v.join('=');
    } else args.question.push(a);
  }
  return { ...args, question: args.question.join(' ').trim() };
}

const USAGE = `usage: npm run ask -- "your question" [--template auto|generic|competitive-strategy|glamping-location|taxes|market-sizing] [--csv data.csv] [--set key=value]
       npm run ask -- --resume <project-id>`;

const args = parseArgs(process.argv.slice(2));
if (!args.question && !args.resume) {
  console.error(USAGE);
  process.exit(2);
}
await new KeychainSecrets().fillMissing(process.env);
const app = new App();
await app.refreshProviders();
if (!app.router.ready) {
  console.error('No model provider is ready. Export a free key first, e.g.\n  export GROQ_API_KEY=...   (https://console.groq.com/keys)\nor install Ollama, or run with FRL_DEMO=1 to see the flow.');
  process.exit(1);
}
const csvText = args.csv ? await fs.readFile(args.csv, 'utf8') : '';
const project = args.resume
  ? await app.engine.load(args.resume)
  : await app.engine.createProject({ question: args.question, templateId: args.template, constraints: args.constraints, csvText, csvName: args.csv ? path.basename(args.csv) : '' });
console.log(`project: ${project.id}`);
app.engine.subscribe(project.id, (event) => console.log(`[${event.type}] ${event.message}`));
try {
  const done = await app.engine.run(project.id);
  const outDir = path.join(ROOT_DIR, 'reports');
  await fs.mkdir(outDir, { recursive: true });
  const file = path.join(outDir, `${done.id}.md`);
  await fs.writeFile(file, toMarkdown(done));
  console.log(`\nVERDICT: ${done.report.verdict}\nreport: ${file}`);
} catch (error) {
  console.error(`\nfailed: ${error.message}`);
  process.exit(1);
}
