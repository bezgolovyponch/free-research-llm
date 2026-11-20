import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { ResearchEngine } from '../../src/research/engine.mjs';
import { ModelRouter } from '../../src/llm/router.mjs';
import { ProjectStore } from '../../src/store.mjs';
import { ScriptedProvider } from '../../src/llm/scripted-provider.mjs';
import { TASK_MARKERS } from '../../src/research/prompts.mjs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

class ObservationTestProvider extends ScriptedProvider {
  constructor() {
    super({ id: 'obs-test' });
    this.customResponses = new Map();
  }

  setResponse(key, response) {
    this.customResponses.set(key, response);
  }

  async chat({ messages, tier = 'fast' }) {
    const prompt = messages[messages.length - 1]?.content ?? '';
    console.log('DEBUG: Provider chat called, prompt contains TABLE_SPEC:', prompt.includes('TABLE_SPEC'));
    console.log('DEBUG: Provider chat called, prompt contains EXTRACT_OBSERVATIONS:', prompt.includes('EXTRACT_OBSERVATIONS'));

    if (prompt.includes('TABLE_SPEC')) {
      const resp = this.customResponses.get('table-spec');
      console.log('DEBUG: Returning table-spec response:', resp);
      if (resp) return { content: JSON.stringify(resp), model: 'test', provider: 'obs-test', usage: {} };
    }
    if (prompt.includes('EXTRACT_OBSERVATIONS')) {
      const resp = this.customResponses.get('extract-observations');
      console.log('DEBUG: Returning extract-observations response:', resp);
      if (resp) return { content: JSON.stringify(resp), model: 'test', provider: 'obs-test', usage: {} };
    }
    // Fall back to parent implementation for other tasks
    return super.chat({ messages, tier });
  }
}

describe('observation table integration', () => {
  let dir;
  let engine;
  let provider;
  let router;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frl-obs-'));
    provider = new ObservationTestProvider();
    router = new ModelRouter({ providers: [provider] });
    engine = new ResearchEngine({ router, store: new ProjectStore({ dir }), lanes: 1 });
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('creates observation table from pieces', async () => {
    const projectData = JSON.parse(await fs.readFile(path.join('tests/fixtures/projects/test-3c9f1f.json'), 'utf8'));

    // Create project with the test data
    const project = await engine.createProject({
      question: projectData.question,
      expected: projectData.acceptance.expected
    });

    // Manually set up the project with the test nodes
    project.nodes = projectData.nodes;
    project.contractClass = 'analysis';
    await engine.store.save(project, { reason: 'test setup' });

    // Set up custom responses for the observation tasks
    provider.setResponse('table-spec', {
      observationUnit: 'monthly rate per lane',
      columns: [
        { name: 'time', type: 'time', unit: '', quoteFromAsker: 'monthly' },
        { name: 'lane', type: 'entity', unit: '', quoteFromAsker: 'lane' },
        { name: 'rate', type: 'value', unit: 'USD/FEU', quoteFromAsker: 'rate' }
      ]
    });

    provider.setResponse('extract-observations', {
      rows: [
        { time: '2026-12', lane: 'Asia-Europe', value: 950, unit: 'USD/FEU', quote: 'December 2026 Asia-Europe spot rate reached 950 per FEU' },
        { time: '2026-11', lane: 'Asia-Europe', value: 920, unit: 'USD/FEU', quote: 'November 2026 rate was 920 per FEU' },
        { time: '2026-12', lane: 'Transpacific', value: 2100, unit: 'USD/FEU', quote: 'December 2026 Transpacific rate reached 2100 per FEU' },
        { time: '2026-11', lane: 'Transpacific', value: 2000, unit: 'USD/FEU', quote: 'November 2026 Transpacific rate was 2000 per FEU' }
      ]
    });

    // Run observations
    const { runObservations } = await import('../../src/research/observations.mjs');
    await runObservations(project, router, null);
    
    expect(project.results.spec).toBeDefined();
    expect(project.results.spec.columns).toHaveLength(3);
    expect(project.results.observations).toHaveLength(4);
    
    // Check observations have correct structure
    const obs = project.results.observations;
    expect(obs[0]).toMatchObject({ time: '2026-12', entity: 'Asia-Europe', value: 950, unit: 'USD/FEU' });
    expect(obs[0].quote).toBe('December 2026 Asia-Europe spot rate reached 950 per FEU');
    expect(obs[0].source).toBe('https://example.com/freight-asia-europe');
  });

  it('computes forecast from observations', async () => {
    const projectData = JSON.parse(await fs.readFile(path.join('tests/fixtures/projects/test-3c9f1f.json'), 'utf8'));
    
    const project = await engine.createProject({ 
      question: projectData.question,
      expected: projectData.acceptance.expected
    });
    project.nodes = projectData.nodes;
    project.contractClass = 'analysis';
    project.results = {
      spec: {
        observationUnit: 'monthly rate per lane',
        columns: [
          { name: 'time', type: 'time', unit: '', quoteFromAsker: 'monthly' },
          { name: 'lane', type: 'entity', unit: '', quoteFromAsker: 'lane' },
          { name: 'rate', type: 'value', unit: 'USD/FEU', quoteFromAsker: 'rate' }
        ]
      },
      observations: [
        { time: '2026-11', lane: 'Asia-Europe', value: 920, unit: 'USD/FEU', source: 's1', quote: 'q' },
        { time: '2026-12', lane: 'Asia-Europe', value: 950, unit: 'USD/FEU', source: 's1', quote: 'q' },
        { time: '2026-11', lane: 'Transpacific', value: 2000, unit: 'USD/FEU', source: 's2', quote: 'q' },
        { time: '2026-12', lane: 'Transpacific', value: 2100, unit: 'USD/FEU', source: 's2', quote: 'q' }
      ]
    };
    await engine.store.save(project, { reason: 'test setup' });
    
    const { aggregateObservations, forecast: forecastFn, buildResultsTable } = await import('../../src/research/forecast.mjs');
    const { spec, observations } = project.results;
    const aggregated = aggregateObservations(observations, spec);
    const forecastRows = forecastFn(aggregated, spec, 3);
    project.results.forecast = forecastRows;
    project.results.table = buildResultsTable(spec, aggregated, forecastRows);
    
    expect(aggregated).toHaveLength(4); // 2 time periods x 2 lanes
    expect(forecastRows).toHaveLength(3);
    expect(forecastRows[0].type).toBe('forecast');
    expect(forecastRows[0].method).toContain('drift');
    expect(forecastRows[0].low).not.toBeNull();
    expect(forecastRows[0].high).not.toBeNull();
    
    expect(project.results.table.rows).toHaveLength(7); // 4 observed + 3 forecast
    expect(project.results.table.rows.filter(r => r.type === 'observed')).toHaveLength(4);
    expect(project.results.table.rows.filter(r => r.type === 'forecast')).toHaveLength(3);
  });

  it('generates CSV and JSON output', async () => {
    const projectData = JSON.parse(await fs.readFile(path.join('tests/fixtures/projects/test-3c9f1f.json'), 'utf8'));
    
    const project = await engine.createProject({ 
      question: projectData.question,
      expected: projectData.acceptance.expected
    });
    project.contractClass = 'analysis';
    project.results = {
      table: {
        columns: ['time', 'lane', 'rate', 'unit', 'type'],
        rows: [
          { time: '2026-11', lane: 'Asia-Europe', rate: 920, unit: 'USD/FEU', type: 'observed' },
          { time: '2026-12', lane: 'Asia-Europe', rate: 950, unit: 'USD/FEU', type: 'observed' },
          { time: '2027-01', lane: 'Asia-Europe', rate: 980, unit: 'USD/FEU', type: 'forecast' }
        ]
      }
    };
    
    const { toCSV, toJSON } = await import('../../src/research/observations.mjs');
    project.results.csv = toCSV(project.results.table);
    project.results.json = toJSON(project.results.table);
    
    expect(project.results.csv).toContain('time,lane,rate,unit,type');
    expect(project.results.csv).toContain('2026-11,Asia-Europe,920,USD/FEU,observed');
    expect(project.results.csv).toContain('2027-01,Asia-Europe,980,USD/FEU,forecast');
    
    const parsed = JSON.parse(project.results.json);
    expect(parsed).toHaveLength(3);
  });
});
