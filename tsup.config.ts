import { defineConfig } from 'tsup';
export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm', 'cjs'],
    dts: true,
    // Each target owns its files; don't clean the shared parent during parallel builds.
    clean: false,
    sourcemap: true,
    target: 'node22',
    removeNodeProtocol: false,
    shims: true,
  },
  {
    entry: { index: 'src/react.tsx' },
    outDir: 'dist/react',
    format: ['esm', 'cjs'],
    dts: true,
    clean: true,
    sourcemap: true,
    platform: 'browser',
    target: 'es2020',
    splitting: false,
    external: ['react', 'react/jsx-runtime'],
    banner: { js: '"use client";' },
  },
]);
