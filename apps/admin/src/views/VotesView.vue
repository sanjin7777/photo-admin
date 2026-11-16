<script setup lang="ts">
/**
 * 服装投票管理：列表 + 新建 / 查看实时票数 / 修改方案。
 * 新建一律落草稿；开放后仍可新增方案与改名换图，但已有票的方案不能删。
 */
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue';
import type { AdminVoteCampaignDto, ModelProfileDto, VoteLiveDto } from '@photo/shared';
import { api } from '../api';
import { useUiStore } from '../stores/ui';
import ImageUploader from '../components/ImageUploader.vue';
import AppPagination from '../components/AppPagination.vue';
import { VOTE_STATUS, metaOf, shortTime, toLocalInput } from '../utils/labels';

const ui = useUiStore();
const campaigns = ref<AdminVoteCampaignDto[]>([]);
const loading = ref(true);
/** 点C：新建/修改投票时下拉选模特，前台投票页据此展示模特资料 */
const models = ref<ModelProfileDto[]>([]);

function hideBroken(img: Event): void {
  (img.target as HTMLImageElement).style.display = 'none';
}

const dialogOpen = ref(false);
const saving = ref(false);

interface OptionDraft { name: string; images: string[] }

const form = reactive({
  title: '',
  modelId: '',
  openAt: '',
  closeAt: '',
});
const options = ref<OptionDraft[]>([
  { name: '', images: [] },
  { name: '', images: [] },
]);

const imageCount = computed(() => options.value.filter((o) => o.images.length).length);

/**
 * 投票活动用前端分页。
 * `/votes` 接口返回完整数组（活动数量本身很少，一年不过几十场），
 * 为避免后台「有的页面有分页、有的没有」的不一致，这里在本地切片。
 */
const page = ref(1);
const pageSize = ref(20);
const total = computed(() => campaigns.value.length);
const pagedCampaigns = computed(() => {
  const start = (page.value - 1) * pageSize.value;
  return campaigns.value.slice(start, start + pageSize.value);
});

/** 分页组件回调（页码已由组件保证合法） */
function goPageTo(next: number): void {
  if (next === page.value) return;
  page.value = next;
}

/** 切换每页条数：回到第 1 页，避免页码越界 */
function changePageSize(size: number): void {
  pageSize.value = size;
  page.value = 1;
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    campaigns.value = (await api.admin.votes.list()).list;
  } catch {
    // 统一错误提示
  } finally {
    loading.value = false;
  }
}
onMounted(() => {
  void load();
  void api.admin.models.list({ pageSize: 100 })
    .then((r) => { models.value = r.list; })
    .catch(() => undefined);
});

function openCreate(): void {
  form.title = '';
  form.modelId = '';
  form.openAt = '';
  form.closeAt = '';
  options.value = [{ name: '', images: [] }, { name: '', images: [] }];
  dialogOpen.value = true;
}

function addOption(): void {
  options.value.push({ name: '', images: [] });
}
function removeOption(i: number): void {
  if (options.value.length > 2) options.value.splice(i, 1);
}

async function create(): Promise<void> {
  if (form.title.trim().length < 2) { ui.notify('活动标题至少 2 个字', 'warning'); return; }
  if (!form.openAt || !form.closeAt) { ui.notify('请选择开始与结束时间', 'warning'); return; }
  const cleaned = options.value
    .map((o) => ({ name: o.name.trim(), imageUrl: o.images[0] ?? null }))
    .filter((o) => o.name);
  if (cleaned.length < 2) { ui.notify('至少需要 2 个填写了名称的方案', 'warning'); return; }

  saving.value = true;
  try {
    await api.admin.votes.create({
      title: form.title.trim(),
      modelId: form.modelId || null,
      openAt: new Date(form.openAt).toISOString(),
      closeAt: new Date(form.closeAt).toISOString(),
      maxVotesPerUser: 1,
      options: cleaned.map((o, i) => ({ name: o.name, imageUrl: o.imageUrl, sort: i })),
    });
    ui.notify('已创建为草稿，确认无误后在列表里发布', 'success');
    dialogOpen.value = false;
    await load();
  } catch {
    // 统一错误提示
  } finally {
    saving.value = false;
  }
}

async function openCampaign(c: AdminVoteCampaignDto): Promise<void> {
  try {
    await ui.confirm(`开放「${c.title}」的投票？开放后 SVIP 会员在投票时间内可提交。`);
  } catch { return; }
  try {
    await api.admin.votes.open(c.id);
    ui.notify('投票已开放', 'success');
    await load();
  } catch {
    // 统一错误提示
  }
}

async function publish(c: AdminVoteCampaignDto): Promise<void> {  try {
    await ui.confirm(`发布「${c.title}」的投票结果？发布后活动关闭，前台可看到聚合结果。`);
  } catch { return; }
  try {
    await api.admin.votes.publish(c.id);
    ui.notify('结果已发布', 'success');
    await load();
  } catch {
    // 统一错误提示
  }
}

/* ---------------- 实时查看 ---------------- */
const liveOpen = ref(false);
const liveLoading = ref(false);
const live = ref<VoteLiveDto | null>(null);
/** 投票人多时需要按微信号/昵称/方案快速定位 */
const voterKeyword = ref('');
let liveTimer: ReturnType<typeof setInterval> | null = null;

const visibleVoters = computed(() => {
  const kw = voterKeyword.value.trim().toLowerCase();
  if (!kw) return live.value?.voters ?? [];
  return (live.value?.voters ?? []).filter((v) =>
    [v.wechatId, v.nickname, v.optionName].some((x) => String(x ?? '').toLowerCase().includes(kw)),
  );
});

/** 点E：投票人明细里按 optionId 回填方案图，方案名若只是编号也能看出是哪件服装 */
function voterOptionImage(optionId: string): string {
  return live.value?.campaign.options.find((o) => o.id === optionId)?.imageUrl ?? '';
}

function stopLiveTimer(): void {
  if (liveTimer) { clearInterval(liveTimer); liveTimer = null; }
}

async function loadLive(): Promise<void> {
  const id = live.value?.campaign.id;
  if (!id) return;
  liveLoading.value = true;
  try {
    live.value = await api.admin.votes.live(id);
  } catch {
    // 统一错误提示
  } finally {
    liveLoading.value = false;
  }
}

async function openLive(c: AdminVoteCampaignDto): Promise<void> {
  live.value = null;
  voterKeyword.value = '';
  liveOpen.value = true;
  liveLoading.value = true;
  try {
    live.value = await api.admin.votes.live(c.id);
    stopLiveTimer();
    // 打开期间每 15 秒刷新一次，运营能直接看到票数变化
    liveTimer = setInterval(() => { void loadLive(); }, 15_000);
  } catch {
    liveOpen.value = false;
  } finally {
    liveLoading.value = false;
  }
}

function closeLive(): void {
  stopLiveTimer();
  live.value = null;
}
onUnmounted(stopLiveTimer);

/* ---------------- 修改 ---------------- */
interface EditOption { id?: string; name: string; images: string[]; voteCount: number }

const editOpen = ref(false);
const editSaving = ref(false);
const editId = ref('');
const editStatus = ref('');
const editForm = reactive({ title: '', modelId: '', openAt: '', closeAt: '' });
const editOptions = ref<EditOption[]>([]);

function openEdit(c: AdminVoteCampaignDto): void {
  if (c.status === 'PUBLISHED') { ui.notify('结果已发布，不能再修改', 'warning'); return; }
  editId.value = c.id;
  editStatus.value = c.status;
  editForm.title = c.title;
  editForm.modelId = c.modelId ?? '';
  editForm.openAt = toLocalInput(c.openAt);
  editForm.closeAt = toLocalInput(c.closeAt);
  editOptions.value = c.options.map((o) => ({
    id: o.id, name: o.name, images: o.imageUrl ? [o.imageUrl] : [], voteCount: 0,
  }));
  editOpen.value = true;
  // 票数决定哪些方案不能删：拉一次实时数据回填，失败时按 0 处理（服务端仍会兜底拒绝）
  void api.admin.votes.live(c.id)
    .then((res) => {
      const counts = new Map(res.options.map((o) => [o.optionId, o.voteCount]));
      editOptions.value.forEach((o) => { o.voteCount = o.id ? (counts.get(o.id) ?? 0) : 0; });
    })
    .catch(() => undefined);
}

function addEditOption(): void {
  editOptions.value.push({ name: '', images: [], voteCount: 0 });
}
function removeEditOption(i: number): void {
  const o = editOptions.value[i];
  if (!o) return;
  if (o.voteCount > 0) { ui.notify(`方案「${o.name}」已有 ${o.voteCount} 票，不能删除，只能改名或换图`, 'warning'); return; }
  if (editOptions.value.length <= 2) { ui.notify('至少保留 2 个方案', 'warning'); return; }
  editOptions.value.splice(i, 1);
}

async function saveEdit(): Promise<void> {
  if (editForm.title.trim().length < 2) { ui.notify('活动标题至少 2 个字', 'warning'); return; }
  if (!editForm.openAt || !editForm.closeAt) { ui.notify('请选择开始与结束时间', 'warning'); return; }
  const rows = editOptions.value
    .map((o) => ({ ...o, name: o.name.trim() }))
    .filter((o) => o.name);
  if (rows.length < 2) { ui.notify('至少需要 2 个填写了名称的方案', 'warning'); return; }

  editSaving.value = true;
  try {
    await api.admin.votes.update(editId.value, {
      title: editForm.title.trim(),
      modelId: editForm.modelId || null,
      openAt: new Date(editForm.openAt).toISOString(),
      closeAt: new Date(editForm.closeAt).toISOString(),
      options: rows.map((o, i) => ({
        // 带 id = 更新已有方案；不带 = 新增。被移除且无票的方案由服务端删除
        ...(o.id ? { id: o.id } : {}),
        name: o.name,
        imageUrl: o.images[0] ?? null,
        sort: i,
      })),
    });
    ui.notify('投票已更新', 'success');
    editOpen.value = false;
    await load();
    if (liveOpen.value && live.value?.campaign.id === editId.value) await loadLive();
  } catch {
    // 统一错误提示
  } finally {
    editSaving.value = false;
  }
}
</script>

<template>
  <section>
    <div class="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 class="text-xl font-semibold text-slate-900">服装投票</h1>
        <p class="mt-1 text-sm text-slate-500">仅 SVIP 会员可参与；同一人可改票，前台只展示聚合结果。</p>
      </div>
      <el-button type="primary" @click="openCreate">+ 新建投票</el-button>
    </div>

    <div class="overflow-hidden rounded-xl border border-slate-200 bg-white">
      <table class="hidden w-full text-left text-sm md:table">
        <thead class="bg-slate-50 text-xs text-slate-500">
          <tr>
            <th class="px-3 py-2.5 font-medium">活动</th>
            <th class="px-3 py-2.5 font-medium">方案</th>
            <th class="px-3 py-2.5 font-medium">时间</th>
            <th class="px-3 py-2.5 font-medium">票数</th>
            <th class="px-3 py-2.5 font-medium">状态</th>
            <th class="px-3 py-2.5 text-right font-medium">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="c in pagedCampaigns" :key="c.id" class="border-t border-slate-100 hover:bg-slate-50/60">
            <td class="px-3 py-2.5">
              <div class="flex items-center gap-2.5">
                <div class="relative h-11 w-11 shrink-0 overflow-hidden rounded-md bg-slate-100">
                  <span class="absolute inset-0 flex items-center justify-center text-[11px] text-slate-500">无图</span>
                  <img v-if="c.options[0]?.imageUrl" :src="c.options[0].imageUrl" alt="" class="absolute inset-0 h-full w-full object-cover" @error="hideBroken" />
                </div>
                <div class="min-w-0">
                  <p class="clamp-1 font-medium text-slate-900" :title="c.title">{{ c.title }}</p>
                  <p v-if="c.model" class="clamp-1 text-xs text-slate-500">模特：{{ c.model.stageName }}</p>
                </div>
              </div>
            </td>
            <td class="whitespace-nowrap px-3 py-2.5 text-slate-600">
              {{ c.options.length }} 个方案
              <p class="text-xs text-slate-500">{{ c.options.filter((o) => o.imageUrl).length }} 张带图</p>
            </td>
            <td class="whitespace-nowrap px-3 py-2.5 text-xs text-slate-500">
              {{ shortTime(c.openAt) }} – {{ shortTime(c.closeAt) }}
            </td>
            <td class="px-3 py-2.5 text-slate-600">
              <span class="font-medium text-slate-900">{{ c.totalVotes }}</span> 票
              <p class="text-xs text-slate-500">{{ c.lastVotedAt ? shortTime(c.lastVotedAt) : '暂无投票' }}</p>
            </td>
            <td class="whitespace-nowrap px-3 py-2.5">
              <span class="rounded-full px-2 py-0.5 text-xs" :class="metaOf(VOTE_STATUS, c.status).cls">
                {{ metaOf(VOTE_STATUS, c.status).label }}
              </span>
            </td>
            <td class="px-3 py-2.5 text-right whitespace-nowrap">
              <el-button size="small" @click="openLive(c)">查看</el-button>
              <el-button v-if="c.status !== 'PUBLISHED'" size="small" @click="openEdit(c)">修改</el-button>
              <el-button v-if="c.status === 'DRAFT'" size="small" type="primary" @click="openCampaign(c)">开放投票</el-button>
              <el-button v-if="c.status === 'OPEN' || c.status === 'CLOSED'" size="small" @click="publish(c)">结束并发布</el-button>
              <span v-if="c.status === 'PUBLISHED'" class="text-xs text-slate-500">已发布</span>
            </td>
          </tr>
          <tr v-if="!loading && !campaigns.length">
            <td colspan="6" class="px-3 py-14 text-center">
              <p class="text-sm text-slate-600">还没有投票活动</p>
              <p class="mt-1 text-xs text-slate-500">点右上角「+ 新建投票」开始</p>
            </td>
          </tr>
        </tbody>
      </table>

      <!-- 移动端卡片 -->
      <div class="divide-y divide-slate-100 md:hidden">
        <div v-for="c in pagedCampaigns" :key="c.id" class="p-3">
          <div class="flex items-start justify-between gap-2">
            <p class="clamp-1 font-medium text-slate-900">{{ c.title }}</p>
            <span class="shrink-0 rounded-full px-2 py-0.5 text-[11px]" :class="metaOf(VOTE_STATUS, c.status).cls">{{ metaOf(VOTE_STATUS, c.status).label }}</span>
          </div>
          <p class="mt-1 text-xs text-slate-500">{{ c.options.length }} 个方案 · {{ c.totalVotes }} 票</p>
          <p v-if="c.model" class="mt-0.5 text-xs text-slate-500">模特：{{ c.model.stageName }}</p>
          <p class="mt-0.5 text-xs text-slate-500">{{ c.lastVotedAt ? `最近投票 ${shortTime(c.lastVotedAt)}` : '暂无投票' }}</p>
          <div class="mt-2 flex flex-wrap gap-2">
            <el-button size="small" @click="openLive(c)">查看</el-button>
            <el-button v-if="c.status !== 'PUBLISHED'" size="small" @click="openEdit(c)">修改</el-button>
            <el-button v-if="c.status === 'DRAFT'" size="small" type="primary" @click="openCampaign(c)">开放投票</el-button>
            <el-button v-if="c.status === 'OPEN' || c.status === 'CLOSED'" size="small" @click="publish(c)">结束并发布</el-button>
          </div>
        </div>
        <div v-if="!loading && !campaigns.length" class="px-3 py-12 text-center text-sm text-slate-500">还没有投票活动</div>
      </div>
    </div>

    <AppPagination
      :page="page"
      :page-size="pageSize"
      :total="total"
      :hide-on-single-page="true"
      :summary="`共 ${total} 个投票活动`"
      @change="(p) => goPageTo(p)"
      @size-change="(s) => changePageSize(s)"
    />

    <!-- 新建弹窗 -->
    <el-dialog v-model="dialogOpen" title="新建投票" width="min(760px, 94vw)" top="7vh" destroy-on-close>
      <div class="max-h-[66vh] space-y-4 overflow-y-auto pr-1">
        <section class="rounded-xl border border-slate-200 p-4">
          <h4 class="mb-3 text-sm font-semibold text-slate-900">基本信息</h4>
          <el-form label-width="86px" label-position="left">
            <el-form-item label="活动标题" required>
              <el-input v-model="form.title" placeholder="例：3 月场服装方案投票" clearable />
            </el-form-item>
            <el-form-item label="关联模特">
              <div class="w-full">
                <el-select v-model="form.modelId" filterable clearable
                  placeholder="不关联模特（前台不展示模特资料）" class="!w-full">
                  <el-option v-for="m in models" :key="m.id" :label="m.stageName" :value="m.id" />
                </el-select>
                <span class="mt-1 block text-xs text-slate-500">选定后前台投票页顶部展示该模特资料；身高/三围仍仅会员可见。</span>
              </div>
            </el-form-item>
            <el-form-item label="开始时间" required>
              <el-date-picker v-model="form.openAt" type="datetime" placeholder="选择开始时间"
                format="YYYY-MM-DD HH:mm" value-format="YYYY-MM-DDTHH:mm:ss" class="!w-full" />
            </el-form-item>
            <el-form-item label="结束时间" required>
              <el-date-picker v-model="form.closeAt" type="datetime" placeholder="选择结束时间"
                format="YYYY-MM-DD HH:mm" value-format="YYYY-MM-DDTHH:mm:ss" class="!w-full" />
            </el-form-item>
          </el-form>
        </section>

        <section class="rounded-xl border border-slate-200 p-4">
          <div class="mb-1 flex items-center justify-between">
            <h4 class="text-sm font-semibold text-slate-900">服装方案</h4>
            <el-button size="small" @click="addOption">+ 添加方案</el-button>
          </div>
          <p class="mb-3 text-xs text-slate-500">至少 2 个方案；上传图片后前台会显示为大图卡片，无图则显示文字卡。</p>

          <div class="space-y-3">
            <div v-for="(o, i) in options" :key="i" class="rounded-lg bg-slate-50 p-3">
              <div class="mb-2 flex items-center gap-2">
                <span class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-200 text-xs text-slate-600">{{ i + 1 }}</span>
                <el-input v-model="o.name" placeholder="方案名称，如：复古胶片" class="!flex-1" />
                <el-button size="small" text type="danger" :disabled="options.length <= 2" @click="removeOption(i)">删除</el-button>
              </div>
              <ImageUploader v-model="o.images" :max="1" cover-hint="" />
            </div>
          </div>

          <p class="mt-3 text-xs text-slate-500">
            共 {{ options.filter((o) => o.name.trim()).length }} 个有效方案，其中 {{ imageCount }} 个已配图。
          </p>
        </section>
      </div>

      <template #footer>
        <div class="flex justify-end gap-2">
          <el-button @click="dialogOpen = false">取消</el-button>
          <el-button type="primary" :loading="saving" @click="create">创建草稿</el-button>
        </div>
      </template>
    </el-dialog>

    <!-- 修改弹窗：进行中/已截止也可改，有票方案只能改名换图 -->
    <el-dialog v-model="editOpen" title="修改投票" width="min(760px, 94vw)" top="7vh" destroy-on-close>
      <div class="max-h-[66vh] space-y-4 overflow-y-auto pr-1">
        <p class="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">
          投票进行中也可以修改：新增方案、改名、换图都放行；{{ editStatus === 'DRAFT' ? '草稿可自由增删方案。' : '已有票的方案不能删除。' }}
        </p>
        <section class="rounded-xl border border-slate-200 p-4">
          <h4 class="mb-3 text-sm font-semibold text-slate-900">基本信息</h4>
          <el-form label-width="86px" label-position="left">
            <el-form-item label="活动标题" required>
              <el-input v-model="editForm.title" clearable />
            </el-form-item>
            <el-form-item label="关联模特">
              <div class="w-full">
                <el-select v-model="editForm.modelId" filterable clearable
                  placeholder="不关联模特（前台不展示模特资料）" class="!w-full">
                  <el-option v-for="m in models" :key="m.id" :label="m.stageName" :value="m.id" />
                </el-select>
                <span class="mt-1 block text-xs text-slate-500">选定后前台投票页顶部展示该模特资料；身高/三围仍仅会员可见。</span>
              </div>
            </el-form-item>
            <el-form-item label="开始时间" required>
              <el-date-picker v-model="editForm.openAt" type="datetime" placeholder="选择开始时间"
                format="YYYY-MM-DD HH:mm" value-format="YYYY-MM-DDTHH:mm:ss" class="!w-full" />
            </el-form-item>
            <el-form-item label="结束时间" required>
              <el-date-picker v-model="editForm.closeAt" type="datetime" placeholder="选择结束时间"
                format="YYYY-MM-DD HH:mm" value-format="YYYY-MM-DDTHH:mm:ss" class="!w-full" />
            </el-form-item>
          </el-form>
        </section>

        <section class="rounded-xl border border-slate-200 p-4">
          <div class="mb-3 flex items-center justify-between">
            <h4 class="text-sm font-semibold text-slate-900">服装方案</h4>
            <el-button size="small" @click="addEditOption">+ 添加方案</el-button>
          </div>
          <div class="space-y-3">
            <div v-for="(o, i) in editOptions" :key="o.id ?? `new-${i}`" class="rounded-lg bg-slate-50 p-3">
              <div class="mb-2 flex items-center gap-2">
                <span class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-200 text-xs text-slate-600">{{ i + 1 }}</span>
                <el-input v-model="o.name" placeholder="方案名称" class="!flex-1" />
                <span v-if="o.voteCount > 0" class="shrink-0 rounded-full bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700">{{ o.voteCount }} 票</span>
                <span v-else-if="!o.id" class="shrink-0 rounded-full bg-blue-50 px-2 py-0.5 text-xs text-blue-700">新增</span>
                <el-button size="small" text type="danger" :disabled="editOptions.length <= 2 || o.voteCount > 0" @click="removeEditOption(i)">删除</el-button>
              </div>
              <ImageUploader v-model="o.images" :max="1" cover-hint="" />
            </div>
          </div>
        </section>
      </div>

      <template #footer>
        <div class="flex justify-end gap-2">
          <el-button @click="editOpen = false">取消</el-button>
          <el-button type="primary" :loading="editSaving" @click="saveEdit">保存修改</el-button>
        </div>
      </template>
    </el-dialog>

    <!-- 实时票数 + 投票人明细 -->
    <el-dialog v-model="liveOpen" title="实时投票情况" width="min(820px, 94vw)" top="6vh" destroy-on-close @closed="closeLive">
      <div v-loading="liveLoading" class="max-h-[70vh] space-y-4 overflow-y-auto pr-1">
        <template v-if="live">
          <section class="rounded-xl border border-slate-200 p-4">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <div class="min-w-0">
                <p class="truncate font-medium text-slate-900">{{ live.campaign.title }}</p>
                <p class="mt-0.5 text-xs text-slate-500">
                  {{ shortTime(live.campaign.openAt) }} – {{ shortTime(live.campaign.closeAt) }} ·
                  <span :class="metaOf(VOTE_STATUS, live.campaign.status).cls" class="rounded-full px-1.5 py-0.5 text-[11px]">{{ metaOf(VOTE_STATUS, live.campaign.status).label }}</span>
                </p>
              </div>
              <div class="flex items-center gap-3">
                <div class="text-right">
                  <p class="text-xl font-semibold text-slate-900">{{ live.totalVotes }}<span class="ml-1 text-xs font-normal text-slate-500">票</span></p>
                  <p class="text-xs text-slate-500">最近投票 {{ live.lastVotedAt ? shortTime(live.lastVotedAt) : '暂无' }}</p>
                </div>
                <el-button size="small" :loading="liveLoading" @click="loadLive">刷新</el-button>
              </div>
            </div>
            <p class="mt-2 text-xs text-slate-500">前台只展示聚合结果；投票人明细仅后台可见。打开期间每 15 秒自动刷新一次。</p>
          </section>

          <section class="rounded-xl border border-slate-200 p-4">
            <h4 class="mb-3 text-sm font-semibold text-slate-900">方案票数</h4>
            <div class="space-y-3">
              <div v-for="o in live.options" :key="o.optionId">
                <div class="mb-1 flex items-center justify-between gap-2 text-xs">
                  <div class="flex min-w-0 items-center gap-2">
                    <div class="relative h-9 w-9 shrink-0 overflow-hidden rounded-md border border-slate-200 bg-slate-50">
                      <img v-if="o.imageUrl" :src="o.imageUrl" alt="" class="h-full w-full object-cover" />
                      <span v-else class="absolute inset-0 flex items-center justify-center text-[11px] text-slate-500">无图</span>
                    </div>
                    <span class="truncate text-slate-700">{{ o.name }}</span>
                  </div>
                  <span class="shrink-0 text-slate-500">{{ o.voteCount }} 票 · {{ o.ratio == null ? '—' : `${(o.ratio * 100).toFixed(1)}%` }}</span>
                </div>
                <div class="h-2 overflow-hidden rounded-full bg-slate-100">
                  <div class="h-full rounded-full bg-blue-500" :style="{ width: `${(o.ratio ?? 0) * 100}%` }"></div>
                </div>
              </div>
              <p v-if="!live.options.length" class="text-xs text-slate-500">还没有方案</p>
            </div>
          </section>

          <section class="rounded-xl border border-slate-200 p-4">
            <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h4 class="text-sm font-semibold text-slate-900">
                投票人明细（{{ voterKeyword ? `${visibleVoters.length}/${live.voters.length}` : live.voters.length }}）
              </h4>
              <el-input v-model="voterKeyword" placeholder="搜索微信号 / 昵称 / 方案"
                clearable class="!w-56" />
            </div>
            <div class="overflow-x-auto">
              <table class="hidden w-full text-left text-sm md:table">
                <thead class="text-xs text-slate-500">
                  <tr>
                    <th class="px-2 py-1.5 font-medium">微信号</th>
                    <th class="px-2 py-1.5 font-medium">昵称</th>
                    <th class="px-2 py-1.5 font-medium">所选方案</th>
                    <th class="px-2 py-1.5 font-medium">投票时间</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="v in visibleVoters" :key="v.userId" class="border-t border-slate-100">
                    <td class="px-2 py-1.5 text-slate-700">{{ v.wechatId ?? '—' }}</td>
                    <td class="px-2 py-1.5 text-slate-600">{{ v.nickname ?? '—' }}</td>
                    <td class="px-2 py-1.5 text-slate-700">
                      <div class="flex items-center gap-1.5">
                        <div class="relative h-7 w-7 shrink-0 overflow-hidden rounded border border-slate-200 bg-slate-50">
                          <img v-if="voterOptionImage(v.optionId)" :src="voterOptionImage(v.optionId)" alt="" class="h-full w-full object-cover" />
                          <span v-else class="absolute inset-0 flex items-center justify-center text-[9px] text-slate-500">—</span>
                        </div>
                        <span class="truncate">{{ v.optionName }}</span>
                      </div>
                    </td>
                    <td class="whitespace-nowrap px-2 py-1.5 text-xs text-slate-500">{{ shortTime(v.votedAt) }}</td>
                  </tr>
                </tbody>
              </table>
              <!-- 移动端：投票人明细改成两行式条目，微信号与方案都放得下 -->
              <div class="divide-y divide-slate-100 md:hidden">
                <div v-for="v in visibleVoters" :key="v.userId" class="flex items-start gap-2 py-2">
                  <div class="relative h-9 w-9 shrink-0 overflow-hidden rounded border border-slate-200 bg-slate-50">
                    <img v-if="voterOptionImage(v.optionId)" :src="voterOptionImage(v.optionId)" alt="" class="h-full w-full object-cover" />
                    <span v-else class="absolute inset-0 flex items-center justify-center text-[11px] text-slate-500">—</span>
                  </div>
                  <div class="min-w-0 flex-1">
                    <p class="clamp-1 text-sm text-slate-800">{{ v.wechatId ?? '—' }}<span v-if="v.nickname" class="text-xs text-slate-500"> · {{ v.nickname }}</span></p>
                    <p class="clamp-1 text-xs text-slate-600">投给 {{ v.optionName }}</p>
                  </div>
                  <span class="shrink-0 text-xs text-slate-500">{{ shortTime(v.votedAt) }}</span>
                </div>
              </div>
              <p v-if="!visibleVoters.length" class="py-6 text-center text-xs text-slate-500">
                {{ live.voters.length ? '没有符合搜索条件的投票人' : '还没有人投票' }}
              </p>
            </div>
          </section>
        </template>
      </div>
      <template #footer>
        <div class="flex justify-end">
          <el-button @click="liveOpen = false">关闭</el-button>
        </div>
      </template>
    </el-dialog>
  </section>
</template>
