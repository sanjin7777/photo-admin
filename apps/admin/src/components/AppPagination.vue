<script setup lang="ts">
/**
 * 统一分页条。
 *
 * 后台所有列表都用它，避免出现「有的页面用 el-button 拼上一页/下一页、
 * 有的页面干脆没有分页」的不一致。基于 Element Plus 的 el-pagination，
 * 样式与后台其余组件同源。
 *
 * 用法：
 *   <AppPagination :page="page" :page-size="pageSize" :total="total" @change="onPageChange" />
 * 组件自身不持有页码状态，全部由父组件控制（与后端分页一一对应）。
 */
const props = withDefaults(defineProps<{
  page: number;
  pageSize: number;
  total: number;
  /** 可选：允许用户切换每页条数 */
  pageSizes?: number[];
  /** 数据量少时不显示分页条（默认 1 页就隐藏） */
  hideOnSinglePage?: boolean;
  /** 右侧补充说明文案，如「共 128 条」 */
  summary?: string;
}>(), {
  pageSizes: () => [10, 20, 50, 100],
  hideOnSinglePage: false,
  summary: '',
});

const emit = defineEmits<{
  (e: 'change', page: number): void;
  (e: 'size-change', pageSize: number): void;
}>();

function onCurrentChange(next: number): void {
  // 防御：el-pagination 在 total 变化时可能回调非法页码
  if (!Number.isFinite(next) || next < 1) return;
  emit('change', next);
}

function onSizeChange(size: number): void {
  emit('size-change', size);
}
</script>

<template>
  <div
    v-if="!(hideOnSinglePage && total <= pageSize)"
    class="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 px-1 pt-3"
  >
    <span class="text-xs text-slate-500">{{ summary }}</span>
    <el-pagination
      :current-page="props.page"
      :page-size="props.pageSize"
      :total="props.total"
      :page-sizes="props.pageSizes"
      background
      layout="total, sizes, prev, pager, next, jumper"
      small
      @current-change="onCurrentChange"
      @size-change="onSizeChange"
    />
  </div>
</template>
