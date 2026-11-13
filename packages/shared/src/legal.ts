/**
 * 协议版本与同意状态契约。
 *
 * 用户协议/隐私政策正文变更时必须递增 LEGAL_VERSION；同意记录按版本留存，
 * 老版本同意不会被视为对新版本同意。
 */
export const LEGAL_VERSION = '2026-11-11';

export const LEGAL_TYPES = ['TERMS', 'PRIVACY'] as const;
export type LegalType = (typeof LEGAL_TYPES)[number];

export interface ConsentStatusDto {
  termsVersion: string;
  privacyVersion: string;
  agreedTerms: boolean;
  agreedPrivacy: boolean;
  /** 任一协议未同意即为 true，前端需弹窗拦截 */
  needConsent: boolean;
}
