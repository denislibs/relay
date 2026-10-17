// UI-слой Relay: компоненты дизайн-системы (Preact), планировщик кадра и обои.
// Стили: relay.css (компоненты) + tokens.css (генерируется из tokens.json: bun build-tokens.ts).
export * from './kit.js';
export * from './more.js';
export * from './settings.js';
export * from './schedule.js';
export { enableStrictDom } from './strict.js';
