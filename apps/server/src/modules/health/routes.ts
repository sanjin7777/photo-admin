import { Router } from 'express';
import { ping } from '../../db/pool';
import { asyncHandler } from '../../middleware/error';
import { sendOk } from '../../utils/response';

const router = Router();

router.get(
  '/',
  asyncHandler(async (_req, res) => {
    const dbUp = await ping();
    sendOk(res, {
      status: 'ok',
      db: dbUp ? 'up' : 'down',
      hint: dbUp ? undefined : '请先执行 docker compose up -d mysql，再运行 npm run migrate',
      now: new Date().toISOString(),
    });
  }),
);

export default router;
