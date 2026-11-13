<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import type { VoteCampaignDto, VoteResultDto } from '@photo/shared';
import { api } from '../api';
import { useUiStore } from '../stores/ui';
import { useSessionStore } from '../stores/session';
import ImageLightbox from '../components/ImageLightbox.vue';
import ModelInfoDialog from '../components/ModelInfoDialog.vue';

const route = useRoute();
const id = String(route.params.id);
const ui = useUiStore();
const session = useSessionStore();
const campaign = ref<VoteCampaignDto | null>(null);
const result = ref<VoteResultDto | null>(null);
const chosen = ref<string>('');
const busy = ref(false);
const failed = ref('');
/** 点C：投票直接关联的模特资料，服务端已按会员 gating；未关联或模特已删为 null，不展示入口 */
const voteModel = computed(() => campaign.value?.model ?? null);
const modelDialogOpen = ref(false);

const hasImage = computed(() => Boolean(campaign.value?.options.some((o) => o.imageUrl)));

/** 点E：结果行按 optionId 回填方案图，让「投的是哪件服装」一眼可辨（方案名可能只是纯编号） */
function optionImageOf(optionId: string): string {
  return campaign.value?.options.find((o) => o.id === optionId)?.imageUrl ?? '';
}

/* ---------- 图片灯箱：选项图可放大查看，不影响选择 ---------- */
const lightboxOpen = ref(false);
const lightboxImages = ref<string[]>([]);
const lightboxIndex = ref(0);
const lightboxKey = ref(0);
const optionImages = computed(() =>
  (campaign.value?.options ?? []).filter((o) => o.imageUrl).map((o) => o.imageUrl as string),
);
function zoomOption(optionId: string): void {
  const url = campaign.value?.options.find((o) => o.id === optionId)?.imageUrl;
  const imgs = optionImages.value;
  if (!url || !imgs.length) return;
  lightboxImages.value = imgs;
  lightboxIndex.value = Math.max(0, imgs.indexOf(url));
  lightboxKey.value += 1;
  lightboxOpen.value = true;
}
/** 模特资料弹窗里的照片放大：复用同一灯箱 */
function openModelLightbox(images: string[], i: number): void {
  if (!images.length) return;
  lightboxImages.value = images;
  lightboxIndex.value = i;
  lightboxKey.value += 1;
  lightboxOpen.value = true;
}

/* ---------- 票数：客户端可见聚合票数（不含投票人）；不自动轮询，用户刷新页面或点「刷新」即可 ---------- */
const refreshing = ref(false);

async function refreshResult(): Promise<void> {
  refreshing.value = true;
  try {
    result.value = await api.votes.result(id);
  } catch {
    // 草稿 / 无权限等静默跳过，不影响投票主流程
  } finally {
    refreshing.value = false;
  }
}

async function load(): Promise<void> {
  try {
    campaign.value = await api.votes.campaign(id);
    chosen.value = campaign.value.myOptionId ?? '';
    await refreshResult();
  } catch (e) {
    failed.value = e instanceof Error ? e.message : '活动不可见';
  }
}
onMounted(load);

async function cast(): Promise<void> {
  if (!chosen.value) { ui.notify('请先选择方案', 'fail'); return; }
  busy.value = true;
  try {
    campaign.value = await api.votes.cast({ campaignId: id, optionId: chosen.value });
    ui.notify('投票成功，可再次提交修改', 'success');
    await refreshResult();
  } catch (e) {
    ui.notify(e instanceof Error ? e.message : '投票失败', 'fail');
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="mx-auto max-w-3xl pb-28">
    <RouterLink to="/vote" class="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-900">← 全部投票</RouterLink>

    <p v-if="failed" class="mt-3 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-600">{{ failed }}</p>

    <template v-if="campaign">
      <div class="mt-3">
        <div class="flex flex-wrap items-center gap-2">
          <h1 class="text-xl font-semibold text-slate-900 md:text-2xl">{{ campaign.title }}</h1>
          <span class="chip bg-brand/10 text-brand-soft">SVIP 专属</span>
        </div>
        <p class="mt-1.5 text-sm text-slate-500">
          {{ campaign.options.length }} 个方案 · 截止 {{ new Date(campaign.closeAt).toLocaleString('zh-CN') }}
          <span v-if="campaign.myOptionId" class="ml-1 text-emerald-600">· 你已投票，可改</span>
        </p>
        <button v-if="voteModel"
          class="mt-2 inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 shadow-card transition hover:border-brand/40 hover:text-brand"
          @click="modelDialogOpen = true">
          <span class="text-slate-500">模特</span> {{ voteModel.stageName }} · 查看资料
        </button>
      </div>

      <!-- 选项：有图走大图卡，无图回退纯文字卡。整卡点击选择，左上角放大镜单独放大 -->
      <div class="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2" :class="hasImage ? '' : 'sm:grid-cols-3'">
        <div v-for="o in campaign.options" :key="o.id"
          class="cursor-pointer overflow-hidden rounded-2xl border bg-white text-left shadow-card transition"
          :class="chosen === o.id ? 'border-brand ring-2 ring-brand/20' : 'border-slate-200 hover:border-slate-300'"
          role="button" tabindex="0"
          @click="chosen = o.id" @keydown.enter.prevent="chosen = o.id" @keydown.space.prevent="chosen = o.id">
          <div v-if="hasImage" class="relative aspect-[4/3] w-full overflow-hidden bg-slate-50">
            <img v-if="o.imageUrl" :src="o.imageUrl" :alt="o.name" class="h-full w-full object-contain" loading="lazy" />
            <div v-else class="flex h-full items-center justify-center text-xs text-slate-500">暂无图片</div>
            <button v-if="o.imageUrl" type="button"
              class="absolute left-2 top-2 flex h-8 w-8 items-center justify-center rounded-full bg-slate-900/55 text-white backdrop-blur transition hover:bg-slate-900/75"
              aria-label="放大查看图片" @click.stop="zoomOption(o.id)">
              <svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3M11 8v6M8 11h6" />
              </svg>
            </button>
            <span v-if="chosen === o.id"
              class="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-full bg-brand text-sm font-bold text-white">✓</span>
          </div>
          <div class="p-3">
            <p class="text-sm font-medium text-slate-900">{{ o.name }}</p>
            <p class="mt-0.5 text-xs" :class="chosen === o.id ? 'text-brand' : 'text-slate-500'">
              {{ chosen === o.id ? '已选择' : '点击选择' }}
            </p>
          </div>
        </div>
      </div>

      <!-- 吸底提交 -->
      <div class="safe-bottom fixed inset-x-0 bottom-[calc(3.25rem+env(safe-area-inset-bottom))] z-30 border-t border-slate-200 bg-white/95 px-4 py-3 backdrop-blur md:static md:mt-5 md:border-0 md:bg-transparent md:p-0">
        <div class="mx-auto flex max-w-3xl items-center gap-3">
          <p class="min-w-0 flex-1 text-xs text-slate-500">
            {{ chosen ? `已选：${campaign.options.find((o) => o.id === chosen)?.name ?? ''}` : '请选择一个方案' }}
          </p>
          <button class="btn-primary min-w-[8rem]" :disabled="campaign.status !== 'OPEN' || busy || !chosen" @click="cast">
            {{ busy ? '提交中…' : campaign.myOptionId ? '修改投票' : '提交投票' }}
          </button>
        </div>
      </div>

      <!-- 结果：客户端聚合票数，不公开投票人；不自动轮询，刷新页面或点「刷新」更新 -->
      <div v-if="result" class="mt-5 rounded-2xl border border-slate-200 bg-white p-5 shadow-card">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <h2 class="text-sm font-semibold text-slate-900">投票结果</h2>
          <div class="flex items-center gap-2">
            <span class="text-xs text-slate-500">共 <span class="font-semibold tabular-nums text-slate-900">{{ result.totalVotes }}</span> 票</span>
            <button type="button" class="text-xs font-medium text-brand hover:underline disabled:opacity-50" :disabled="refreshing" @click="refreshResult">
              {{ refreshing ? '刷新中…' : '刷新' }}
            </button>
          </div>
        </div>
        <p class="mt-1 text-xs text-slate-500">仅展示票数，不公开投票人；刷新页面或点「刷新」查看最新票数</p>
        <p v-if="result.suppressed" class="mt-1 text-xs text-amber-600">样本过少，明细暂不公开</p>
        <div v-for="o in result.options" :key="o.optionId" class="mt-3">
          <div class="flex items-center justify-between gap-2 text-sm text-slate-700">
            <div class="flex min-w-0 items-center gap-2">
              <div class="relative h-10 w-10 shrink-0 overflow-hidden rounded-md border border-slate-200 bg-slate-50">
                <img v-if="optionImageOf(o.optionId)" :src="optionImageOf(o.optionId)" alt="" class="h-full w-full object-cover" />
                <span v-else class="absolute inset-0 flex items-center justify-center text-[11px] text-slate-500">无图</span>
              </div>
              <span class="truncate">{{ o.name }}<span v-if="o.optionId === campaign.myOptionId" class="ml-1 text-xs text-brand">你投的</span></span>
            </div>
            <span class="shrink-0 tabular-nums">{{ o.voteCount ?? '—' }}{{ o.ratio == null ? '' : ` (${(o.ratio * 100).toFixed(1)}%)` }}</span>
          </div>
          <div class="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-100">
            <div class="h-full rounded-full bg-brand" :style="{ width: `${Math.round((o.ratio ?? 0) * 100)}%` }" />
          </div>
        </div>
      </div>
    </template>

    <ModelInfoDialog v-model:open="modelDialogOpen" :model="voteModel" :can-view-body="session.isMember" @zoom="openModelLightbox" />
    <ImageLightbox :key="lightboxKey" v-model:open="lightboxOpen" :images="lightboxImages" :start="lightboxIndex" />
  </section>
</template>
