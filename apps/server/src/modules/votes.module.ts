/** 服装投票域：SVIP 资格服务端重查、一人一票/改票、限流、结果聚合与小样本抑制。 */
import type { Express } from 'express';
import { Router } from 'express';
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import {
  API_BASE_PATH,
  AppError,
  BIZ_CODES,
  VOTE_CAMPAIGN_TRANSITIONS,
  assertTransition,
  voteCampaignCreateSchema,
  voteCampaignPatchSchema,
  voteCastSchema,
  type VoteCampaignCreatePayload,
  type VoteCastPayload,
  type VoteCampaignStatus,
  type ModelProfileDto,
} from '@photo/shared';
import { pool, withTransaction } from '../db/pool';
import { authenticate } from '../middleware/auth';
import { requireCapabilities } from '../middleware/authorize';
import { getIdentity } from '../middleware/context';
import { asyncHandler } from '../middleware/error';
import { validateBody } from '../middleware/validate';
import { auditOf } from '../middleware/audit';
import { voteCampaignDtoOf, voteOptionDtoOf, voteResultDtoOf, modelDtoOf, paginatedOf } from '../domain/dto';
import { voteWindowOpen } from '../domain/policy';
import { voteLimiter } from '../domain/rate-limit';
import { toSqlDateTime } from '../utils/datetime';
import { sendOk } from '../utils/response';

interface CampaignRow extends RowDataPacket {
  id: string; event_id: string | null; model_id: string | null; title: string; open_at: string; close_at: string;
  status: VoteCampaignStatus; max_votes_per_user: number; result_published_at: string | null;
  created_at: string; updated_at: string;
}
const sqlTime = (iso: string): string => toSqlDateTime(new Date(iso));
const sqlIso = (v: unknown): string => new Date(`${String(v).replace(' ', 'T')}Z`).toISOString();
const sqlMs = (v: unknown): number => new Date(`${String(v).replace(' ', 'T')}Z`).getTime();

async function loadCampaign(id: string): Promise<CampaignRow> {
  const [rows] = await pool.execute<CampaignRow[]>('SELECT * FROM vote_campaigns WHERE id = ? LIMIT 1', [id]);
  const row = rows[0];
  if (!row) throw new AppError(BIZ_CODES.RESOURCE_NOT_FOUND);
  return row;
}

async function optionsOf(campaignId: string) {
  const [rows] = await pool.execute<RowDataPacket[]>(
    'SELECT * FROM vote_options WHERE campaign_id = ? ORDER BY sort_no ASC', [campaignId],
  );
  return rows.map(voteOptionDtoOf);
}

/**
 * 点C：投票直接关联的模特资料。仅 SVIP（前台 assertActiveSvip）/运营（后台 admin:vote:write）
 * 能到达这些接口，故身体数据恒可见（includeBody=true）。模特软删除或未关联时返回 null，
 * 前台据此隐藏模特入口，绝不展示开通引导。
 */
async function campaignModelOf(modelId: string | null): Promise<ModelProfileDto | null> {
  if (modelId == null) return null;
  const [rows] = await pool.execute<RowDataPacket[]>(
    'SELECT * FROM model_profiles WHERE id = ? AND deleted_at IS NULL LIMIT 1', [modelId],
  );
  return rows[0] ? modelDtoOf(rows[0], true) : null;
}

/** 资格判定必须发生在提交瞬间，不依赖前端声明或旧的能力快照 */
async function assertActiveSvip(userId: string): Promise<void> {
  const now = toSqlDateTime();
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT id FROM memberships
     WHERE user_id = ? AND level = 'SVIP' AND status = 'ACTIVE' AND start_at <= ? AND expire_at > ? LIMIT 1`,
    [userId, now, now],
  );
  if (!rows[0]) throw new AppError(BIZ_CODES.LEVEL_INSUFFICIENT);
}

export function mountVotes(app: Express): void {
  const pub = Router();
  // 本 router 挂在 /api/v1 前缀下，守卫必须落在具体路由上；
  // 若写成 router.use 会拦截所有 /api/v1/* 请求。

  // 前台投票入口的数据源：只返回「当前用户可见」的活动。
  // 非 SVIP 会在 requireCapabilities / assertActiveSvip 处被拦下，前端据此隐藏入口。
  pub.get('/vote-campaigns', authenticate, requireCapabilities('vote:cast'), asyncHandler(async (_req, res) => {
    const identity = getIdentity();
    if (!identity) throw new AppError(BIZ_CODES.UNAUTHORIZED);
    await assertActiveSvip(identity.userId);
    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT c.id, c.event_id, c.title, c.status, c.open_at, c.close_at,
              e.title AS event_title,
              (SELECT COUNT(*) FROM vote_options o WHERE o.campaign_id = c.id) AS option_count,
              (SELECT o.image_url FROM vote_options o
                 WHERE o.campaign_id = c.id AND o.image_url IS NOT NULL
                 ORDER BY o.sort_no ASC LIMIT 1) AS cover_image,
              (SELECT COUNT(*) FROM votes v WHERE v.campaign_id = c.id AND v.user_id = ?) AS my_voted
         FROM vote_campaigns c
         LEFT JOIN events e ON e.id = c.event_id
        WHERE c.status <> 'DRAFT'
        ORDER BY c.created_at DESC`,
      [identity.userId],
    );
    sendOk(res, rows.map((r) => ({
      id: String(r.id),
      eventId: r.event_id == null ? null : String(r.event_id),
      eventTitle: r.event_title ?? null,
      title: r.title,
      status: r.status,
      openAt: new Date(`${String(r.open_at).replace(' ', 'T')}Z`).toISOString(),
      closeAt: new Date(`${String(r.close_at).replace(' ', 'T')}Z`).toISOString(),
      optionCount: Number(r.option_count ?? 0),
      coverImageUrl: r.cover_image ?? null,
      myVoted: Number(r.my_voted ?? 0) > 0,
    })));
  }));

  pub.get('/vote-campaigns/:id', authenticate, requireCapabilities('vote:cast'), asyncHandler(async (req, res) => {
    const identity = getIdentity();
    if (!identity) throw new AppError(BIZ_CODES.UNAUTHORIZED);
    await assertActiveSvip(identity.userId);
    const campaign = await loadCampaign(req.params.id);
    if (campaign.status === 'DRAFT') throw new AppError(BIZ_CODES.VOTE_CLOSED);
    const [mine] = await pool.execute<RowDataPacket[]>(
      'SELECT option_id FROM votes WHERE campaign_id = ? AND user_id = ?', [campaign.id, identity.userId],
    );
    sendOk(res, voteCampaignDtoOf(campaign, await optionsOf(String(campaign.id)), mine[0] ? String(mine[0].option_id) : null, await campaignModelOf(campaign.model_id)));
  }));

  pub.post('/votes', authenticate, requireCapabilities('vote:cast'), validateBody(voteCastSchema), asyncHandler(async (req, res) => {
    const identity = getIdentity();
    if (!identity) throw new AppError(BIZ_CODES.UNAUTHORIZED);
    const payload = req.body as VoteCastPayload;
    // 双维度限流：用户 + IP；开发期内存令牌桶，上线换 Redis
    if (!voteLimiter.take(`u:${identity.userId}`) || !voteLimiter.take(`ip:${req.ip}`)) {
      throw new AppError(BIZ_CODES.RATE_LIMITED);
    }
    await assertActiveSvip(identity.userId);
    const campaign = await loadCampaign(payload.campaignId);
    if (campaign.status !== 'OPEN' || !voteWindowOpen(campaign.open_at, campaign.close_at)) {
      throw new AppError(BIZ_CODES.VOTE_CLOSED);
    }
    const [options] = await pool.execute<RowDataPacket[]>(
      'SELECT id FROM vote_options WHERE id = ? AND campaign_id = ?', [payload.optionId, campaign.id],
    );
    if (!options[0]) throw new AppError(BIZ_CODES.INVALID_PARAM, '服装方案不属于该活动');
    const now = toSqlDateTime();
    await pool.execute(
      `INSERT INTO votes (campaign_id, user_id, option_id, vote_version, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?)
       ON DUPLICATE KEY UPDATE option_id = VALUES(option_id), vote_version = vote_version + 1, updated_at = VALUES(updated_at)`,
      [campaign.id, identity.userId, payload.optionId, now, now],
    );
    sendOk(res, voteCampaignDtoOf(campaign, await optionsOf(String(campaign.id)), payload.optionId, await campaignModelOf(campaign.model_id)));
  }));

  // 结果读取仅 SVIP（与投票权一致），且只在 PUBLISHED 后可见
  const resultRouter = Router();
  resultRouter.use(authenticate);
  resultRouter.get('/:id/result', requireCapabilities('vote:result:read'), asyncHandler(async (req, res) => {
    const identity = getIdentity();
    if (!identity) throw new AppError(BIZ_CODES.UNAUTHORIZED);
    await assertActiveSvip(identity.userId);
    const campaign = await loadCampaign(req.params.id);
    // 客户端实时票数：开放 / 截止 / 已发布都返回聚合数，草稿尚未开放不返回（与 Mock 对齐）
    if (campaign.status === 'DRAFT') throw new AppError(BIZ_CODES.VOTE_CLOSED, '投票尚未开放');
    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT o.id AS option_id, o.name, COUNT(v.id) AS cnt
       FROM vote_options o LEFT JOIN votes v ON v.option_id = o.id AND v.campaign_id = o.campaign_id
       WHERE o.campaign_id = ? GROUP BY o.id, o.name, o.sort_no ORDER BY o.sort_no ASC`,
      [campaign.id],
    );
    // 票数完整可见（含各方案明细），不做小样本抑制；投票人身份始终不下发，仅后台实时面板可见
    sendOk(res, voteResultDtoOf(
      String(campaign.id),
      rows.map((r) => ({ optionId: String(r.option_id), name: r.name, count: Number(r.cnt) })),
      false,
    ));
  }));

  const admin = Router();
  admin.use(authenticate, requireCapabilities('admin:vote:write'));
  admin.get('/', asyncHandler(async (_req, res) => {
    const [rows] = await pool.execute<CampaignRow[]>('SELECT * FROM vote_campaigns ORDER BY created_at DESC');
    // 一次聚合出每个活动的总票数与最近投票时间，避免逐个活动查一次
    const [statRows] = await pool.execute<RowDataPacket[]>(
      'SELECT campaign_id, COUNT(*) AS cnt, MAX(updated_at) AS last_at FROM votes GROUP BY campaign_id',
    );
    const stats = new Map(statRows.map((r) => [String(r.campaign_id), r]));
    const list = await Promise.all(rows.map(async (r) => {
      const stat = stats.get(String(r.id));
      return {
        ...voteCampaignDtoOf(r, await optionsOf(String(r.id)), null, await campaignModelOf(r.model_id)),
        totalVotes: Number(stat?.cnt ?? 0),
        lastVotedAt: stat?.last_at ? sqlIso(stat.last_at) : null,
      };
    }));
    sendOk(res, paginatedOf(list, list.length, 1, Math.max(1, list.length)));
  }));
  admin.post('/', validateBody(voteCampaignCreateSchema), asyncHandler(async (req, res) => {
    const p = req.body as VoteCampaignCreatePayload;
    const now = toSqlDateTime();
    const id = await withTransaction(async (conn) => {
      const [result] = await conn.execute<ResultSetHeader>(
        `INSERT INTO vote_campaigns (event_id, model_id, title, open_at, close_at, status, max_votes_per_user, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?)`,
        [p.eventId ?? null, p.modelId ?? null, p.title, sqlTime(p.openAt), sqlTime(p.closeAt), p.maxVotesPerUser, now, now],
      );
      for (const option of p.options) {
        await conn.execute(
          'INSERT INTO vote_options (campaign_id, name, image_url, sort_no, created_at) VALUES (?, ?, ?, ?, ?)',
          [String(result.insertId), option.name, option.imageUrl ?? null, option.sort, now],
        );
      }
      return String(result.insertId);
    });
    await auditOf(res)?.({ action: 'VOTE_CONFIG_CHANGE', targetType: 'vote_campaign', targetId: id, after: { status: 'DRAFT' } });
    sendOk(res, { id }, 201);
  }));
  admin.post('/:id/open', asyncHandler(async (req, res) => {
    const row = await loadCampaign(req.params.id);
    assertTransition(VOTE_CAMPAIGN_TRANSITIONS, row.status, 'OPEN');
    const [updated] = await pool.execute<ResultSetHeader>(
      "UPDATE vote_campaigns SET status = 'OPEN', updated_at = ? WHERE id = ? AND status = 'DRAFT'",
      [toSqlDateTime(), row.id],
    );
    if (updated.affectedRows !== 1) throw new AppError(BIZ_CODES.ILLEGAL_TRANSITION);
    await auditOf(res)?.({ action: 'VOTE_CONFIG_CHANGE', targetType: 'vote_campaign', targetId: String(row.id), before: { status: row.status }, after: { status: 'OPEN' } });
    sendOk(res, { id: String(row.id), status: 'OPEN' });
  }));
  admin.post('/:id/publish', asyncHandler(async (req, res) => {
    const row = await loadCampaign(req.params.id);
    // 先关闭再发布，严格按迁移表推进
    if (row.status === 'OPEN') {
      assertTransition(VOTE_CAMPAIGN_TRANSITIONS, 'OPEN', 'CLOSED');
      await pool.execute("UPDATE vote_campaigns SET status = 'CLOSED' WHERE id = ?", [row.id]);
    }
    assertTransition(VOTE_CAMPAIGN_TRANSITIONS, row.status === 'OPEN' ? 'CLOSED' : row.status, 'PUBLISHED');
    await pool.execute("UPDATE vote_campaigns SET status = 'PUBLISHED', result_published_at = ? WHERE id = ?", [toSqlDateTime(), row.id]);
    await auditOf(res)?.({ action: 'VOTE_RESULT_PUBLISH', targetType: 'vote_campaign', targetId: String(row.id) });
    sendOk(res, { id: String(row.id), status: 'PUBLISHED' });
  }));

  /**
   * 后台实时投票面板：票数不做小样本抑制，并返回投票人明细。
   * 前台始终只输出聚合结果，明细仅限运营在后台查看。
   */
  admin.get('/:id/live', asyncHandler(async (req, res) => {
    const campaign = await loadCampaign(req.params.id);
    const [countRows] = await pool.execute<RowDataPacket[]>(
      `SELECT o.id AS option_id, o.name, o.image_url, o.sort_no,
              (SELECT COUNT(*) FROM votes v WHERE v.option_id = o.id AND v.campaign_id = o.campaign_id) AS cnt
         FROM vote_options o
        WHERE o.campaign_id = ?
        ORDER BY o.sort_no ASC, o.id ASC`,
      [campaign.id],
    );
    const [voterRows] = await pool.execute<RowDataPacket[]>(
      `SELECT v.user_id, u.wechat_id, u.nickname, v.option_id, o.name AS option_name, v.updated_at
         FROM votes v
         JOIN users u ON u.id = v.user_id
         JOIN vote_options o ON o.id = v.option_id
        WHERE v.campaign_id = ?
        ORDER BY v.updated_at DESC, v.user_id ASC
        LIMIT 500`,
      [campaign.id],
    );
    const totalVotes = countRows.reduce((sum, r) => sum + Number(r.cnt), 0);
    sendOk(res, {
      campaign: voteCampaignDtoOf(campaign, await optionsOf(String(campaign.id)), null, await campaignModelOf(campaign.model_id)),
      totalVotes,
      lastVotedAt: voterRows[0] ? sqlIso(voterRows[0].updated_at) : null,
      options: countRows.map((r) => ({
        optionId: String(r.option_id),
        name: r.name,
        imageUrl: r.image_url ?? null,
        voteCount: Number(r.cnt),
        ratio: totalVotes ? Number((Number(r.cnt) / totalVotes).toFixed(4)) : null,
      })),
      voters: voterRows.map((r) => ({
        userId: String(r.user_id),
        wechatId: r.wechat_id ?? null,
        nickname: r.nickname ?? null,
        optionId: String(r.option_id),
        optionName: r.option_name,
        votedAt: sqlIso(r.updated_at),
      })),
    });
  }));

  /**
   * 编辑投票：草稿/进行中/已截止都可以改（已发布结果冻结）。
   * 方案按 id 增改，未提交的视为删除；已有票的方案禁止删除，只能改名/换图。
   */
  admin.patch('/:id', asyncHandler(async (req, res) => {
    const row = await loadCampaign(req.params.id);
    if (row.status === 'PUBLISHED') {
      throw new AppError(BIZ_CODES.ILLEGAL_TRANSITION, '结果已发布，投票不可再修改');
    }
    const checked = voteCampaignPatchSchema.safeParse(req.body);
    if (!checked.success) {
      throw new AppError(BIZ_CODES.SCHEMA_VALIDATION_FAILED, checked.error.issues[0]?.message);
    }
    const p = checked.data;

    const openAt = p.openAt ? sqlTime(p.openAt) : row.open_at;
    const closeAt = p.closeAt ? sqlTime(p.closeAt) : row.close_at;
    if (sqlMs(openAt) >= sqlMs(closeAt)) {
      throw new AppError(BIZ_CODES.INVALID_PARAM, '结束时间必须晚于开始时间');
    }

    const [optionRows] = await pool.execute<RowDataPacket[]>(
      'SELECT * FROM vote_options WHERE campaign_id = ? ORDER BY sort_no ASC, id ASC', [row.id],
    );
    const existing = new Map(optionRows.map((o) => [String(o.id), o]));

    let removedIds: string[] = [];
    if (p.options) {
      const kept: string[] = [];
      for (const o of p.options) {
        if (!o.id) continue;
        if (!existing.has(o.id)) throw new AppError(BIZ_CODES.INVALID_PARAM, '方案不属于该投票');
        if (kept.includes(o.id)) throw new AppError(BIZ_CODES.INVALID_PARAM, '方案重复提交');
        kept.push(o.id);
      }
      removedIds = [...existing.keys()].filter((id) => !kept.includes(id));
      if (removedIds.length) {
        const [voteRows] = await pool.execute<RowDataPacket[]>(
          'SELECT option_id, COUNT(*) AS cnt FROM votes WHERE campaign_id = ? GROUP BY option_id', [row.id],
        );
        const counts = new Map(voteRows.map((r) => [String(r.option_id), Number(r.cnt)]));
        for (const id of removedIds) {
          const cnt = counts.get(id) ?? 0;
          if (cnt > 0) {
            throw new AppError(
              BIZ_CODES.ILLEGAL_TRANSITION,
              `方案「${String(existing.get(id)!.name)}」已有 ${cnt} 票，不能删除，只能改名或换图`,
            );
          }
        }
      }
    }

    const now = toSqlDateTime();
    await withTransaction(async (conn) => {
      const sets: string[] = [];
      const values: Array<string | number | null> = [];
      if (p.title !== undefined) { sets.push('title = ?'); values.push(p.title); }
      if (p.modelId !== undefined) { sets.push('model_id = ?'); values.push(p.modelId ?? null); }
      if (p.openAt !== undefined) { sets.push('open_at = ?'); values.push(sqlTime(p.openAt)); }
      if (p.closeAt !== undefined) { sets.push('close_at = ?'); values.push(sqlTime(p.closeAt)); }
      if (p.maxVotesPerUser !== undefined) { sets.push('max_votes_per_user = ?'); values.push(p.maxVotesPerUser); }
      sets.push('updated_at = ?');
      values.push(now);
      await conn.execute(`UPDATE vote_campaigns SET ${sets.join(', ')} WHERE id = ?`, [...values, row.id]);

      if (p.options) {
        for (const [i, o] of p.options.entries()) {
          const sort = o.sort ?? i;
          if (o.id) {
            await conn.execute(
              'UPDATE vote_options SET name = ?, image_url = ?, sort_no = ? WHERE id = ? AND campaign_id = ?',
              [o.name, o.imageUrl ?? null, sort, o.id, row.id],
            );
          } else {
            await conn.execute(
              'INSERT INTO vote_options (campaign_id, name, image_url, sort_no, created_at) VALUES (?, ?, ?, ?, ?)',
              [row.id, o.name, o.imageUrl ?? null, sort, now],
            );
          }
        }
        if (removedIds.length) {
          await conn.execute(
            `DELETE FROM vote_options WHERE campaign_id = ? AND id IN (${removedIds.map(() => '?').join(',')})`,
            [row.id, ...removedIds],
          );
        }
      }
    });

    await auditOf(res)?.({
      action: 'VOTE_CONFIG_CHANGE', targetType: 'vote_campaign', targetId: String(row.id),
      before: { status: row.status }, after: { title: p.title ?? row.title, options: p.options?.length ?? existing.size },
    });
    const updated = await loadCampaign(String(row.id));
    sendOk(res, voteCampaignDtoOf(updated, await optionsOf(String(row.id)), null, await campaignModelOf(updated.model_id)));
  }));

  app.use(`${API_BASE_PATH}`, pub);
  app.use(`${API_BASE_PATH}/vote-campaigns`, resultRouter);
  app.use(`${API_BASE_PATH}/admin/vote-campaigns`, admin);
}
