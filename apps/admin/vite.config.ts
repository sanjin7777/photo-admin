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
      /**
       * Windows 上必须忽略编辑器的「原子写」临时目录。
       *
       * 很多编辑器保存文件时先写 `.Xxx.vue.<pid>.<uuid>.tmpdir/Xxx.vue.tmp` 再改名覆盖，
       * chokidar 会去 watch 这个瞬间存在的目录，等它被删掉时抛
       * `EBUSY: resource busy or locked, watch '...tmpdir\...tmp'` 直接把 dev server 打死。
       * 表现就是「改一次 .vue，后台就崩一次」，必须从 watcher 层面排除。
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
