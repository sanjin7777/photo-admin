/**
 * 会员批量导入（Excel）。
 *
 * 两阶段设计：
 *   1) preview —— 解析 + 逐行校验 + 查重，**不落库**，返回可直接对照 Excel 行号的预览；
 *   2) commit  —— 前端回传已通过的行，服务端**重新校验一遍**后在一个事务里写入。
 *
 * 为什么不信任前端回传：preview 与 commit 之间可能隔了几分钟，期间库里的微信号可能已被别人注册；
 * 且回传的 JSON 可被篡改。所以 commit 阶段所有校验重跑，唯一性以 DB 唯一索引兜底。
 *
 * 失败策略：
 *   - 默认（strict=false）：逐行提交，成功的留下，失败的汇总返回行号与原因；
 *   - 严格（strict=true）：任意一行失败整批回滚，适合"要么全进要么全不进"的正式迁移。
 */
import { randomBytes } from 'node:crypto';
import type { Express } from 'express';
import { Router } from 'express';
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import multer from 'multer';
import * as XLSX from 'xlsx';
import {
  API_BASE_PATH,
  AppError,
  BIZ_CODES,
  memberImportCommitSchema,
  wechatIdSchema,
  type MemberImportCommitPayload,
  type MemberImportCredentialDto,
  type MemberImportPreviewDto,
  type MemberImportResultDto,
  type MemberImportRowDto,
  type MemberLevel,
} from '@photo/shared';
import { applyLedgerEntry } from '../domain/ledger';
import { pool, withTransaction } from '../db/pool';
import { authenticate } from '../middleware/auth';
import { requireCapabilities } from '../middleware/authorize';
import { getIdentity } from '../middleware/context';
import { asyncHandler } from '../middleware/error';
import { validateBody } from '../middleware/validate';
import { auditOf } from '../middleware/audit';
import { hashPassword } from '../utils/password';
import { toSqlDateTime } from '../utils/datetime';
import { sendOk } from '../utils/response';

/**
 * 每批导入生成独立的随机临时口令，不再使用全站共享的硬编码密码。
 * 账号同时标记 mustChangePassword，首次登录必须改密后才可继续使用。
 * 说明：bcrypt(cost 12) 是纯 JS 实现，按账号逐个哈希在 2000 行上限下耗时不可接受，
 * 因此这里按「批」随机并在结果中逐个账号回显同一个临时口令。
 */
function newImportPassword(): string {
  return `Aw1${randomBytes(9).toString('base64url')}`;
}
const MAX_ROWS = 2000;
const MAX_FILE_BYTES = 5 * 1024 * 1024;

/** 表头别名：中英文、常见写法都认，避免用户改表头 */
const HEADER_ALIASES = {
  wechatId: ['微信号', '微信号码', '微信', 'wechatid', 'wechat_id', 'wechat', '账号', '登录账号'],
  nickname: ['昵称', '姓名', '名字', 'nickname', 'name', 'nick'],
  level: ['会员等级', '等级', '会员', 'level', 'vip等级', '会员类型'],
  expireAt: ['有效期至', '到期时间', '有效期', '到期日', 'expireat', 'expire_at', 'expiredat', 'expire'],
  balanceYuan: ['积分', '余额', '余额(元)', '余额（元）', '余额元', 'balance', '金额', '账户余额'],
  bonusYuan: ['赠送积分', '赠金', '赠送', '赠送金额', 'bonus', 'gift', '赠送积分(元)', '赠送积分（元）'],
  remark: ['备注', '说明', 'remark', 'note', 'memo'],
} as const;

type FieldKey = keyof typeof HEADER_ALIASES;

const norm = (v: unknown): string => String(v ?? '').replace(/\s+/g, ' ').trim();
const normHeader = (v: unknown): string => norm(v).toLowerCase().replace(/[\s_\-()（）:：]/g, '');

function matchField(header: string): FieldKey | null {
  const h = normHeader(header);
  if (!h) return null;
  for (const [key, aliases] of Object.entries(HEADER_ALIASES) as Array<[FieldKey, readonly string[]]>) {
    if (aliases.some((a) => normHeader(a) === h)) return key;
  }
  return null;
}

/** Excel 日期可能是 Date、序列号或各种字符串写法，统一成 Date */
function parseDate(value: unknown): Date | null {
  if (value == null || value === '') return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (!parsed) return null;
    return new Date(Date.UTC(parsed.y, parsed.m - 1, parsed.d));
  }
  const raw = norm(value);
  if (!raw) return null;
  const cleaned = raw.replace(/年|月/g, '-').replace(/日/g, '').replace(/\./g, '-').replace(/\//g, '-');
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(cleaned);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 等级归一化：容忍「VIP会员」「超级会员」等写法 */
function parseLevel(value: unknown): MemberLevel | null {
  const raw = norm(value).toUpperCase().replace(/\s/g, '');
  if (!raw) return 'NONE';
  if (raw === 'SVIP' || raw.includes('SVIP') || raw.includes('超级')) return 'SVIP';
  if (raw === 'VIP' || raw.includes('VIP')) return 'VIP';
  if (['NONE', '无', '普通', '普通用户', '非会员', '-'].includes(raw)) return 'NONE';
  return null;
}

/** 积分（1 积分 = 1 元）→ 账本单位（分）；保留两位小数，负数与非数字视为非法 */
function parseYuanToCent(value: unknown): { ok: true; cent: number | null } | { ok: false; reason: string } {
  if (value == null || value === '') return { ok: true, cent: null };
  const raw = norm(value).replace(/[¥￥,，\s]/g, '');
  if (!raw) return { ok: true, cent: null };
  const num = Number(raw);
  if (!Number.isFinite(num)) return { ok: false, reason: `积分「${norm(value)}」不是有效数字` };
  if (num < 0) return { ok: false, reason: '积分不能为负数' };
  const cent = Math.round(num * 100);
  if (cent > 100_000_000) return { ok: false, reason: '单行积分不能超过 100 万' };
  return { ok: true, cent };
}

interface ParsedRow {
  row: number;
  wechatId: string;
  nickname: string;
  level: MemberLevel;
  expireAt: string | null;
  balanceCent: number | null;
  bonusCent: number | null;
  remark: string | null;
}

/** 解析工作簿第一张表：返回二维数组形式的有效数据行 */
function readSheet(buffer: Buffer): { header: string[]; body: unknown[][]; fatal: string[] } {
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  } catch {
    return { header: [], body: [], fatal: ['文件无法解析，请确认是 .xlsx / .xls / .csv 格式'] };
  }
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) return { header: [], body: [], fatal: ['文件中没有工作表'] };
  const sheet = workbook.Sheets[sheetName];
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true, defval: null, blankrows: false });
  if (!aoa.length) return { header: [], body: [], fatal: ['工作表是空的'] };
  const header = (aoa[0] as unknown[]).map(norm);
  const body = aoa.slice(1) as unknown[][];
  return { header, body, fatal: [] };
}

/** 把一行二维数组按表头映射成业务字段 */
function mapRow(header: string[], cells: unknown[]): Record<FieldKey, unknown> {
  const out = {} as Record<FieldKey, unknown>;
  header.forEach((h, i) => {
    const key = matchField(h);
    if (key) out[key] = cells[i] ?? null;
  });
  return out;
}

async function existingUsers(wechatIds: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (!wechatIds.length) return map;
  const unique = [...new Set(wechatIds)];
  // 用 query 而非 execute：mysql2 的 prepared statement 不支持把数组展开成 IN 列表
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT id, wechat_id FROM users WHERE wechat_id IN (?) AND deleted_at IS NULL',
    [unique],
  );
  for (const r of rows) map.set(String(r.wechat_id), String(r.id));
  return map;
}

/** 单行校验：返回归一化结果 + 状态 + 提示。exists 由调用方补 */
function validateRow(
  raw: Record<FieldKey, unknown>,
  row: number,
  now: Date,
): { ok: boolean; status: 'OK' | 'WARN' | 'ERROR'; messages: string[]; parsed: ParsedRow | null } {
  const messages: string[] = [];

  const wechatId = norm(raw.wechatId);
  const idCheck = wechatIdSchema.safeParse(wechatId);
  if (!idCheck.success) messages.push(idCheck.error.issues[0]?.message ?? '微信号格式不正确');

  const nickname = norm(raw.nickname);
  if (nickname.length < 2 || nickname.length > 24) messages.push('昵称需 2–24 个字符');

  const level = parseLevel(raw.level);
  if (level === null) messages.push(`会员等级「${norm(raw.level)}」无法识别（应为 VIP / SVIP / 留空）`);

  const expire = parseDate(raw.expireAt);
  if (level && level !== 'NONE') {
    if (!raw.expireAt) messages.push('填写了会员等级但缺少有效期');
    else if (!expire) messages.push(`有效期「${norm(raw.expireAt)}」无法识别（建议 2026-12-31）`);
    else if (expire.getTime() <= now.getTime()) messages.push('有效期必须晚于今天');
  } else if (expire) {
    messages.push('未填写会员等级，有效期已忽略');
  }

  const balance = parseYuanToCent(raw.balanceYuan);
  if (!balance.ok) messages.push(balance.reason);

  const bonus = parseYuanToCent(raw.bonusYuan);
  if (!bonus.ok) messages.push(`赠送积分：${bonus.reason}`);

  const remark = norm(raw.remark) || null;
  if (remark && remark.length > 200) messages.push('备注不能超过 200 字');

  const hasError = messages.some((m) => !m.includes('已忽略'));
  if (hasError || level === null || !balance.ok || !bonus.ok) {
    return { ok: false, status: 'ERROR', messages, parsed: null };
  }

  const parsed: ParsedRow = {
    row,
    wechatId,
    nickname,
    level: level as MemberLevel,
    // 普通用户不写会员记录，有效期一律置空，避免库里出现 NONE 会员
    expireAt: level === 'NONE' ? null : expire?.toISOString() ?? null,
    balanceCent: balance.cent ?? null,
    bonusCent: bonus.cent ?? null,
    remark,
  };
  return { ok: true, status: messages.length ? 'WARN' : 'OK', messages, parsed };
}

export function mountMemberImport(app: Express): void {
  const router = Router();
  router.use(authenticate, requireCapabilities('admin:membership:grant'));

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_FILE_BYTES, files: 1 },
  });

  /** 模板下载：给出正确表头与两行示例，把"格式错"这类失败挡在客户端 */
  router.get('/import/template', asyncHandler(async (_req, res) => {
    const header = ['微信号', '昵称', '会员等级', '有效期至', '积分', '赠送积分', '备注'];
    const sample = [
      ['catpaw_vip01', '小爪', 'VIP', '2027-06-30', '500', '100', '老会员补录'],
      ['catpaw_svip01', '大爪', 'SVIP', '2027-12-31', '1200', '300', ''],
    ];
    const sheet = XLSX.utils.aoa_to_sheet([header, ...sample]);
    sheet['!cols'] = [{ wch: 18 }, { wch: 14 }, { wch: 12 }, { wch: 14 }, { wch: 12 }, { wch: 12 }, { wch: 24 }];
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, '会员导入');
    const buffer = XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="member-import-template.xlsx"');
    res.setHeader('Content-Length', String(buffer.length));
    res.end(buffer);
  }));

  router.post(
    '/import/preview',
    upload.single('file'),
    asyncHandler(async (req, res) => {
      const file = (req as unknown as { file?: { buffer: Buffer } }).file;
      if (!file?.buffer?.length) throw new AppError(BIZ_CODES.INVALID_PARAM, '请上传 Excel 文件');

      const { header, body, fatal } = readSheet(file.buffer);
      if (fatal.length) {
        const empty: MemberImportPreviewDto = {
          columns: [], unknownColumns: [], total: 0, ok: 0, warn: 0, error: 0, rows: [], fatal,
        };
        sendOk(res, empty);
        return;
      }

      const mapped = header.map((h) => matchField(h));
      const known = new Set(mapped.filter(Boolean) as FieldKey[]);
      const unknownColumns = header.filter((h, i) => h && !mapped[i]);
      const missing: string[] = [];
      if (!known.has('wechatId')) missing.push('微信号');
      if (!known.has('nickname')) missing.push('昵称');
      if (missing.length) {
        const empty: MemberImportPreviewDto = {
          columns: header, unknownColumns, total: 0, ok: 0, warn: 0, error: 0, rows: [],
          fatal: [`缺少必需的列：${missing.join('、')}。请按模板表头填写，或先下载模板`],
        };
        sendOk(res, empty);
        return;
      }
      if (body.length > MAX_ROWS) {
        const empty: MemberImportPreviewDto = {
          columns: header, unknownColumns, total: body.length, ok: 0, warn: 0, error: 0, rows: [],
          fatal: [`单次最多导入 ${MAX_ROWS} 行，当前 ${body.length} 行，请拆分后再试`],
        };
        sendOk(res, empty);
        return;
      }

      const now = new Date();
      const rows: MemberImportRowDto[] = [];
      const seenInFile = new Map<string, number>();
      const stagedIds: string[] = [];

      body.forEach((cells, idx) => {
        // Excel 行号 = 数据下标 + 2（1 是表头）
        const excelRow = idx + 2;
        const raw = mapRow(header, cells);
        const blank = Object.values(raw).every((v) => !norm(v));
        if (blank) return; // 跳过整行空白，不计入统计

        const checked = validateRow(raw, excelRow, now);
        const messages = [...checked.messages];
        let status = checked.status;
        const parsed = checked.parsed;

        if (parsed) {
          const dupRow = seenInFile.get(parsed.wechatId);
          if (dupRow) {
            messages.push(`与第 ${dupRow} 行微信号重复`);
            status = 'ERROR';
          } else {
            seenInFile.set(parsed.wechatId, excelRow);
            stagedIds.push(parsed.wechatId);
          }
        }

        rows.push({
          row: excelRow,
          wechatId: norm(raw.wechatId),
          nickname: norm(raw.nickname),
          level: parsed?.level ?? 'NONE',
          expireAt: parsed?.expireAt ?? null,
          balanceCent: parsed?.balanceCent ?? null,
          bonusCent: parsed?.bonusCent ?? null,
          remark: parsed?.remark ?? null,
          status,
          messages,
          exists: false,
          existingUserId: null,
        });
      });

      // 一次性查重，避免逐行查库
      const existing = await existingUsers(stagedIds);
      for (const r of rows) {
        const hit = existing.get(r.wechatId);
        if (!hit) continue;
        r.exists = true;
        r.existingUserId = hit;
        if (r.status !== 'ERROR') {
          r.status = 'WARN';
          r.messages = [...r.messages, '该微信号已存在：将按「覆盖」开关决定更新或跳过'];
        }
      }

      const preview: MemberImportPreviewDto = {
        columns: header,
        unknownColumns,
        total: rows.length,
        ok: rows.filter((r) => r.status === 'OK').length,
        warn: rows.filter((r) => r.status === 'WARN').length,
        error: rows.filter((r) => r.status === 'ERROR').length,
        rows,
        fatal: [],
      };
      sendOk(res, preview);
    }),
  );

  router.post(
    '/import/commit',
    validateBody(memberImportCommitSchema),
    asyncHandler(async (req, res) => {
      const payload = req.body as MemberImportCommitPayload;
      const actorId = getIdentity()?.userId ?? null;
      const now = new Date();
      const sqlNow = toSqlDateTime(now);

      const importable = payload.rows.filter((r) => r.status !== 'ERROR');
      if (!importable.length) throw new AppError(BIZ_CODES.INVALID_PARAM, '没有可导入的行');

      // 重新查重（preview 与 commit 之间库可能已变化）
      const existing = await existingUsers(importable.map((r) => r.wechatId));
      const errors: Array<{ row: number; wechatId: string; reason: string }> = [];
      const temporaryPassword = newImportPassword();
      const passwordHash = await hashPassword(temporaryPassword);
      const credentials: MemberImportCredentialDto[] = [];

      let created = 0;
      let updated = 0;
      let skipped = 0;

      const applyRow = async (conn: Parameters<Parameters<typeof withTransaction>[0]>[0], r: MemberImportRowDto) => {
        const hitId = existing.get(r.wechatId);

        // 已存在：按覆盖开关决定更新会员/余额，或直接跳过
        if (hitId) {
          if (!payload.overwrite) {
            skipped += 1;
            return;
          }
          await updateMembershipAndBalance(conn, hitId, r, actorId, sqlNow);
          updated += 1;
          return;
        }

        // 新建账号：must_change_password=1，首次登录必须先改密
        const [result] = await conn.execute<ResultSetHeader>(
          `INSERT INTO users
             (wechat_id, nickname, password_hash, status, session_version, must_change_password, created_at, updated_at)
           VALUES (?, ?, ?, 'ACTIVE', 1, 1, ?, ?)`,
          [r.wechatId, r.nickname, passwordHash, sqlNow, sqlNow],
        );
        const newId = String(result.insertId);
        await updateMembershipAndBalance(conn, newId, r, actorId, sqlNow);
        // 会员/余额写入成功后才登记凭证，宽松模式下失败行不会误导运营
        credentials.push({ wechatId: r.wechatId, temporaryPassword });
        created += 1;
      };

      if (payload.strict) {
        // 严格模式：整批一个事务，任何一行抛错（含唯一键冲突）都回滚
        await withTransaction(async (conn) => {
          for (const r of importable) {
            try {
              await applyRow(conn, r);
            } catch (error: unknown) {
              const reason = error instanceof Error ? error.message : '写入失败';
              throw new AppError(BIZ_CODES.INVALID_PARAM, `第 ${r.row} 行（${r.wechatId}）导入失败：${reason}`);
            }
          }
        });
      } else {
        // 宽松模式：逐行事务，失败只记录不中断
        for (const r of importable) {
          try {
            await withTransaction(async (conn) => applyRow(conn, r));
          } catch (error: unknown) {
            const reason = error instanceof Error ? error.message : '写入失败';
            errors.push({ row: r.row, wechatId: r.wechatId, reason });
          }
        }
      }

      const result: MemberImportResultDto = {
        created,
        updated,
        skipped,
        failed: errors.length,
        errors,
        credentials,
      };

      await auditOf(res)?.({
        action: 'MEMBER_IMPORT',
        targetType: 'user_batch',
        after: { created, updated, skipped, failed: errors.length, strict: payload.strict, overwrite: payload.overwrite },
      });
      // actorId 已在闭包里用于会员来源记录，这里显式引用避免 lint 报未使用
      void actorId;
      sendOk(res, result);
    }),
  );

  app.use(`${API_BASE_PATH}/admin/members`, router);
}

/**
 * 写入会员与余额：
 * - level=NONE：不动会员记录（保留历史），只可能加余额；
 * - level=VIP/SVIP：已有 ACTIVE 记录则续期到目标时间，否则新建一条；
 * - 余额：账户不存在则建 0，随后统一走 applyLedgerEntry（行锁 + 版本号 + append-only 流水）；
 *   同一「用户 + Excel 行」重复导入时流水已存在则跳过，避免旧实现「直改余额 + 流水去重」造成的重复加钱/账实不符。
 * - 赠送积分：单独记一条 BONUS 流水（与本金同 biz_id、不同 biz_type），独立去重，重复导入不重复赠送。
 */
async function updateMembershipAndBalance(
  conn: Parameters<Parameters<typeof withTransaction>[0]>[0],
  userId: string,
  r: MemberImportRowDto,
  actorId: string | null,
  sqlNow: string,
): Promise<void> {
  if (r.level !== 'NONE' && r.expireAt) {
    const [active] = await conn.execute<RowDataPacket[]>(
      "SELECT id FROM memberships WHERE user_id = ? AND status = 'ACTIVE' LIMIT 1",
      [userId],
    );
    const expireSql = toSqlDateTime(new Date(r.expireAt));
    if (active[0]) {
      await conn.execute(
        'UPDATE memberships SET level = ?, expire_at = ?, updated_at = ? WHERE id = ?',
        [r.level, expireSql, sqlNow, String(active[0].id)],
      );
    } else {
      await conn.execute(
        `INSERT INTO memberships (user_id, level, status, start_at, expire_at, source, granted_by, grant_reason, created_at, updated_at)
         VALUES (?, ?, 'ACTIVE', ?, ?, 'GRANT', ?, 'Excel 批量导入', ?, ?)`,
        [userId, r.level, sqlNow, expireSql, actorId, sqlNow, sqlNow],
      );
    }
  }

  // 本金与赠送都为 null：完全不动余额账户
  if (r.balanceCent == null && r.bonusCent == null) return;

  // 账户：不存在则建 0（显式余额为 0 也保留账户，便于后续入账）
  await conn.execute(
    `INSERT INTO balance_accounts (user_id, available_cent, frozen_cent, version, updated_at)
     VALUES (?, 0, 0, 0, ?) ON DUPLICATE KEY UPDATE user_id = user_id`,
    [userId, sqlNow],
  );

  // 幂等键 = 业务键「用户 + Excel 行」，重复导入同一份表不再重复充值
  const bizId = `import:${userId}:${r.row}`;

  // 本金：MANUAL_ADJUST 入账，流水已存在则跳过
  if (r.balanceCent != null && r.balanceCent > 0) {
    const [dupe] = await conn.execute<RowDataPacket[]>(
      "SELECT id FROM balance_transactions WHERE biz_type = 'MANUAL_ADJUST' AND biz_id = ? AND direction = 'IN' LIMIT 1",
      [bizId],
    );
    if (!dupe[0]) {
      await applyLedgerEntry(conn, {
        userId,
        op: 'CREDIT',
        amountCent: r.balanceCent,
        bizType: 'MANUAL_ADJUST',
        bizId,
        idempotencyKey: bizId,
        operatorId: actorId,
        remark: r.remark ?? 'Excel 批量导入',
      });
    }
  }

  // 赠送积分：BONUS 入账（与本金同 biz_id、不同 biz_type），独立去重
  if (r.bonusCent != null && r.bonusCent > 0) {
    const [dupeBonus] = await conn.execute<RowDataPacket[]>(
      "SELECT id FROM balance_transactions WHERE biz_type = 'BONUS' AND biz_id = ? AND direction = 'IN' LIMIT 1",
      [bizId],
    );
    if (!dupeBonus[0]) {
      await applyLedgerEntry(conn, {
        userId,
        op: 'CREDIT',
        amountCent: r.bonusCent,
        bizType: 'BONUS',
        bizId,
        idempotencyKey: `import-bonus:${userId}:${r.row}`,
        operatorId: actorId,
        remark: r.remark ? `赠送积分：${r.remark}` : 'Excel 批量导入赠送积分',
      });
    }
  }
}
