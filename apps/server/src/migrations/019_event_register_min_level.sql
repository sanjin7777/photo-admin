-- ============================================================================
-- 019 人工分批报名门槛（点2）
--
-- 背景（2026-11-12 用户决策）：SVIP 优先报名，报完再放 VIP，最后放普通用户
--   （或一起放）。这是**运营手动控制**，不是按时间自动分档。因此只需在场次上
--   落一列「此刻允许报名的最低会员等级」，运营在后台从 SVIP→VIP→NONE 逐步下调。
--
-- 与 visibility 的区别（两者正交，互不替代）：
--   · visibility      决定「谁能看见这场活动」（列表/详情可见性）；
--   · register_min_level 决定「看见的人里，此刻谁能报名」（报名资格门槛）。
--   例：visibility=PUBLIC 让所有人都能看到，但 register_min_level=SVIP 时
--   只有 SVIP 能报名，VIP/NONE 看得到却报不了，界面提示「尚未开放到你的等级」。
--
-- 变更：events 增加 register_min_level ENUM('NONE','VIP','SVIP') NOT NULL DEFAULT 'NONE'。
--   · 存量场次默认 NONE（所有人可报），与改造前行为完全一致，不影响线上报名；
--   · 等级继承沿用 satisfiesLevel：SVIP⊃VIP⊃NONE，门槛=VIP 时 SVIP 也能报；
--   · 带默认值的 ADD COLUMN 为 INSTANT，不锁表、不回填数据。
--
-- 回滚思路：register_min_level 为纯资格门槛列，无资金/状态语义，直接删除即可：
--   ALTER TABLE events DROP COLUMN register_min_level;
--   （删除后报名资格回退为「仅受 visibility + 时间 + 名额」约束，与改造前一致。）
-- ============================================================================

ALTER TABLE events
  ADD COLUMN register_min_level ENUM('NONE','VIP','SVIP') NOT NULL DEFAULT 'NONE'
    COMMENT '人工分批报名门槛：此刻允许报名的最低会员等级，运营手动 SVIP→VIP→NONE 逐步放开' AFTER visibility;