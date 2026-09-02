import { defineConfig, type Plugin } from 'vite';
import type { OutputAsset } from 'rolldown';

/** Fold the stylesheet into index.html as a <style> tag and drop the separate
 *  asset.
 *
 *  The sheet is ~7.6 kB (2.4 kB gzipped) and it is entirely render-critical:
 *  without it the page is unstyled text, because the HTML carries the whole UI
 *  and the CSS carries all of its layout. Shipping that as a second request
 *  means every way a request can fail — a wrong base path, a stale cache, a
 *  MIME-type refusal under nosniff, a proxy, a half-swapped deploy — is a way
 *  the game arrives as naked markup while the JavaScript runs fine. Inlining
 *  removes the request, so there is nothing left to fail.
 */
function inlineStylesheet(): Plugin {
  return {
    name: 'inline-stylesheet',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const css = Object.keys(bundle).filter((f) => f.endsWith('.css'));
      const html = Object.keys(bundle).filter((f) => f.endsWith('.html'));
      for (const h of html) {
        const page = bundle[h] as OutputAsset;
        let source = String(page.source);
        for (const name of css) {
          const asset = bundle[name] as OutputAsset;
          const file = name.split('/').pop()!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const tag = new RegExp(`<link[^>]+href="[^"]*${file}"[^>]*>`);
          if (!tag.test(source)) continue;
          source = source.replace(tag, `<style>${String(asset.source).trim()}</style>`);
          delete bundle[name];
        }
        page.source = source;
      }
    },
  };
}

export default defineConfig({
  // Relative base so the same build works on GitHub Pages project sites,
  // user sites, and local `vite preview` without reconfiguration.
  base: './',
  plugins: [inlineStylesheet()],
  build: { target: 'es2020', outDir: 'dist', sourcemap: false, assetsInlineLimit: 4096 },
});
