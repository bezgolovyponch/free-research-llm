import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ResearchEngine } from '../../src/research/engine.mjs';
import { ModelRouter } from '../../src/llm/router.mjs';
import { ScriptedProvider } from '../../src/llm/scripted-provider.mjs';
import { ProjectStore } from '../../src/store.mjs';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frl-kindgate-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function makeEngine() {
  const router = new ModelRouter({ providers: [new ScriptedProvider()] });
  return new ResearchEngine({ router, search: { enabled: true, lastErrors: [], search: async () => [], describe: () => ({ enabled: true, backends: ['fake'] }) }, store: new ProjectStore({ dir }), lanes: 2 });
}

describe('gateOnKind', () => {
  it('returns sources unchanged when validated terms is empty', () => {
    const engine = makeEngine();
    const kind = { label: 'test kind', validated: { terms: [] } };
    const project = { decisionModel: { kind } };
    const node = { id: 'D1.1' };
    const sources = [
      { id: 'S1', title: 'Source 1', url: 'https://example.com/1', text: 'some text' },
      { id: 'S2', title: 'Source 2', url: 'https://example.com/2', text: 'other text' },
    ];
    const result = engine.gateOnKind(project as any, node, sources);
    expect(result).toHaveLength(2);
    expect(result).toEqual(sources);
  });

  it('keeps source with kind.not phrase in returned array but orders it last', () => {
    const engine = makeEngine();
    const kind = { label: 'used car', validated: { terms: ['car', 'hatchback'] }, not: ['parts', 'wheels'] };
    const project = { decisionModel: { kind } };
    const node = { id: 'D1.1' };
    const sources = [
      { id: 'S1', title: 'Car listing', url: 'https://example.com/1', text: 'This is a hatchback car for sale' },
      { id: 'S2', title: 'Parts listing', url: 'https://example.com/2', text: 'Alu wheels for sale parts' },
      { id: 'S3', title: 'Another car', url: 'https://example.com/3', text: 'Used car hatchback good condition' },
    ];
    const result = engine.gateOnKind(project as any, node, sources);
    expect(result).toHaveLength(3);
    expect(result[0].id).toBe('S1');
    expect(result[1].id).toBe('S3');
    expect(result[2].id).toBe('S2');
  });

  it('returns source lacking every validated term after one that has a term', () => {
    const engine = makeEngine();
    const kind = { label: 'used car', validated: { terms: ['car', 'hatchback'] }, not: [] };
    const project = { decisionModel: { kind } };
    const node = { id: 'D1.1' };
    const sources = [
      { id: 'S1', title: 'Car listing', url: 'https://example.com/1', text: 'This is a hatchback car for sale' },
      { id: 'S2', title: 'Unrelated page', url: 'https://example.com/2', text: 'This page is about bicycles and motorcycles' },
      { id: 'S3', title: 'Another car', url: 'https://example.com/3', text: 'Used car good condition' },
    ];
    const result = engine.gateOnKind(project as any, node, sources);
    expect(result).toHaveLength(3);
    expect(result[0].id).toBe('S1');
    expect(result[1].id).toBe('S3');
    expect(result[2].id).toBe('S2');
  });

  it('returned array always has the same length as the input', () => {
    const engine = makeEngine();
    const kind = { label: 'used car', validated: { terms: ['car', 'hatchback'] }, not: ['parts', 'wheels'] };
    const project = { decisionModel: { kind } };
    const node = { id: 'D1.1' };
    const sources = [
      { id: 'S1', title: 'Car listing', url: 'https://example.com/1', text: 'This is a hatchback car for sale' },
      { id: 'S2', title: 'Parts listing', url: 'https://example.com/2', text: 'Alu wheels for sale parts' },
      { id: 'S3', title: 'Unrelated page', url: 'https://example.com/3', text: 'This page is about bicycles' },
      { id: 'S4', title: 'Another car', url: 'https://example.com/4', text: 'Used car hatchback good condition' },
      { id: 'S5', title: 'More parts', url: 'https://example.com/5', text: 'Car parts and accessories wheels' },
    ];
    const result = engine.gateOnKind(project as any, node, sources);
    expect(result).toHaveLength(5);
    expect(result.map(s => s.id)).toEqual(['S1', 'S4', 'S3', 'S2', 'S5']);
  });

  it('orders onKind sources first, then noTerm, then nearMiss, preserving original relative order within each group', () => {
    const engine = makeEngine();
    const kind = { label: 'plot of land', validated: { terms: ['plot', 'land', 'terreno'] }, not: ['hotel', 'apartment'] };
    const project = { decisionModel: { kind } };
    const node = { id: 'D1.1' };
    const sources = [
      { id: 'S1', title: 'Hotel', url: 'https://hotel.example/1', text: 'Luxury hotel by the beach' },
      { id: 'S2', title: 'Plot 1', url: 'https://land.example/1', text: 'Terreno for sale plot of land' },
      { id: 'S3', title: 'Unrelated', url: 'https://other.example/1', text: 'Random page about cars' },
      { id: 'S4', title: 'Apartment', url: 'https://apartment.example/1', text: 'Apartment for rent near city center' },
      { id: 'S5', title: 'Plot 2', url: 'https://land.example/2', text: 'Land plot terreno cheap' },
      { id: 'S6', title: 'Another unrelated', url: 'https://other.example/2', text: 'Page about motorcycles' },
    ];
    const result = engine.gateOnKind(project as any, node, sources);
    expect(result).toHaveLength(6);
    expect(result[0].id).toBe('S2');
    expect(result[1].id).toBe('S5');
    expect(result[2].id).toBe('S3');
    expect(result[3].id).toBe('S6');
    expect(result[4].id).toBe('S1');
    expect(result[5].id).toBe('S4');
  });

  it('emits demoted message when sources are demoted', () => {
    const engine = makeEngine();
    const kind = { label: 'used car', validated: { terms: ['car', 'hatchback'] }, not: ['parts'] };
    const project = { decisionModel: { kind }, log: [] };
    const node = { id: 'D1.1' };
    const sources = [
      { id: 'S1', title: 'Car listing', url: 'https://example.com/1', text: 'This is a hatchback car for sale' },
      { id: 'S2', title: 'Parts listing', url: 'https://parts.example/2', text: 'Alu wheels parts' },
      { id: 'S3', title: 'Unrelated page', url: 'https://unrelated.example/3', text: 'This page is about bicycles' },
    ];
    engine.gateOnKind(project as any, node, sources);
    const demotedLog = project.log.find((l: any) => l.message.includes('demoted behind on-kind sources'));
    expect(demotedLog).toBeTruthy();
    expect(demotedLog.message).toContain('D1.1: 2 source(s) demoted behind on-kind sources');
    expect(demotedLog.message).toContain('parts.example: a near-miss kind (parts)');
    expect(demotedLog.message).toContain('unrelated.example: not the asked kind (used car)');
  });

  it('does not emit demoted message when all sources are onKind', () => {
    const engine = makeEngine();
    const kind = { label: 'used car', validated: { terms: ['car', 'hatchback'] }, not: ['parts'] };
    const project = { decisionModel: { kind }, log: [] };
    const node = { id: 'D1.1' };
    const sources = [
      { id: 'S1', title: 'Car listing', url: 'https://example.com/1', text: 'This is a hatchback car for sale' },
      { id: 'S2', title: 'Another car', url: 'https://example.com/2', text: 'Used car hatchback good condition' },
    ];
    engine.gateOnKind(project as any, node, sources);
    const demotedLog = project.log.find((l: any) => l.message.includes('demoted behind on-kind sources'));
    expect(demotedLog).toBeFalsy();
  });

  it('handles snippet and title in addition to text for kind checking', () => {
    const engine = makeEngine();
    const kind = { label: 'used car', validated: { terms: ['car', 'hatchback'] }, not: ['parts'] };
    const project = { decisionModel: { kind } };
    const node = { id: 'D1.1' };
    const sources = [
      { id: 'S1', title: 'Hatchback car', url: 'https://example.com/1', snippet: 'Great car', text: '' },
      { id: 'S2', title: 'Parts', url: 'https://example.com/2', snippet: '', text: 'Car parts' },
    ];
    const result = engine.gateOnKind(project as any, node, sources);
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('S1');
    expect(result[1].id).toBe('S2');
  });
});