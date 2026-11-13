<script setup lang="ts">
/**
 * 页面级错误兜底：单个页面渲染/生命周期抛错时只坏一个页面，不把整个后台打成白屏。
 * 切换路由或点「重试本页」会重建子树。
 */
import { onErrorCaptured, ref, watch } from 'vue';
import { useRoute } from 'vue-router';

const route = useRoute();
const error = ref<Error | null>(null);
const resetKey = ref(0);

onErrorCaptured((err) => {
  error.value = err instanceof Error ? err : new Error(String(err));
  // 返回 false：阻止错误继续向上冒泡到 app.config.errorHandler，避免整页卸载
  return false;
});

function retry(): void {
  error.value = null;
  resetKey.value += 1;
}

// 换页面时自动恢复，避免一个坏页面把后续页面也挡住
watch(() => route.fullPath, () => {
  if (error.value) retry();
});
</script>

<template>
  <div v-if="error" class="rounded-xl border border-red-200 bg-red-50 p-6">
    <h2 class="text-base font-semibold text-red-700">页面加载出错了</h2>
    <p class="mt-2 text-sm text-red-600">该页面渲染异常，其他功能不受影响，可以重试或返回概览。</p>
    <p class="mt-1 break-all text-xs text-red-400">{{ error.message }}</p>
    <div class="mt-4 flex gap-2">
      <button class="rounded-lg bg-red-600 px-3 py-1.5 text-sm text-white hover:bg-red-700" @click="retry">重试本页</button>
      <RouterLink to="/" class="rounded-lg border border-red-200 bg-white px-3 py-1.5 text-sm text-red-600 hover:bg-red-100">返回概览</RouterLink>
    </div>
  </div>
  <div v-else :key="resetKey">
    <slot />
  </div>
</template>
