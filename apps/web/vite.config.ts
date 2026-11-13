import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import vue from '@vitejs/plugin-vue';
import { mockApiPlugin } from '../../mock';

const sharedSrc = fileURLToPath(new URL('../../packages/shared/src', import.meta.url));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  // 本地 Mock：npm run dev:mock（--mode mock → .env.mock 里 VITE_USE_MOCK=true）
  const useMock = env.VITE_USE_MOCK === 'true';
  return {
    plugins: [vue(), useMock ? mockApiPlugin() : null],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
        '@photo/shared': sharedSrc,
      },
    },
    server: {
      port: 5173,
      ...(useMock ? {} : { proxy: { '/api': { target: 'http://127.0.0.1:3000', changeOrigin: true } } }),
    },
  };
});
