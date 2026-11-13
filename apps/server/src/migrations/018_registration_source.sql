-- ============================================================================
-- 018 报名来源（线上 / 线下）
--
-- 背景：报名管理列表需要区分「前台用户自助报名（线上）」与「后台运营手动录入
--   （线下报名 / walk-in / 群内补录）」。此前只能用 idempotency_key IS NULL 间接
--   猜测来源，不可靠（线上幂等键也可能为空）。这里显式落一列 source。
--
-- 变更：registrations 增加 source ENUM('ONLINE','MANUAL') NOT NULL DEFAULT 'ONLINE'。
--   · 存量报名默认 ONLINE（历史均为前台自助报名）；
--   · 后台手动录入接口显式写 MANUAL；前台报名不写该列，走默认 ONLINE；
--   · 带默认值的 ADD COLUMN 为 INSTANT，不锁表、不回填数据。
--
-- 与退款的关系（不变）：退款是否回充积分仍由 payment_status 决定
--   （NOT_REQUIRED=积分支付才回充；UNPAID/PAID=线下支付，审核通过后线下退款）。
--   source 只用于展示与运营口径，不参与资金路由。
--
-- 回滚思路：source 为纯展示列，无资金 / 状态语义，直接删除即可，无需平账：
--   ALTER TABLE registrations DROP COLUMN source;
--   （删除后后台来源徽标回退为不展示；如需留档可先备份该列再删。）
-- ============================================================================

ALTER TABLE registrations
  ADD COLUMN source ENUM('ONLINE','MANUAL') NOT NULL DEFAULT 'ONLINE'
    COMMENT '报名来源：ONLINE=前台自助报名，MANUAL=后台手动录入（线下）' AFTER payment_status;