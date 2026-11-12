import { defineConfig } from 'astro/config';

// Update `site` after the first Cloudflare Pages deployment or custom domain.
export default defineConfig({
  site: 'https://parenowriter.pages.dev',
  output: 'static'
});
