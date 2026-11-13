<script setup lang="ts">
/**
 * 模特资料弹窗：报名页 / 投票页共用。
 * 身高、三围为敏感字段，服务端只对 VIP/SVIP 返回真值；
 * 这里再按 canViewBody 决定展示「数据」还是「整块隐藏」（点D：非会员不做任何开通引导），双保险。
 * 图片点击交给父级灯箱（z-200 高于本弹窗 z-150）。
 */
import { computed, onBeforeUnmount, onMounted } from 'vue';
import { labelOf, type ModelProfileDto } from '@photo/shared';

const props = defineProps<{
  model: ModelProfileDto | null;
  /** 当前观众是否会员（VIP/SVIP）；非会员直接隐藏身体数据区块，不展示开通引导 */
  canViewBody: boolean;
}>();

const open = defineModel<boolean>('open', { default: false });
const emit = defineEmits<{ zoom: [images: string[], index: number] }>();

const photos = computed(() => {
  const m = props.model;
  if (!m) return [];
  return m.photoUrls?.length ? m.photoUrls : m.portfolioUrl ? [m.portfolioUrl] : [];
});
const socialLinks = computed(() =>
  (props.model?.socialAccounts ?? []).map((s) => ({
    ...s,
    safeUrl: /^https?:\/\//i.test(s.url ?? '') ? s.url! : undefined,
  })),
);
const measurements = computed(() => props.model?.measurements ?? null);
const cm = (v: number | null | undefined): string => (v == null ? '未录入' : `${v} cm`);

function close(): void { open.value = false; }
function onKey(e: KeyboardEvent): void {
  if (open.value && e.key === 'Escape') close();
}
onMounted(() => window.addEventListener('keydown', onKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));
</script>

<template>
  <Teleport to="body">
    <Transition name="mi">
      <div v-if="open && model" class="fixed inset-0 z-[150] flex items-end justify-center bg-slate-900/50 sm:items-center sm:p-4"
        @click.self="close">
        <div class="fade-up flex max-h-[86vh] w-full max-w-md flex-col overflow-hidden rounded-t-2xl bg-white shadow-float ring-1 ring-slate-200 sm:rounded-2xl">
          <!-- 头部 -->
          <div class="flex items-center justify-between gap-3 border-b border-slate-100 px-5 py-4">
            <div class="min-w-0">
              <h3 class="truncate text-lg font-semibold text-slate-900">{{ model.stageName }}</h3>
              <p class="mt-0.5 text-xs text-slate-500">模特资料</p>
            </div>
            <button class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-100 text-lg leading-none text-slate-500 hover:bg-slate-200"
              aria-label="关闭" @click="close">×</button>
          </div>

          <!-- 内容（可滚动） -->
          <div class="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
            <!-- 照片 -->
            <div v-if="photos.length">
              <p class="mb-2 text-xs font-medium text-slate-500">照片 · 点击放大</p>
              <div class="no-scrollbar flex gap-2 overflow-x-auto pb-1">
                <button v-for="(img, i) in photos" :key="img + i"
                  class="h-24 w-24 shrink-0 overflow-hidden rounded-xl border border-slate-200 bg-slate-50"
                  @click="emit('zoom', photos, i)">
                  <img :src="img" :alt="model.stageName" class="h-full w-full object-cover" loading="lazy" />
                </button>
              </div>
            </div>

            <!-- 身体数据：仅会员可见；非会员整块隐藏，不做开通引导（点D） -->
            <div v-if="canViewBody">
              <p class="mb-2 text-xs font-medium text-slate-500">详细资料</p>
              <div class="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <div class="rounded-xl border border-slate-200 bg-slate-50/60 p-3 text-center">
                  <p class="text-xs text-slate-500">身高</p>
                  <p class="mt-1 text-sm font-semibold text-slate-900">{{ cm(model.heightCm) }}</p>
                </div>
                <div class="rounded-xl border border-slate-200 bg-slate-50/60 p-3 text-center">
                  <p class="text-xs text-slate-500">胸围</p>
                  <p class="mt-1 text-sm font-semibold text-slate-900">{{ cm(measurements?.bustCm) }}</p>
                </div>
                <div class="rounded-xl border border-slate-200 bg-slate-50/60 p-3 text-center">
                  <p class="text-xs text-slate-500">腰围</p>
                  <p class="mt-1 text-sm font-semibold text-slate-900">{{ cm(measurements?.waistCm) }}</p>
                </div>
                <div class="rounded-xl border border-slate-200 bg-slate-50/60 p-3 text-center">
                  <p class="text-xs text-slate-500">臀围</p>
                  <p class="mt-1 text-sm font-semibold text-slate-900">{{ cm(measurements?.hipCm) }}</p>
                </div>
              </div>
            </div>

            <!-- 社交账号 -->
            <div v-if="socialLinks.length">
              <p class="mb-2 text-xs font-medium text-slate-500">社交账号</p>
              <div class="flex flex-wrap gap-1.5">
                <a v-for="s in socialLinks" :key="s.platform + s.handle"
                  :href="s.safeUrl" :target="s.safeUrl ? '_blank' : undefined" rel="noopener noreferrer"
                  class="rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-600"
                  :class="s.safeUrl ? 'hover:bg-brand/10 hover:text-brand' : ''">
                  {{ labelOf(s.platform) }} · {{ s.handle }}
                </a>
              </div>
            </div>

            <!-- 作品集 -->
            <a v-if="model.portfolioUrl && /^https?:\/\//i.test(model.portfolioUrl)"
              :href="model.portfolioUrl" target="_blank" rel="noopener noreferrer"
              class="block rounded-xl border border-brand/30 bg-brand-50 px-4 py-3 text-center text-sm font-medium text-brand hover:bg-brand/10">
              查看作品集 ↗
            </a>
          </div>

          <!-- 底部 -->
          <div class="border-t border-slate-100 px-5 py-3">
            <button class="btn-ghost w-full" @click="close">关闭</button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.mi-enter-active, .mi-leave-active { transition: opacity 0.2s ease; }
.mi-enter-from, .mi-leave-to { opacity: 0; }
</style>