<script setup lang="ts">
/**
 * ECharts 封装：按需注册图表与组件，容器尺寸变化自动 resize，卸载即 dispose。
 * option 变化整体重绘（notMerge），避免筛选切换后残留旧系列。
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import * as echarts from 'echarts/core';
import { BarChart, GaugeChart, HeatmapChart, LineChart, PieChart } from 'echarts/charts';
import {
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  TitleComponent,
  TooltipComponent,
  VisualMapComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { EChartsCoreOption } from 'echarts/core';

echarts.use([
  LineChart, BarChart, PieChart, GaugeChart, HeatmapChart,
  GridComponent, TooltipComponent, LegendComponent, DataZoomComponent, VisualMapComponent, MarkLineComponent, TitleComponent,
  CanvasRenderer,
]);

const props = withDefaults(defineProps<{ option: EChartsCoreOption; height?: string }>(), { height: '260px' });
const emit = defineEmits<{ click: [params: Record<string, unknown>] }>();

const el = ref<HTMLElement | null>(null);
let chart: echarts.ECharts | null = null;
let ro: ResizeObserver | null = null;

/** 关闭入场动画：后台/隐藏标签页会暂停 rAF，动画冻结在第 0 帧导致图表空白；驾驶舱要的是即时终态 */
const staticOption = (o: EChartsCoreOption): EChartsCoreOption => ({ ...o, animation: false });

onMounted(() => {
  if (!el.value) return;
  chart = echarts.init(el.value);
  chart.setOption(staticOption(props.option));
  chart.on('click', (p) => emit('click', p as unknown as Record<string, unknown>));
  ro = new ResizeObserver(() => chart?.resize());
  ro.observe(el.value);
});

watch(() => props.option, (o) => chart?.setOption(staticOption(o), { notMerge: true }));

onBeforeUnmount(() => {
  ro?.disconnect();
  chart?.dispose();
  chart = null;
});
</script>

<template>
  <div ref="el" class="w-full" :style="{ height }" />
</template>