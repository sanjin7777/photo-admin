/**
 * 浅色主题色板：白底 + 高对比文字，贴近宣传海报的清晰度。
 * 断点与 @photo/shared 保持一致。
 *
 * 说明：主体使用 Tailwind 内置 slate 色阶（背景 slate-50 / 卡片 white / 文字 slate-900·600·400），
 * 只把品牌色抽成 brand / gold 两个语义色，避免自定义色板导致对比度不足。
 */
module.exports = {
  content: ['./index.html', './src/**/*.{vue,ts}'],
  theme: {
    extend: {
      screens: { sm: '640px', md: '768px', lg: '1024px', xl: '1280px', '2xl': '1536px' },
      colors: {
        brand: { DEFAULT: '#E11D48', soft: '#BE123C', 50: '#FFF1F3', 100: '#FFE4E8' },
        gold: { DEFAULT: '#A16207', soft: '#FEF6E7' },
      },
      boxShadow: {
        card: '0 1px 2px rgba(15,23,42,0.04), 0 10px 24px -14px rgba(15,23,42,0.16)',
        float: '0 10px 34px -14px rgba(15,23,42,0.28)',
      },
    },
  },
  plugins: [],
};
