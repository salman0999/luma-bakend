import {build} from 'esbuild';
import {mkdir,writeFile} from 'node:fs/promises';
await mkdir('dist',{recursive:true});
await build({entryPoints:['src/server.ts','src/runtime.ts','src/core.ts','src/network.ts','src/bootstrap.ts','src/worker-gate.ts'],outdir:'dist',platform:'node',format:'esm',packages:'external',target:'node24',sourcemap:true});
await build({stdin:{contents:"import {Buffer} from 'buffer';import * as cheerio from 'cheerio/slim';globalThis.Buffer=Buffer;globalThis.__cheerio=cheerio;",resolveDir:process.cwd()},inject:['scripts/buffer-shim.mjs'],outfile:'dist/cheerio-sandbox.js',bundle:true,platform:'browser',format:'iife',target:'es2022',minify:true});
