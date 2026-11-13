<script setup lang="ts" generic="T extends Record<string, unknown>">
/**
 * 桌面表格 / 移动卡片 二合一的列表容器。
 *
 * 起初只能渲染纯文本单元格，所以只有治理日志页用得上，其它页面宁可手写两份
 * （桌面 <table> + 移动卡片）。这里补上 `#cell` 插槽后，徽章、按钮、缩略图
 * 这类富内容也能复用同一份列定义，不必再维护两套结构。
 *
 * 用法：
 *   <ResponsiveTable :rows="list" :columns="columns">
 *     <template #cell="{ row, column }">
 *       <span v-if="column.key === 'status'" :class="badgeOf(row.status).cls">{{ badgeOf(row.status).label }}</span>
 *       <template v-else>{{ row[column.key] ?? '—' }}</template>
 *     </template>
 *   </ResponsiveTable>
 */
import { computed } from 'vue';
import { useBreakpoint } from '../composables/useBreakpoint';
import { useUiStore } from '../stores/ui';

export interface TableColumn {
  key: string;
  label: string;
  /** 表格档列宽（px），卡片档忽略 */
  width?: number;
}

const props = withDefaults(
  defineProps<{
    rows: T[];
    columns: TableColumn[];
    /** 空态文案 */
    emptyText?: string;
    /** 是否显示顶部「共 N 条」与移动端表格/卡片切换 */
    showToolbar?: boolean;
  }>(),
  { emptyText: '暂无数据', showToolbar: true },
);

const { isDesktop } = useBreakpoint();
const ui = useUiStore();
// 移动端默认卡片化；用户可切回横向滚动表格
const useTable = computed(() => (!isDesktop.value ? ui.tableMode === 'table' : true));
</script>

<template>
  <div>
    <div v-if="showToolbar" class="mb-2 flex items-center justify-between gap-2">
      <p class="text-xs text-slate-500">共 {{ rows.length }} 条</p>
      <el-radio-group v-if="!isDesktop" v-model="ui.tableMode" size="small">
        <el-radio-button value="table">表格</el-radio-button>
        <el-radio-button value="card">卡片</el-radio-button>
      </el-radio-group>
    </div>

    <!-- 表格档：窄屏横向滚动 + 最小宽度，避免列被挤压 -->
    <div v-if="useTable" class="table-scroll rounded-xl bg-white">
      <el-table :data="rows" size="small" border stripe>
        <el-table-column
          v-for="c in columns"
          :key="c.key"
          :label="c.label"
          :min-width="c.width ?? 120"
        >
          <template #default="{ row }">
            <slot name="cell" :row="row" :column="c" :value="row[c.key]">{{ row[c.key] }}</slot>
          </template>
        </el-table-column>
      </el-table>
      <p v-if="!rows.length" class="py-8 text-center text-sm text-slate-500">{{ emptyText }}</p>
    </div>

    <!-- 卡片档：默认逐列平铺；复杂行可用 #card 整块自定义（按钮/徽章/缩略图） -->
    <div v-else class="space-y-2">
      <template v-for="(row, i) in rows" :key="String(row.id ?? i)">
        <slot name="card" :row="row" :index="i">
          <div class="card">
            <div
              v-for="c in columns"
              :key="c.key"
              class="flex justify-between gap-3 border-b border-slate-100 py-1 text-sm last:border-0"
            >
              <span class="shrink-0 text-slate-500">{{ c.label }}</span>
              <span class="min-w-0 text-right">
                <slot name="cell" :row="row" :column="c" :value="row[c.key]">{{ row[c.key] }}</slot>
              </span>
            </div>
          </div>
        </slot>
      </template>
      <p v-if="!rows.length" class="card text-center text-sm text-slate-500">{{ emptyText }}</p>
    </div>
  </div>
</template>
