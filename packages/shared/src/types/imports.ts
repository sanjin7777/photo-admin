/**
 * 会员批量导入（Excel）相关类型。
 *
 * 设计要点：
 * - **两阶段**：preview 只解析与校验、不落库；commit 携带 preview 通过的行再校验一次后落库。
 *   服务端不信任前端回传的数据，commit 阶段会重新跑一遍全部校验（防篡改/防过期）。
 * - 行级状态：OK 可直接导入 / WARN 可导入但有覆盖或提示 / ERROR 不可导入。
 */
import type { Id } from './common';
import type { MemberLevel } from '../roles';

export type ImportRowStatus = 'OK' | 'WARN' | 'ERROR';

/** 单行预览结果：normalized 是服务端归一化后的值，commit 时原样回传 */
export interface MemberImportRowDto {
  /** Excel 中的行号（含表头，便于用户对照） */
  row: number;
  wechatId: string;
  nickname: string;
  /** 目标会员等级；NONE 表示普通用户（不建会员记录） */
  level: MemberLevel;
  /** 会员到期时间（ISO）；level=NONE 时为 null */
  expireAt: string | null;
  /** 余额（分）；null 表示不动余额 */
  balanceCent: number | null;
  /** 赠送积分（分）；null 表示不赠送，单独记一条 BONUS 流水 */
  bonusCent: number | null;
  remark: string | null;
  status: ImportRowStatus;
  messages: string[];
  /** 库中已存在该微信号 */
  exists: boolean;
  /** 库中已存在的用户 ID（exists=true 时给出，用于「只补会员/余额」） */
  existingUserId: Id | null;
}

export interface MemberImportPreviewDto {
  /** 识别到的表头（按列顺序） */
  columns: string[];
  /** 未识别但存在的列，用于提示用户改表头 */
  unknownColumns: string[];
  total: number;
  ok: number;
  warn: number;
  error: number;
  rows: MemberImportRowDto[];
  /** 整份文件级别的错误（如表头缺失、文件为空），非空时 rows 为空 */
  fatal: string[];
}

export interface MemberImportCommitPayload {
  rows: MemberImportRowDto[];
  /** true：任意一行失败则整批回滚；false：逐行提交，失败汇总返回（默认） */
  strict: boolean;
  /** 已存在的微信号：true=更新会员与余额，false=跳过 */
  overwrite: boolean;
}

export interface MemberImportErrorDto {
  row: number;
  wechatId: string;
  /** 该行的昵称（表里就有），失败明细里让运营直接认出是谁 */
  nickname: string | null;
  reason: string;
}

/** 新建账号的一次性口头凭证；首次登录后必须修改密码 */
export interface MemberImportCredentialDto {
  wechatId: string;
  /** 新建账号的昵称（导入表里就有），回显时给运营认人的名字 */
  nickname: string | null;
  temporaryPassword: string;
}

export interface MemberImportResultDto {
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  errors: MemberImportErrorDto[];
  /**
   * 本次新建账号的临时口令（仅本次返回，供运营逐个转告会员）。
   * 口令每批随机生成、账号标记 mustChangePassword，首次登录必须改密后才可继续使用。
   */
  credentials: MemberImportCredentialDto[];
}

/** 图片上传结果；url 为同源相对路径，前端直接放进 img src */
export interface UploadResultDto {
  url: string;
  /** 原始文件名，便于回显 */
  name: string;
  size: number;
  mimeType: string;
}
