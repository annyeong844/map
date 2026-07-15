import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_CORPUS_ROOT = join(
  homedir(),
  'Downloads',
  'repo',
  'lumin 진화도구',
);

const QUICK_REPOSITORIES = [
  'jadonghwa-comic-studio-codex-main',
  'depwire-main',
  'hono-main',
];

const FULL_REPOSITORIES = [
  ...QUICK_REPOSITORIES,
  'rev-dep-master',
  'fallow-main',
  'nest-master',
  'eslint-main',
  'fallow-main(0715)',
  'astro-main',
  'cal.diy-main',
];

export const CORPUS_PROFILES = Object.freeze({
  quick: Object.freeze({
    repositories: QUICK_REPOSITORIES,
    noOpIterations: 2,
    readSamples: 12,
    differential: false,
  }),
  full: Object.freeze({
    repositories: FULL_REPOSITORIES,
    noOpIterations: 5,
    readSamples: 24,
    differential: true,
  }),
  stress: Object.freeze({
    repositories: ['next.js-canary'],
    noOpIterations: 3,
    readSamples: 32,
    differential: false,
  }),
  soak: Object.freeze({
    repositories: ['hono-main'],
    noOpIterations: 100,
    readSamples: 24,
    differential: false,
  }),
});

export const DIFFERENTIAL_PAIR = Object.freeze([
  'fallow-main',
  'fallow-main(0715)',
]);

export function profileNamed(name) {
  const profile = CORPUS_PROFILES[name];
  if (!profile) {
    throw new Error(
      `Unknown profile "${name}". Choose ${Object.keys(CORPUS_PROFILES).join(', ')}.`,
    );
  }
  return profile;
}
