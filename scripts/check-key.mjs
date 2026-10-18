#!/usr/bin/env node
import { KeyChecker } from '../src/keycheck.mjs';

const name = process.argv[2];
let raw = '';
for await (const chunk of process.stdin) raw += chunk;
const result = await new KeyChecker().verify(name, raw);
const state = result.repaired ? 'repaired' : result.ok === true ? 'ok' : result.ok === null ? 'unchecked' : 'invalid';
process.stdout.write(`${state}\n${result.value}\n${result.repaired ?? [result.detail, result.hint].filter(Boolean).join(' · ')}\n`);
