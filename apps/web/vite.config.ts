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
      /**
       * Windows 上必须忽略编辑器的「原子写」临时目录（同 admin）。
       * 编辑器保存时的 `.Xxx.vue.<pid>.<uuid>.tmpdir/` 会被 chokidar 盯上，
       * 目录消失时抛 EBUSY 直接打死 dev server。
       */
      watch: {
        ignored: ['**/*.tmpdir/**', '**/.*.tmp', '**/.git/**'],
      },
      // 生产由 Nginx 直接从磁盘提供 /uploads/，本地 dev 没有这层，
      // 需要把 /uploads 一并代理到后端，否则上传的图片在页面上全部裂图。
      ...(useMock
        ? {}
        : {
            proxy: {
              '/api': { target: 'http://127.0.0.1:3000', changeOrigin: true },
              '/uploads': { target: 'http://127.0.0.1:3000', changeOrigin: true },
            },
          }),
    },
  };
});
