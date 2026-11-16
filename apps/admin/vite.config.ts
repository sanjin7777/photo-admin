import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import vue from '@vitejs/plugin-vue';
import { mockApiPlugin } from '../../mock';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const useMock = env.VITE_USE_MOCK === 'true';
  return {
    // 后台挂载在 https://www.catpaw.art/admin/ 子路径，资源与路由都以此为 base
    base: '/admin/',
    plugins: [vue(), useMock ? mockApiPlugin() : null],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
        '@photo/shared': fileURLToPath(new URL('../../packages/shared/src', import.meta.url)),
      },
    },
    server: {
      port: 5174,
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
