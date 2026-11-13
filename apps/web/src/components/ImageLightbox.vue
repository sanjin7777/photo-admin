<script setup lang="ts">
/**
 * 图片灯箱：点击放大、左右切换、ESC / 点背景 / 下滑关闭。
 * 用 Teleport 挂到 body，避免被父级 overflow 裁剪。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

const props = defineProps<{
  images: string[];
  /** 初始索引，由父组件控制 */
  start?: number;
}>();

const open = defineModel<boolean>('open', { default: false });
const current = ref(props.start ?? 0);
const zoomed = ref(false);
const dragY = ref(0);
let startX = 0;
let startY = 0;
let dragging = false;

const total = computed(() => props.images.length);
const src = computed(() => props.images[current.value] ?? '');

watch(open, (v) => {
  if (v) {
    current.value = Math.min(Math.max(props.start ?? 0, 0), Math.max(total.value - 1, 0));
    zoomed.value = false;
    dragY.value = 0;
  }
});

function close(): void { open.value = false; }
function prev(): void { if (total.value > 1) { current.value = (current.value - 1 + total.value) % total.value; zoomed.value = false; } }
function next(): void { if (total.value > 1) { current.value = (current.value + 1) % total.value; zoomed.value = false; } }
function toggleZoom(): void { zoomed.value = !zoomed.value; }

function onKey(e: KeyboardEvent): void {
  if (!open.value) return;
  if (e.key === 'Escape') close();
  else if (e.key === 'ArrowLeft') prev();
  else if (e.key === 'ArrowRight') next();
}

function onTouchStart(e: TouchEvent): void {
  const t = e.touches[0];
  startX = t.clientX; startY = t.clientY; dragging = true;
}
function onTouchMove(e: TouchEvent): void {
  if (!dragging || zoomed.value) return;
  dragY.value = e.touches[0].clientY - startY;
}
function onTouchEnd(e: TouchEvent): void {
  if (!dragging) return;
  dragging = false;
  const t = e.changedTouches[0];
  const dx = t.clientX - startX;
  const dy = t.clientY - startY;
  if (Math.abs(dy) > 100 && Math.abs(dy) > Math.abs(dx)) { close(); return; }
  if (Math.abs(dx) > 50) { if (dx > 0) prev(); else next(); }
  dragY.value = 0;
}

onMounted(() => window.addEventListener('keydown', onKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));
</script>

<template>
  <Teleport to="body">
    <Transition name="lb">
      <div v-if="open" class="fixed inset-0 z-[200] flex flex-col bg-slate-950/92 backdrop-blur-sm"
        @click.self="close" @touchstart.passive="onTouchStart" @touchmove.passive="onTouchMove" @touchend="onTouchEnd">
        <!-- 顶部条 -->
        <div class="flex items-center justify-between px-4 py-3 text-white/90">
          <span class="text-xs tabular-nums">{{ current + 1 }} / {{ total }}</span>
          <div class="flex items-center gap-3">
            <button class="rounded-full bg-white/10 px-3 py-1.5 text-xs" @click.stop="toggleZoom">
              {{ zoomed ? '适应屏幕' : '原始大小' }}
            </button>
            <button class="flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-lg leading-none"
              aria-label="关闭" @click.stop="close">×</button>
          </div>
        </div>

        <!-- 图片区 -->
        <div class="relative flex flex-1 items-center justify-center overflow-hidden px-3 pb-6" @click.self="close">
          <button v-if="total > 1" class="absolute left-2 z-10 flex h-11 w-11 items-center justify-center rounded-full bg-white/15 text-xl text-white hover:bg-white/25"
            aria-label="上一张" @click.stop="prev">‹</button>
          <img :key="src" :src="src" alt="" :style="{ transform: `translateY(${dragY}px)` }"
            :class="zoomed ? 'max-h-none max-w-none cursor-zoom-out' : 'max-h-full max-w-full cursor-zoom-in object-contain'"
            class="select-none transition-transform duration-200" @click.stop="toggleZoom" />
          <button v-if="total > 1" class="absolute right-2 z-10 flex h-11 w-11 items-center justify-center rounded-full bg-white/15 text-xl text-white hover:bg-white/25"
            aria-label="下一张" @click.stop="next">›</button>
        </div>

        <!-- 缩略图条 -->
        <div v-if="total > 1" class="no-scrollbar flex gap-2 overflow-x-auto px-4 pb-5">
          <button v-for="(img, i) in images" :key="img + i" class="h-14 w-14 shrink-0 overflow-hidden rounded-lg ring-2 transition"
            :class="i === current ? 'ring-white' : 'ring-white/15'" @click.stop="current = i">
            <img :src="img" alt="" class="h-full w-full object-cover" />
          </button>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.lb-enter-active, .lb-leave-active { transition: opacity 0.2s ease; }
.lb-enter-from, .lb-leave-to { opacity: 0; }
</style>
