import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'app-ui',
  base: '/manage/',
  plugins: [svelte()],
  build: {
    outDir: '../app/dist/manage',
    emptyOutDir: true,
  },
});
