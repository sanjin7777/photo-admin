/**
 * 驾驶舱的 ECharts 配置工厂。
 *
 * 从 CockpitView.vue 抽出来的原因：这些配置本身不含任何响应式状态，只是「数据 → 选项」的
 * 纯映射，留在视图里会让单文件超过 900 行，改一处样式得在几百行配置里翻找。
 * 这里只接收已经算好的数据（视图里的 computed），不读 store、不碰 router，方便单测与复用。
 */
import * as echarts from 'echarts/core';
import type { EChartsCoreOption } from 'echarts/core';

/** 统一的暗房配色：轴文字 / 网格线 / 等宽数字字体 */
export const AXIS = '#8b93a7';
export const GRID_LINE = '#1e2a45';
export const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';
export const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

const tooltipBase = {
  backgroundColor: 'rgba(10,15,30,0.95)',
  borderColor: '#2a3550',
  textStyle: { color: '#e8e6df', fontSize: 11 },
  extraCssText: 'box-shadow: 0 6px 24px rgba(0,0,0,0.5); border-radius: 8px;',
};

/** 台账单位（分）→ 积分数字，保留最多两位小数；KPI 卡片与图表 tooltip 共用同一口径 */
export const fmtYuan = (cent: number): string => (cent / 100).toLocaleString('zh-CN', { maximumFractionDigits: 2 });

/** 金额轴缩写：超过 1 万元显示「x.x万」，避免 y 轴标签互相挤压 */
const shortMoney = (v: number): string => {
  const y = v / 100;
  return y >= 10000 ? `${(y / 10000).toFixed(1)}万` : String(Math.round(y));
};

export interface TrendBucket {
  label: string;
  count: number;
  revenue: number;
}

export interface FillRow {
  id: string;
  title: string;
  cap: number;
  used: number;
  pct: number;
}

export interface DonutSegment {
  label: string;
  value: number;
  color: string;
}

export interface HeatmapData {
  data: Array<[number, number, number]>;
  max: number;
}

export interface CouponStats {
  UNUSED: number;
  USED: number;
  EXPIRED: number;
  REVOKED: number;
  total: number;
  rate: number;
}

/** 报名名额 + 实收金额的双轴趋势（超过 31 天时由视图按周分桶） */
export function createTrendOption(trend: TrendBucket[]): EChartsCoreOption {
  return {
    backgroundColor: 'transparent',
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'cross', label: { backgroundColor: '#1e2a45', color: '#aab3c5' }, crossStyle: { color: '#2a3550' } },
      ...tooltipBase,
      formatter: (params: unknown) => {
        const arr = params as Array<{ axisValue: string; seriesName: string; value: number; color: string }>;
        if (!arr?.length) return '';
        const lines = arr.map((p) => {
          const val = p.seriesName === '实收金额' ? `${fmtYuan(p.value)} 积分` : `${p.value} 名额`;
          return `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${p.color};margin-right:6px"></span>${p.seriesName}：<b style="font-family:${MONO}">${val}</b>`;
        });
        return `<div style="font-weight:600;margin-bottom:4px">${arr[0].axisValue}</div>${lines.join('<br/>')}`;
      },
    },
    legend: { data: ['报名名额', '实收金额'], top: 0, right: 0, itemWidth: 14, itemHeight: 3, textStyle: { color: AXIS, fontSize: 11 } },
    grid: { left: 40, right: 52, top: 34, bottom: 58 },
    xAxis: {
      type: 'category', data: trend.map((b) => b.label), boundaryGap: false,
      axisLine: { lineStyle: { color: GRID_LINE } }, axisTick: { show: false },
      axisLabel: { color: AXIS, fontSize: 10, fontFamily: MONO },
    },
    yAxis: [
      { type: 'value', splitLine: { lineStyle: { color: GRID_LINE, type: 'dashed' } }, axisLabel: { color: AXIS, fontSize: 10, fontFamily: MONO } },
      { type: 'value', splitLine: { show: false }, axisLabel: { color: '#b98a2f', fontSize: 10, fontFamily: MONO, formatter: (v: number) => shortMoney(v) } },
    ],
    dataZoom: [
      { type: 'inside' },
      {
        type: 'slider', height: 16, bottom: 8, borderColor: '#2a3550', backgroundColor: '#0d1428',
        fillerColor: 'rgba(34,211,238,0.12)', handleStyle: { color: '#22d3ee', borderColor: '#22d3ee' },
        moveHandleStyle: { color: '#2a3550' }, textStyle: { color: AXIS, fontSize: 9 },
        dataBackground: { lineStyle: { color: '#2a3550' }, areaStyle: { color: '#16203a' } },
        selectedDataBackground: { lineStyle: { color: '#22d3ee' }, areaStyle: { color: 'rgba(34,211,238,0.15)' } },
      },
    ],
    series: [
      {
        name: '报名名额', type: 'line', smooth: true, symbol: 'circle', symbolSize: 5,
        data: trend.map((b) => b.count),
        lineStyle: { color: '#22d3ee', width: 2 }, itemStyle: { color: '#22d3ee' },
        areaStyle: {
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: 'rgba(34,211,238,0.32)' },
            { offset: 1, color: 'rgba(34,211,238,0.02)' },
          ]),
        },
      },
      {
        name: '实收金额', type: 'line', yAxisIndex: 1, smooth: true, symbol: 'circle', symbolSize: 5,
        data: trend.map((b) => b.revenue),
        lineStyle: { color: '#f5a524', width: 2 }, itemStyle: { color: '#f5a524' },
      },
    ],
  };
}

/** 上座率仪表盘（0-100） */
export function createGaugeOption(occupancy: number): EChartsCoreOption {
  return {
    backgroundColor: 'transparent',
    series: [{
      type: 'gauge', startAngle: 210, endAngle: -30, min: 0, max: 100,
      radius: '98%', center: ['50%', '60%'],
      progress: {
        show: true, width: 14, roundCap: true,
        itemStyle: {
          color: new echarts.graphic.LinearGradient(0, 0, 1, 0, [
            { offset: 0, color: '#22d3ee' }, { offset: 0.6, color: '#f5a524' }, { offset: 1, color: '#f43f7a' },
          ]),
        },
      },
      axisLine: { lineStyle: { width: 14, color: [[1, '#16203a']] } },
      axisTick: { show: false }, splitLine: { show: false }, axisLabel: { show: false },
      pointer: { show: false }, anchor: { show: false },
      title: { show: true, offsetCenter: [0, '42%'], color: AXIS, fontSize: 11 },
      detail: {
        valueAnimation: true, offsetCenter: [0, '8%'], formatter: '{value}%',
        color: '#e8e6df', fontSize: 30, fontWeight: 600, fontFamily: MONO,
      },
      data: [{ value: occupancy, name: '当前上座率' }],
    }],
  };
}

/** 环形图：收款结构 / 会员等级共用 */
export function createDonutOption(segments: DonutSegment[], centerTitle: string): EChartsCoreOption {
  const total = segments.reduce((s, x) => s + x.value, 0);
  return {
    backgroundColor: 'transparent',
    tooltip: { trigger: 'item', ...tooltipBase, formatter: '{b}：{c}（{d}%）' },
    title: {
      text: String(total), subtext: centerTitle, left: 'center', top: '32%',
      textStyle: { color: '#e8e6df', fontSize: 22, fontWeight: 600, fontFamily: MONO },
      subtextStyle: { color: AXIS, fontSize: 10 },
    },
    legend: { bottom: 0, icon: 'circle', itemWidth: 8, itemHeight: 8, textStyle: { color: AXIS, fontSize: 10 } },
    series: [{
      type: 'pie', radius: ['52%', '72%'], center: ['50%', '42%'],
      itemStyle: { borderColor: '#0f1730', borderWidth: 2 },
      label: { show: false },
      emphasis: { scaleSize: 6, itemStyle: { shadowBlur: 16, shadowColor: 'rgba(34,211,238,0.35)' } },
      data: segments.map((s) => ({ name: s.label, value: s.value, itemStyle: { color: s.color } })),
    }],
  };
}

/** 场次满员率横条：≥100% 红、≥70% 黄、其余青，末尾画一条 100% 虚线 */
export function createFillOption(fillRows: FillRow[]): EChartsCoreOption {
  return {
    backgroundColor: 'transparent',
    tooltip: {
      trigger: 'axis', axisPointer: { type: 'shadow' }, ...tooltipBase,
      formatter: (params: unknown) => {
        const arr = params as Array<{ dataIndex: number }>;
        const row = fillRows[arr[0]?.dataIndex];
        return row ? `<b>${row.title}</b><br/>已报 ${row.used} / ${row.cap} 人 · ${row.pct}%` : '';
      },
    },
    grid: { left: 8, right: 44, top: 8, bottom: 8, containLabel: true },
    xAxis: { type: 'value', max: 100, show: false },
    yAxis: {
      type: 'category', inverse: true, data: fillRows.map((r) => r.title),
      axisLine: { show: false }, axisTick: { show: false },
      axisLabel: { color: '#aab3c5', fontSize: 10, width: 108, overflow: 'truncate' },
    },
    series: [{
      type: 'bar', barWidth: 12, data: fillRows.map((r) => r.pct),
      showBackground: true, backgroundStyle: { color: '#16203a', borderRadius: 6 },
      itemStyle: {
        borderRadius: 6,
        color: (p: { dataIndex?: number }) => {
          const pct = fillRows[p.dataIndex ?? 0]?.pct ?? 0;
          const [c1, c2] = pct >= 100 ? ['#f43f7a', '#fb7185'] : pct >= 70 ? ['#f5a524', '#f7c948'] : ['#0891b2', '#22d3ee'];
          return new echarts.graphic.LinearGradient(0, 0, 1, 0, [{ offset: 0, color: c1 }, { offset: 1, color: c2 }]);
        },
      },
      label: { show: true, position: 'right', color: AXIS, fontSize: 10, fontFamily: MONO, formatter: '{c}%' },
      markLine: {
        silent: true, symbol: 'none',
        lineStyle: { color: '#f43f7a', type: 'dashed', width: 1, opacity: 0.5 },
        label: { show: false }, data: [{ xAxis: 100 }],
      },
    }],
  };
}

/** 报名热力：星期 × 小时 */
export function createHeatmapOption(heatmap: HeatmapData): EChartsCoreOption {
  return {
    backgroundColor: 'transparent',
    tooltip: {
      position: 'top', ...tooltipBase,
      formatter: (p: unknown) => {
        const v = (p as { value: [number, number, number] }).value;
        return `${WEEKDAYS[v[1]]} ${String(v[0]).padStart(2, '0')}:00 · <b style="font-family:${MONO}">${v[2]}</b> 条报名`;
      },
    },
    grid: { left: 42, right: 12, top: 10, bottom: 46 },
    xAxis: {
      type: 'category', data: Array.from({ length: 24 }, (_, i) => `${i}时`),
      axisLabel: { color: AXIS, fontSize: 9, interval: 2, fontFamily: MONO },
      axisLine: { lineStyle: { color: GRID_LINE } }, axisTick: { show: false }, splitArea: { show: false },
    },
    yAxis: {
      type: 'category', data: WEEKDAYS,
      axisLabel: { color: AXIS, fontSize: 10 }, axisLine: { show: false }, axisTick: { show: false }, splitArea: { show: false },
    },
    visualMap: {
      min: 0, max: heatmap.max || 1, show: true, orient: 'horizontal', left: 'center', bottom: 0,
      itemWidth: 10, itemHeight: 70, textStyle: { color: AXIS, fontSize: 9 },
      inRange: { color: ['#101830', '#155e75', '#22d3ee', '#f5a524', '#f43f7a'] },
    },
    series: [{
      type: 'heatmap', data: heatmap.data,
      itemStyle: { borderColor: '#0a0f1e', borderWidth: 1, borderRadius: 2 },
      emphasis: { itemStyle: { shadowBlur: 8, shadowColor: 'rgba(34,211,238,0.5)' } },
    }],
  };
}

/** 优惠券四态堆叠条（核销率看旁边的数字，这里只看绝对量分布） */
export function createCouponOption(stats: CouponStats): EChartsCoreOption {
  const parts = [
    { label: '未使用', value: stats.UNUSED, color: '#22d3ee' },
    { label: '已使用', value: stats.USED, color: '#34d399' },
    { label: '已过期', value: stats.EXPIRED, color: '#8b93a7' },
    { label: '已作废', value: stats.REVOKED, color: '#f43f7a' },
  ];
  return {
    backgroundColor: 'transparent',
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, ...tooltipBase },
    legend: { bottom: 0, icon: 'circle', itemWidth: 8, itemHeight: 8, textStyle: { color: AXIS, fontSize: 10 } },
    grid: { left: 8, right: 8, top: 8, bottom: 28, containLabel: true },
    xAxis: { type: 'value', show: false },
    yAxis: { type: 'category', data: [''], axisLabel: { show: false }, axisLine: { show: false }, axisTick: { show: false } },
    series: parts.map((p, i) => ({
      name: p.label, type: 'bar', stack: 'coupon', barWidth: 18, data: [p.value],
      itemStyle: { color: p.color, borderRadius: i === 0 ? [6, 0, 0, 6] : i === parts.length - 1 ? [0, 6, 6, 0] : 0 },
      label: { show: p.value > 0, position: 'inside', formatter: '{c}', fontSize: 9, color: '#0a0f1e', fontFamily: MONO },
    })),
  };
}
