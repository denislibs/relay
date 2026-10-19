// Storybook кита: bun run storybook (из packages/relay-ui) → http://localhost:6006
// Обои берут узоры из /patterns — отдаём папку приложения как статику.
export default {
  framework: { name: '@storybook/preact-vite', options: {} },
  stories: ['../stories/**/*.stories.js'],
  staticDirs: [{ from: '../../../apps/web/public/patterns', to: '/patterns' }],
  core: { disableTelemetry: true },
};
