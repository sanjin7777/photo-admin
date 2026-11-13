/**
 * 前端专用子路径 `@photo/shared/api`。
 * 后端请从 `@photo/shared`（根）或 `@photo/shared/schemas` 引入，不要引入本子路径，
 * 以免把 axios 与浏览器侧假设带进 Node 进程。
 */
export * from './endpoints';
export * from './http';
export * from './client';
