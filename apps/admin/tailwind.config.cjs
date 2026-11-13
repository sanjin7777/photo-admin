/**
 * PC 优先布局，但断点与前台共用同一套 token。
 *
 * ⚠️ 色板必须与前台 web/tailwind.config.cjs 保持一致：
 * 后台页面里用了 bg-brand / text-brand / bg-gold 等语义色，
 * 若这里没定义对应颜色，Tailwind 不会生成任何 CSS，
 * 按钮会退化成「无背景 + 白字」＝白底白字，完全看不见。
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
