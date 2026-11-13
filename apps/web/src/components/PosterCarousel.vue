<script setup lang="ts">
/**
 * 海报轮播：索引驱动 transition（比原生横向滚动更可控），
 * 支持左右箭头、指示点、触摸滑动、点击放大。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

const props = withDefaults(defineProps<{
  images: string[];
  alt?: string;
  /** 图片容器高度类，默认 16:9 比例卡 */
  ratioClass?: string;
  /** 是否显示指示点 */
  dots?: boolean;
}>(), { alt: '海报', ratioClass: 'aspect-[4/5] sm:aspect-[4/3]', dots: true });

const emit = defineEmits<{ (e: 'zoom', index: number): void }>();

const index = ref(0);
const total = computed(() => props.images.length);
const dragX = ref(0);
let startX = 0;
let startY = 0;
let dragging = false;
let moved = false;

function go(i: number): void {
  if (!total.value) return;
  index.value = (i + total.value) % total.value;
}
function next(): void { go(index.value + 1); }
function prev(): void { go(index.value - 1); }

function onTouchStart(e: TouchEvent): void {
  const t = e.touches[0];
  startX = t.clientX; startY = t.clientY; dragging = true; moved = false; dragX.value = 0;
}
function onTouchMove(e: TouchEvent): void {
  if (!dragging) return;
  const dx = e.touches[0].clientX - startX;
  const dy = e.touches[0].clientY - startY;
  if (!moved && Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 8) moved = true;
  if (moved) dragX.value = dx;
}
function onTouchEnd(): void {
  if (!dragging) return;
  dragging = false;
  if (moved && Math.abs(dragX.value) > 45) {
    if (dragX.value < 0) next(); else prev();
  }
  dragX.value = 0;
}
/** 移动端用 touchend 判定，避免滑动结束误触发放大 */
function onImgClick(): void {
  if (moved) { moved = false; return; }
  emit('zoom', index.value);
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'ArrowLeft') prev();
  else if (e.key === 'ArrowRight') next();
}
onMounted(() => {
  if (total.value > 1) window.addEventListener('keydown', onKey);
});
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));
</script>

<template>
  <div class="group relative overflow-hidden rounded-2xl border border-slate-200 bg-slate-100 shadow-card">
    <!-- 轨道 -->
    <div class="relative w-full overflow-hidden" :class="ratioClass"
      @touchstart.passive="onTouchStart" @touchmove.passive="onTouchMove" @touchend="onTouchEnd">
      <div class="flex h-full w-full transition-transform duration-300 ease-out"
        :style="{ transform: `translateX(calc(-${index * 100}% + ${dragX}px))` }">
        <div v-for="(img, i) in images" :key="img + i" class="relative h-full w-full shrink-0 overflow-hidden bg-slate-100">
          <!-- 竖版海报：原图完整显示（contain），两侧用自身模糊铺底，避免被裁掉文字 -->
          <img :src="img" alt="" aria-hidden="true"
            class="absolute inset-0 h-full w-full scale-110 object-cover opacity-40 blur-xl" draggable="false" />
          <img :src="img" :alt="`${alt} ${i + 1}`" draggable="false"
            class="img-zoom relative h-full w-full select-none object-contain"
            :loading="i === 0 ? 'eager' : 'lazy'" @click="onImgClick" />
        </div>
      </div>

      <!-- 左右箭头 -->
      <template v-if="total > 1">
        <button type="button" aria-label="上一张"
          class="absolute left-2 top-1/2 z-10 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full bg-white/85 text-lg text-slate-700 shadow-sm backdrop-blur transition hover:bg-white"
          @click.stop="prev">‹</button>
        <button type="button" aria-label="下一张"
          class="absolute right-2 top-1/2 z-10 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full bg-white/85 text-lg text-slate-700 shadow-sm backdrop-blur transition hover:bg-white"
          @click.stop="next">›</button>
        <span class="absolute right-3 top-3 rounded-full bg-slate-900/55 px-2 py-0.5 text-xs font-medium text-white tabular-nums">
          {{ index + 1 }}/{{ total }}
        </span>
      </template>

      <!-- 点击放大提示 -->
      <span class="pointer-events-none absolute bottom-3 right-3 rounded-full bg-white/85 px-2 py-1 text-xs text-slate-600 shadow-sm backdrop-blur">
        点击看大图
      </span>
    </div>

    <!-- 指示点 -->
    <div v-if="dots && total > 1" class="flex items-center justify-center gap-1.5 bg-white py-2.5">
      <button v-for="(img, i) in images" :key="`dot-${i}`" type="button" :aria-label="`第 ${i + 1} 张`"
        class="h-1.5 rounded-full transition-all"
        :class="i === index ? 'w-6 bg-brand' : 'w-1.5 bg-slate-300 hover:bg-slate-400'"
        @click="go(i)" />
    </div>
  </div>
</template>
