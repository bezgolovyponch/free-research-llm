#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function normalizePath(value, root = ROOT) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  const relative = path.isAbsolute(text) ? path.relative(root, text) : text;
  return relative.split(path.sep).join('/').replace(/^\.\//, '').replace(/^\/+/, '');
}

export function globToRegExp(glob) {
  const source = glob
    .split('/')
    .map((segment) => {
      if (segment === '**') return '**';
      return segment.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]');
    })
    .join('/')
    .replace(/\/\*\*$/, '(?:/.*)?')
    .replace(/\*\*\//g, '(?:.*/)?');
  return new RegExp(`^${source}$`);
}

export function matchesGlob(file, glob) {
  return globToRegExp(glob).test(file);
}

export function matchLessons(lessons, paths) {
  const files = [...new Set(paths.map((entry) => normalizePath(entry)).filter(Boolean))];
  return lessons.filter((lesson) => lesson.touches.some((glob) => files.some((file) => matchesGlob(file, glob))));
}

export function formatLesson(lesson) {
  return `${lesson.id} | ${lesson.title} | signal: ${lesson.signal} | prevention: ${lesson.prevention}`;
}

export function loadLessons(file = path.join(ROOT, 'scripts/process-lessons.json')) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function changedPaths(root = ROOT) {
  const listed = (args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
  return [...new Set([...listed(['diff', '--name-only']), ...listed(['diff', '--cached', '--name-only'])])];
}

function main(argv) {
  const lessons = loadLessons();
  const paths = argv.includes('--changed') ? changedPaths() : argv.filter((arg) => !arg.startsWith('--'));
  for (const lesson of matchLessons(lessons, paths)) console.log(formatLesson(lesson));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
