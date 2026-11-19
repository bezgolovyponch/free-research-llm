import { integrityResult } from './quality.mjs';

const result = integrityResult({ messageFile: process.argv[2] });
console.log(`${result.passed ? 'PASS' : 'FAIL'}  testIntegrity ${result.detail}`);
process.exitCode = result.passed ? 0 : 1;
