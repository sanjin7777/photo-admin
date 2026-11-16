<script setup lang="ts">
import { LEGAL_VERSION } from '@photo/shared';

/**
 * 个人信息处理者身份（PIPL 第 17 条要求告知名称与联系方式）。
 *
 * ⚠️ 部署前必须把下面两个占位符替换为真实姓名与可用邮箱，
 *    否则用户无法行使查阅、更正、删除等权利，政策也不成立。
 */
const OPERATOR_NAME = '【请填写备案人真实姓名】';
const OPERATOR_CONTACT = '【请填写联系邮箱，例如 xxx@example.com】';
</script>

<template>
  <section class="mx-auto max-w-3xl px-5 py-8">
    <RouterLink to="/" class="text-xs text-slate-500 hover:text-slate-900">← 返回</RouterLink>
    <h1 class="mt-3 text-2xl font-semibold text-slate-900">隐私政策</h1>
    <p class="mt-1 text-xs text-slate-500">生效日期：{{ LEGAL_VERSION }}</p>

    <div class="mt-6 space-y-5 text-sm leading-relaxed text-slate-600">
      <div>
        <h2 class="text-base font-semibold text-slate-900">一、适用范围与个人信息处理者</h2>
        <p class="mt-1">
          本政策适用于猫爪社摄影会会员内部活动管理系统（域名 catpaw.art）。
          我们仅处理为提供活动登记与会员管理所必需的个人信息。
        </p>
        <!-- 合规要点：PIPL 第 17 条要求告知处理者名称与联系方式，二者缺一不可 -->
        <div class="mt-3 rounded-lg bg-slate-50 px-3 py-2.5 text-[13px] leading-relaxed">
          <p><span class="text-slate-500">个人信息处理者：</span>{{ OPERATOR_NAME }}</p>
          <p class="mt-0.5"><span class="text-slate-500">联系方式：</span>{{ OPERATOR_CONTACT }}</p>
          <p class="mt-1 text-xs text-slate-500">
            本站为个人主体备案，未设立专门的数据保护机构；相关请求由上述联系人直接受理。
          </p>
        </div>
      </div>

      <div>
        <h2 class="text-base font-semibold text-slate-900">二、我们收集的信息</h2>
        <ul class="mt-1 list-disc space-y-1 pl-5">
          <li>账号信息：微信号、昵称、密码（仅保存不可逆哈希，不保存明文）。</li>
          <li>业务信息：活动登记记录、场次与时段、积分变动流水、权益券持有与使用记录。</li>
          <li>日志信息：登录时间、IP 地址、浏览器标识（User-Agent），用于安全审计与故障排查。</li>
          <li>我们已停止采集手机号；邮箱仅在您主动填写时保存，且仅用于账号找回与通知。</li>
        </ul>
        <p class="mt-2 text-xs leading-relaxed text-slate-500">
          <b>关于 Cookie：</b>本站仅使用一枚<b>维持登录状态所必需</b>的会话 Cookie（HttpOnly + SameSite，脚本无法读取），
          不含任何广告或第三方追踪标识，也不用于跨站画像。清除该 Cookie 即退出登录；
          关闭浏览器或主动退出后即失效。
        </p>
      </div>

      <div>
        <h2 class="text-base font-semibold text-slate-900">三、使用目的</h2>
        <ul class="mt-1 list-disc space-y-1 pl-5">
          <li>账号登录与身份识别、活动登记与名额管理。</li>
          <li>积分与权益券结算、取消登记后的权益退回与账目核对。</li>
          <li>安全防护、异常登录识别、纠纷处理与法定义务履行。</li>
        </ul>
      </div>

      <div>
        <h2 class="text-base font-semibold text-slate-900">四、保存期限与存储地点</h2>
        <ul class="mt-1 list-disc space-y-1 pl-5">
          <li>账号信息在账号存续期间保存，注销后按法律要求删除或匿名化。</li>
          <li>登记、取消与券核销等记录自形成之日起保存不少于 3 年。</li>
          <li>网络日志保存不少于 6 个月。</li>
          <li>上述信息存储于中华人民共和国境内的服务器。</li>
        </ul>
      </div>

      <div>
        <h2 class="text-base font-semibold text-slate-900">五、共享与披露</h2>
        <p class="mt-1">
          我们不会向第三方出售或出租您的个人信息。除法律法规要求、司法机关或行政机关依法调取，
          或为处理您主动发起的登记变更等事务所必需外，不对外提供。本站不接入任何第三方支付通道，不进行在线收款，也不处理任何银行卡或支付账户信息。
        </p>
      </div>

      <div>
        <h2 class="text-base font-semibold text-slate-900">六、您的权利</h2>
        <ul class="mt-1 list-disc space-y-1 pl-5">
          <li>查询与更正：可在「个人中心」查看账号、登记与积分信息，或联系客服更正。</li>
          <li>删除与注销：可联系客服申请删除个人信息或注销账号；法律要求保留的交易记录除外。</li>
          <li>撤回同意：可撤回对非必要处理的同意，但不影响撤回前已进行的处理。</li>
        </ul>
      </div>

      <div>
        <h2 class="text-base font-semibold text-slate-900">七、未成年人保护</h2>
        <p class="mt-1">
          本站服务面向成年人。未满 18 周岁的，应在监护人陪同下阅读本政策并取得监护人同意后使用。
        </p>
      </div>

      <div>
        <h2 class="text-base font-semibold text-slate-900">八、安全措施</h2>
        <p class="mt-1">
          我们采用 HTTPS 传输、密码哈希存储、最小权限与操作审计等措施保护信息安全；
          如发生个人信息安全事件，将按规定及时告知受影响用户并向监管部门报告。
        </p>
      </div>

      <div>
        <h2 class="text-base font-semibold text-slate-900">九、政策更新与联系我们</h2>
        <p class="mt-1">
          本政策更新时会在站内公示并重新征求同意。如有疑问、投诉或权利请求，
          请通过站内「联系客服」与我们联系，我们将在 15 个工作日内答复。
        </p>
      </div>
    </div>

    <div class="mt-8 border-t border-slate-200 pt-4 text-center text-xs text-slate-500">
      <p>猫爪社摄影会 · 湘ICP备2026012181号-2</p>
      <p class="mt-1"><RouterLink to="/terms" class="hover:text-slate-700">查看《用户协议》</RouterLink></p>
    </div>
  </section>
</template>
