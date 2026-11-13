/**
 * @photo/shared 根入口。
 *
 * 约定：本入口只导出与运行时无关的「契约」（常量、类型、枚举、Schema、错误码）。
 * axios 相关的 API SDK 仅通过子路径 `@photo/shared/api` 引入，供前端使用；
 * Node 后端只从这里引入 DTO / Schema / 状态机，避免把浏览器侧依赖带上服务端。
 */
export * from './constants';
export * from './labels';
export * from './points';
export * from './legal';
export * from './roles';
export * from './capabilities';
export * from './enums';
export * from './errors';
export * from './types';
export * from './schemas';
