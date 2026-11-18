import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KeychainSecrets } from '../src/secrets.mjs';
import { entityDeliverables } from '../src/research/acceptance.mjs';
import { App } from '../src/app.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function insideRepo(dir) {
  const relative = path.relative(ROOT, path.resolve(dir));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function main() {
  const args = process.argv.slice(2);
  const projectId = args[0];
  const outIndex = args.indexOf('--out');
  const outDir = outIndex >= 0 ? args[outIndex + 1] : null;

  if (!projectId || !outDir) {
    console.error('usage: node scripts/hub-witness.mjs <projectId> --out <dir outside the repo>');
    process.exit(1);
  }

  if (insideRepo(outDir)) {
    console.error('--out must be a folder outside the repository (' + ROOT + '); nothing was written');
    process.exit(1);
  }

  const projectPath = path.join(ROOT, 'data', 'projects', projectId + '.json');
  const copied = path.join(outDir, 'data', projectId + '.json');
  const project = JSON.parse(await fs.readFile(await fs.access(copied).then(() => copied, () => projectPath), 'utf8'));

  await fs.mkdir(path.join(outDir, 'data'), { recursive: true });
  await fs.writeFile(copied, JSON.stringify(project, null, 1));

  const secrets = new KeychainSecrets();
  await secrets.fillMissing(process.env);

  const app = new App({ dataDir: path.join(outDir, 'data') });
  await app.refreshProviders();

  const engine = app.engine;

  await engine.searchHubs(project);
  const before = (await fs.readFile(projectPath, 'utf8').then(JSON.parse)).hubSources?.length ?? 0;
  const kind = project.decisionModel?.kind ?? {};
  const delivered = await entityDeliverables([...(project.nodes ?? []), { id: 'hubs', sources: project.hubSources ?? [] }], {
    terms: [...new Set([...(project.domain?.terms ?? []), ...(kind.terms ?? [])])],
    not: kind.not ?? [],
    kindLabel: kind.label ?? '',
    kindTerms: kind.terms ?? [],
    regions: project.brief?.regions ?? [],
    readPage: engine.cachedPageReader(null),
  });
  await engine.store.save(project, { reason: 'hub witness' });

  const hubSources = project.hubSources ?? [];
  const hubQueries = project.hubQueries ?? [];

  const rounds = [...new Set(hubQueries.map((q) => q.round))].sort((a, b) => a - b);
  const roundDetails = rounds.map((round) => {
    const roundQueries = hubQueries.filter((q) => q.round === round);
    return {
      round,
      queries: roundQueries.length,
      queryTexts: roundQueries.map((q) => q.query),
      countries: [...new Set(roundQueries.map((q) => q.country).filter(Boolean))],
    };
  });

  const hosts = [...new Set(hubSources.map((s) => {
    try {
      return new URL(s.url).hostname.replace(/^www./, '');
    } catch {
      return '';
    }
  }).filter(Boolean))];

  const output = {
    projectId,
    hubSources: hubSources.length,
    hubQueries: hubQueries.length,
    rounds: roundDetails,
    uniqueHosts: hosts.length,
    hosts,
    hubSourcesBefore: before,
    deliverables: delivered.length,
    deliverableUrls: delivered.map((d) => d.url),
    hubSearchedAt: project.hubSearchedAt,
    roundLog: (project.log ?? []).filter((l) => String(l.message ?? '').startsWith('hub round')).map((l) => l.message),
  };

  console.log(JSON.stringify(output, null, 1));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
