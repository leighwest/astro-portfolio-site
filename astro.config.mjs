// @ts-check
import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
  site: 'https://leighwest.dev',
  markdown: {
    shikiConfig: {
      theme: 'catppuccin-mocha' // soft pastels
    }
  }
});
