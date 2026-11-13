<script setup lang="ts">
/**
 * 图片上传组件（多图）。
 *
 * - 点击方块选择、拖拽到方块、Ctrl+V 粘贴，三种方式都能传；
 * - 上传前在浏览器里压缩：长边 >1600 或体积 >800KB 时重绘到 canvas，显著降低失败率；
 * - 上传后写入同源 URL，父组件直接存字符串数组即可（与后端字段一致）。
 */
import { ref } from 'vue';
import { api } from '../api';

const props = withDefaults(defineProps<{
  modelValue: string[];
  max?: number;
  /** 最多几张可以标为封面（第一张自动作为封面） */
  coverHint?: string;
}>(), { max: 9, coverHint: '第一张作为封面' });

const emit = defineEmits<{ 'update:modelValue': [value: string[]] }>();

/** 选图上限：允许选稍大的原图，压缩后再上传 */
const MAX_PICK_BYTES = 10 * 1024 * 1024;
/** 上传上限：必须与服务端 uploads.ts 的 MAX_BYTES（5MB）一致，否则压缩后仍会被拒 */
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

const uploading = ref(0);
const dragOver = ref(false);
const errorText = ref('');
const fileInput = ref<HTMLInputElement | null>(null);

const images = () => props.modelValue ?? [];

function setImages(next: string[]): void {
  emit('update:modelValue', next);
}

async function compress(file: File): Promise<File> {
  const ok = /^image\/(jpeg|png|webp)$/.test(file.type);
  if (!ok) return file;
  if (file.size < 800 * 1024) {
    // 小图也检查一下尺寸，避免超大像素但压缩率高的图
    const bmp = await createImageBitmap(file).catch(() => null);
    if (!bmp || Math.max(bmp.width, bmp.height) <= 1600) return file;
  }
  const bmp = await createImageBitmap(file).catch(() => null);
  if (!bmp) return file;
  const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bmp.width * scale));
  canvas.height = Math.max(1, Math.round(bmp.height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) return file;
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  const mime = file.type === 'image/png' ? 'image/png' : file.type === 'image/webp' ? 'image/webp' : 'image/jpeg';
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mime, 0.86));
  if (!blob || blob.size >= file.size) return file;
  return new File([blob], file.name, { type: mime });
}

async function handleFiles(files: FileList | File[] | null): Promise<void> {
  if (!files) return;
  errorText.value = '';
  const remain = props.max - images().length;
  if (remain <= 0) { errorText.value = `最多上传 ${props.max} 张`; return; }

  const picked = Array.from(files).slice(0, remain);
  for (const file of picked) {
    if (!/^image\//.test(file.type)) { errorText.value = '只能上传图片文件'; continue; }
    // 原图上限 10MB 只是「允许选」，真正上传的是压缩后的图；
    // 服务端硬限 5MB，压缩后仍超限时在这里明确报错，而不是等接口返回 400 让人摸不着头脑
    if (file.size > MAX_PICK_BYTES) { errorText.value = `${file.name} 超过 10MB，请先压缩`; continue; }
    uploading.value += 1;
    try {
      const compressed = await compress(file);
      if (compressed.size > MAX_UPLOAD_BYTES) {
        errorText.value = `${file.name} 压缩后仍超过 5MB，请换一张尺寸更小的图`;
        continue;
      }
      const result = await api.admin.upload(compressed);
      setImages([...images(), result.url]);
    } catch (e) {
      errorText.value = e instanceof Error ? e.message : '上传失败';
    } finally {
      uploading.value -= 1;
    }
  }
}

function onPick(e: Event): void {
  const input = e.target as HTMLInputElement;
  void handleFiles(input.files);
  input.value = '';
}

function onDrop(e: DragEvent): void {
  dragOver.value = false;
  void handleFiles(e.dataTransfer?.files ?? null);
}

function onPaste(e: ClipboardEvent): void {
  const files = Array.from(e.clipboardData?.files ?? []);
  if (files.length) void handleFiles(files);
}

function remove(index: number): void {
  const next = [...images()];
  next.splice(index, 1);
  setImages(next);
}

function moveFirst(index: number): void {
  if (index === 0) return;
  const next = [...images()];
  const [item] = next.splice(index, 1);
  next.unshift(item);
  setImages(next);
}
</script>

<template>
  <div @paste="onPaste">
    <div class="flex flex-wrap gap-2">
      <!-- 已上传图片 -->
      <div v-for="(url, i) in images()" :key="url + i"
        class="group relative h-24 w-24 overflow-hidden rounded-lg border border-slate-200 bg-slate-50">
        <img :src="url" alt="" class="h-full w-full object-cover" />
        <span v-if="i === 0"
          class="absolute left-1 top-1 rounded bg-slate-900/70 px-1.5 py-0.5 text-[11px] text-white">封面</span>
        <div class="absolute inset-x-0 bottom-0 flex translate-y-full justify-between bg-slate-900/70 px-1 py-1 transition group-hover:translate-y-0">
          <button type="button" class="rounded px-1 text-[11px] text-white hover:bg-white/20"
            :disabled="i === 0" @click="moveFirst(i)">设为封面</button>
          <button type="button" class="rounded px-1 text-[11px] text-rose-200 hover:bg-white/20" @click="remove(i)">删除</button>
        </div>
      </div>

      <!-- 上传中占位 -->
      <div v-for="n in uploading" :key="`u${n}`"
        class="flex h-24 w-24 items-center justify-center rounded-lg border border-dashed border-blue-300 bg-blue-50 text-xs text-blue-600">
        上传中…
      </div>

      <!-- 添加入口 -->
      <button v-if="images().length + uploading < max" type="button"
        class="flex h-24 w-24 flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed text-xs transition"
        :class="dragOver ? 'border-blue-400 bg-blue-50 text-blue-600' : 'border-slate-300 bg-slate-50 text-slate-500 hover:border-blue-400 hover:text-blue-600'"
        @click="fileInput?.click()"
        @dragover.prevent="dragOver = true" @dragleave.prevent="dragOver = false" @drop.prevent="onDrop">
        <span class="text-xl leading-none">+</span>
        <span>上传图片</span>
      </button>
    </div>

    <input ref="fileInput" type="file" accept="image/jpeg,image/png,image/webp" multiple class="hidden" @change="onPick" />

    <p class="mt-1.5 text-xs text-slate-500">
      JPG / PNG / WebP，原图 ≤10MB（会自动压缩到 5MB 以内），最多 {{ max }} 张；可拖拽或 Ctrl+V 粘贴。<span v-if="images().length">{{ coverHint }}</span>
    </p>
    <p v-if="errorText" class="mt-1 text-xs text-rose-600">{{ errorText }}</p>
  </div>
</template>
