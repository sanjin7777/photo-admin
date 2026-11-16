/**
 * 请求体校验的唯一入口。
 * 前端：Vant / Element Plus 表单各写一层薄 adapter 转 rules；
 * 后端：中间件用同一 schema 二次校验后，业务层才能取用 payload。
 */
export * from './common';
export * from './auth';
export * from './event';
export * from './finance';
export * from './vote';
export * from './imports';
export * from './model';
export * from './scene';
export * from './invite';
export * from './settings';
export * from './coupon';
export * from './poster';
