"use client";
// 相守（计划书第 6 节 / UI-11..14）：演示版完整状态流 —— 投入、冷静期、审核、领取、失效、例外。
// v2.5：need_more 申请在相守页直接补充材料（补正闭环）；后台暂停新计划时按钮同步停用。
import { useEffect, useState } from "react";
import { Button, Card, Chip, EmptyState, RoseIcon, StageArt, anchorStatusChip, countdownText, zhDate } from "../ui";
import { Modal } from "../modal";
import type { V2StateView } from "../../lib/domain/view-dtos";
import { businessDateKey, type AnchorEvidence } from "../../lib/domain/v2-types";
import { EvidenceDrawer } from "./evidence-drawer";
import { exportEvidence } from "./us-tab";
import type { TabId } from "./app-shell";

const DAY = 86_400_000, HOUR = 3_600_000;

export function FutureTab({ view, user, busy, act, switchTab }: {
  view: V2StateView; user: string; busy: boolean;
  act(path: string, body?: Record<string, unknown>): Promise<boolean>;
  switchTab(tab: TabId): void;
}) {
  const [creating, setCreating] = useState(false);
  const [targetType, setTargetType] = useState<"marriage" | "anniversary">("marriage");
  const [rewardChoice, setRewardChoice] = useState<"A" | "B">("A");
  const [acceptOpen, setAcceptOpen] = useState(false);
  const [claimOpen, setClaimOpen] = useState(false);
  const [goalDate, setGoalDate] = useState("");
  const [evidenceNote, setEvidenceNote] = useState("");
  const [endOpen, setEndOpen] = useState<null | "normal" | "exception">(null);
  const [evidence, setEvidence] = useState<{ anchor: AnchorEvidence | null; business: string; recordId?: string } | null>(null);
  const plan = view.future.plan;
  const now = view.modes.virtualNow;
  useEffect(() => { if (!creating) return; setTargetType("marriage"); setRewardChoice("A"); }, [creating]);

  return <>
    <p className="eyebrow">期待相守</p>
    <h1>{plan ? "一起走到了这一天" : "给未来留一份期待"}</h1>
    <p><span className="chip warning">恋爱保险概念演示 · 使用演示点数</span></p>

    {!plan && !view.future.eligible && <>
      <div className="plan-hero"><StageArt stage="future" />
        <p className="muted">相守计划为共同的未来增加仪式感：双方自愿投入演示点数，达成共同目标后领取奖励。</p>
      </div>
      <ul className="rule-list">{view.future.rules.map(r => <li key={r}>{r}</li>)}</ul>
      <EmptyState title={view.future.blockingReason ?? "尚未加入"} hint="可以先阅读规则；加入需要双方有效绑定。"
        action={<Button onClick={() => switchTab("know")}>去建立关系</Button>} />
    </>}

    {!plan && view.future.eligible && <>
      <div className="plan-hero">
        <StageArt stage="future" />
        <h3>相守计划 · 演示</h3>
        <p className="muted">你投入 100 点，TA 投入 100 点（初始各 1000 演示点）。<br />达成：返还 + 约定奖励；普通结束：投入失效；冷静期 24 小时可退回。</p>
        <p className="muted points">我的余额：{view.future.myBalance} 点 · 奖励预算池：{view.future.rewardPoolBalance} 点 · 玫瑰券库存：{view.future.roseStock} 张</p>
      </div>
      <ul className="rule-list">{view.future.rules.map(r => <li key={r}>{r}</li>)}</ul>
      {view.publicMaintenance.planNewEnabled
        ? <Button disabled={busy} onClick={() => setCreating(true)}>邀请 TA 一起加入</Button>
        : <Button disabled title="维护公告期内暂停新建计划">新计划暂停加入（维护中）</Button>}
    </>}

    {plan && <PlanDetail view={view} user={user} plan={plan} now={now} busy={busy} act={act}
      onAccept={() => setAcceptOpen(true)} onClaim={() => { setGoalDate(defaultClaimDate(plan, now)); setEvidenceNote("双方线下登记（演示剧情，非真实证件）"); setClaimOpen(true); }} onEnd={mode => setEndOpen(mode)}
      onEvidence={() => setEvidence({ anchor: plan.anchor, business: "计划条款（双方确认）", recordId: plan.id })} />}

    {creating && <Modal title="发起相守计划" onClose={() => setCreating(false)}>
      <p className="muted">每段关系最多 1 个有效计划；条款由服务端固定，激活后单方不可修改奖励方式。</p>
      <label className="field-label">共同目标</label>
      <div className="choice-list">
        <button className={targetType === "marriage" ? "chosen" : ""} onClick={() => setTargetType("marriage")}>登记结婚（演示核验，非真实婚姻认证）</button>
        <button className={targetType === "anniversary" ? "chosen" : ""} onClick={() => setTargetType("anniversary")}>共同周年目标（周年礼遇，不标记已婚）</button>
      </div>
      <label className="field-label">达成奖励</label>
      <div className="choice-list">
        <button className={rewardChoice === "A" ? "chosen" : ""} onClick={() => setRewardChoice("A")}>A · 每人各返 100 点 + 50 点奖励</button>
        <button className={rewardChoice === "B" ? "chosen" : ""} onClick={() => setRewardChoice("B")}>B · 每人各返 100 点 + 共领一张 99 朵玫瑰演示券</button>
      </div>
      {rewardChoice === "B" && <p className="muted">玫瑰演示券为<strong>双方共同持有</strong>（每人各一张），不需要指定单独领取人；券不可实际核销、不可转卖。</p>}
      <Button disabled={busy} onClick={async () => { if (await act("plans", { targetType, rewardChoice })) setCreating(false); }}>送出加入邀请（72 小时内有效）</Button>
    </Modal>}

    {acceptOpen && plan && <Modal title="确认加入相守计划" onClose={() => setAcceptOpen(false)}>
      <p className="muted">双方各投入 100 演示点；激活后 24 小时为冷静期（任一方取消即全额退回）。激活需要奖励预算预留成功，否则双方都不会被扣点。</p>
      <ul className="rule-list">{view.future.rules.map(r => <li key={r}>{r}</li>)}</ul>
      <label className="checkbox"><input type="checkbox" checked readOnly />我已阅读并同意条款版本 {plan.termsVersion}（演示条款）</label>
      <Button disabled={busy} onClick={async () => { if (await act("plans/accept", { planId: plan.id, expectedRevision: plan.revision, termsConfirmed: true })) setAcceptOpen(false); }}>投入 100 点并加入</Button>
    </Modal>}

    {claimOpen && plan && <Modal title="申请目标核验" onClose={() => setClaimOpen(false)}>
      <p className="muted">P0 使用人工制作的演示材料，醒目标注“非真实证件”；审核只验证工作流，不代表接入婚姻登记机构。目标必须发生在冷静期结束后、计划到期前。</p>
      <label className="field-label" htmlFor="goal-date">目标发生日期</label>
      <input id="goal-date" type="date" value={goalDate} max={businessDateKey(now)} onChange={e => setGoalDate(e.target.value)} />
      <label className="field-label" htmlFor="claim-note">演示材料说明</label>
      <input id="claim-note" maxLength={200} value={evidenceNote} placeholder="例如：双方线下登记（演示剧情）" onChange={e => setEvidenceNote(e.target.value)} />
      <Button disabled={busy || !goalDate || !evidenceNote.trim()} onClick={async () => {
        if (await act("plans/claims", { planId: plan.id, targetOccurredAt: Date.parse(`${goalDate}T12:00:00Z`), evidenceNote })) setClaimOpen(false);
      }}>提交审核（审核期 7 天，补正 14 天）</Button>
    </Modal>}

    {endOpen && plan && <Modal title={endOpen === "exception" ? "申请例外处理" : "结束计划"} onClose={() => setEndOpen(null)}>
      {endOpen === "exception" ? <>
        <p className="muted">平台错误、安全求助或被冒用等例外：结算先冻结，人工处理；可分别退还本金，不需要对方批准退出。不影响关系本身。</p>
        <Button disabled={busy} onClick={async () => { if (await act("plans/cancel", { planId: plan.id, expectedRevision: plan.revision, reasonType: "exception" })) setEndOpen(null); }}>提交例外申请</Button>
      </> : <>
        <p className="muted">冷静期内结束：双方投入原路退回。<br />冷静期后结束：进入 7 天异议窗口，窗口结束后共 200 点记入不可流通的演示失效账户（不转给任何人）。退出关系不需要等待计划结算。</p>
        <Button className="danger" disabled={busy} onClick={async () => { if (await act("plans/cancel", { planId: plan.id, expectedRevision: plan.revision, reasonType: "normal" })) setEndOpen(null); }}>确认结束计划</Button>
      </>}
      <Button className="ghost" onClick={() => setEndOpen(null)}>再想想</Button>
    </Modal>}

    <EvidenceDrawer open={!!evidence} onClose={() => setEvidence(null)} anchor={evidence?.anchor ?? null}
      businessStatus={evidence?.business ?? ""} sourceLabel="双方确认（演示）"
      onExport={evidence?.recordId ? () => exportEvidence(evidence.recordId!, user) : undefined} />
  </>;
}


// 核验目标日期默认值：不早于冷静期结束、不晚于虚拟今天（宽限期内仍可选到期前日期）
function defaultClaimDate(plan: NonNullable<V2StateView["future"]["plan"]>, now: number): string {
  const floor = plan.coolingUntil ?? 0;
  // v2.7：业务时区（北京时间）的日期键，与服务端校验同口径。
  const dateStr = businessDateKey(Math.max(now, floor));
  // 日期输入按当日 12:00Z 解析；若该时刻仍早于冷静期结束，顺延一天
  if (Date.parse(`${dateStr}T12:00:00Z`) < floor) {
    return businessDateKey(floor + 86_400_000);
  }
  return dateStr;
}
function plan0Members(view: V2StateView): string[] {
  return view.us.relationship?.members ?? [view.me.id];
}

function PlanDetail({ view, user, plan, now, busy, act, onAccept, onClaim, onEnd, onEvidence }: {
  view: V2StateView; user: string; plan: NonNullable<V2StateView["future"]["plan"]>; now: number;
  busy: boolean; act(path: string, body?: Record<string, unknown>): Promise<boolean>;
  onAccept(): void; onClaim(): void; onEnd(mode: "normal" | "exception"): void; onEvidence(): void;
}) {
  const [supplementNote, setSupplementNote] = useState("");
  const claim = plan.claim;
  const benefit = plan.benefit;
  const iAmInviter = plan.proposedBy === user;
  const claimSteps = [
    { done: plan.status !== "awaiting_partner" && plan.status !== "draft", label: "双方确认加入并投入" },
    { done: ["claim_review", "approved", "redeemable", "settled"].includes(plan.status) || (claim?.status === "rejected"), label: "达成目标并提交核验" },
    { done: ["approved", "redeemable", "settled"].includes(plan.status), label: "审核通过（7 天争议期）" },
    { done: ["settled"].includes(plan.status), label: "领取奖励" },
  ];
  return <>
    <div className="claim-steps">
      {claimSteps.map((step, i) => (
        <div key={i} className={step.done ? "done" : ""}><span className="step-dot">{step.done ? "✓" : i + 1}</span>{step.label}</div>
      ))}
    </div>

    {plan.status === "awaiting_partner" && <>
      <Card><h3>{iAmInviter ? "等待 TA 加入" : "TA 邀请你一起加入"}</h3>
        <p className="muted">邀请 {countdownText(plan.inviteExpiresAt - now)}；对方未接受不会扣点。</p>
        <p className="muted">奖励：{plan.rewardChoice === "A" ? "A · 每人各 50 点" : "B · 99 朵玫瑰演示券 · 双方共同持有"}</p>
        {iAmInviter
          ? <Button className="ghost" disabled={busy} onClick={() => act("plans/cancel", { planId: plan.id, expectedRevision: plan.revision, reasonType: "normal" })}>取消邀请</Button>
          : <Button disabled={busy} onClick={onAccept}>查看条款并加入</Button>}
      </Card>
    </>}

    {["active", "claim_review", "approved", "forfeit_pending", "exception_review"].includes(plan.status) && <Card>
      <div className="me-row"><b>状态</b><Chip tone="brand">{plan.statusLabel}</Chip></div>
      <div className="me-row"><b>投入</b><span className="points">双方各 {plan.investPerUser} 点（托管中共 {plan.investedTotal} 点）</span></div>
      <div className="me-row"><b>目标</b><span>{plan.targetType === "marriage" ? "登记结婚（演示核验）" : "共同周年目标"}</span></div>
      <div className="me-row"><b>奖励</b><span>{plan.rewardChoice === "A" ? "A · 各返 100 + 50 点" : "B · 各返 100 + 玫瑰演示券"}</span></div>
      {plan.coolingUntil && plan.status === "active" && now < plan.coolingUntil && <div className="me-row"><b>冷静期</b><span className="points">{countdownText(plan.coolingUntil - now)}</span></div>}
      {plan.expiresAt && <div className="me-row"><b>有效期至</b><span className="date">{zhDate(plan.expiresAt)}</span></div>}
      {plan.forfeitWindowUntil && <div className="me-row"><b>异议窗口</b><span className="points">{countdownText(plan.forfeitWindowUntil - now)}</span></div>}
      {claim?.appealUntil && <div className="me-row"><b>争议期</b><span className="points">{countdownText(claim.appealUntil - now)}</span></div>}
      {claim && <div className="me-row"><b>申请</b><span className="muted">{claim.evidenceNote}（{zhDate(claim.targetOccurredAt)}）</span></div>}
      {claim?.status === "need_more" && <div className="supplement-box">
        <b>审核要求补充材料{claim.reasonCode ? `（${claim.reasonCode}）` : ""}</b>
        <p className="muted">{claim.decisionNote ?? "请补充材料说明"}。补正期至 {zhDate(claim.reviewDeadlineAt)}，补充后重新进入 7 天审核。</p>
        {/* v2.5 补正闭环：原申请保留，只追加新材料版本 */}
        <label className="field-label" htmlFor="supplement-note">补充材料说明（2–200 字）</label>
        <textarea id="supplement-note" maxLength={200} rows={3} value={supplementNote}
          placeholder="例如：目标发生在 10 月 2 日，附双方在登记点的合影说明。"
          onChange={e => setSupplementNote(e.target.value)} />
        <Button disabled={busy || supplementNote.trim().length < 2} onClick={async () => {
          if (await act("plans/claims/supplement", { claimId: claim.id, note: supplementNote.trim() })) setSupplementNote("");
        }}>提交补充材料</Button>
      </div>}
    </Card>}

    {plan.status === "active" && <>
      {!claim && <Button disabled={busy} onClick={onClaim}>申请目标核验</Button>}
      {now < (plan.coolingUntil ?? 0)
        ? <Button className="secondary" disabled={busy} onClick={() => onEnd("normal")}>冷静期取消（退回双方投入）</Button>
        : <Button className="ghost" disabled={busy} onClick={() => onEnd("normal")}>结束计划（投入进入失效流程）</Button>}
      <Button className="ghost" disabled={busy} onClick={() => onEnd("exception")}>例外 / 求助</Button>
    </>}

    {plan.status === "claim_review" && <p className="muted center">核验中（演示审核台可模拟 通过 / 补充材料 / 不通过）。审核期间到期不会吞掉申请。</p>}
    {plan.status === "approved" && <p className="muted center">已通过审核，{claim?.appealUntil ? countdownText(claim.appealUntil - now) : "争议期"}后可领取。</p>}
    {plan.status === "forfeit_pending" && <>
      <p className="muted center">异议窗口内如有证据表明结束前已达成目标，仍可受理。</p>
      <Button className="secondary" disabled={busy} onClick={() => act("disputes", { targetType: "plan", targetId: plan.id, note: "结束前已达成目标，申请例外复核" })}>提出异议（例外复核）</Button>
    </>}
    {plan.status === "exception_review" && <p className="muted center">结算已冻结，进入例外复核（演示台可模拟结论：退回本金 / 维持失效 / 返回核验）。例外复核 30 天未完成按平台无法履约取消并退回本金。</p>}

    {plan.status === "redeemable" && benefit && <div className="reward-ticket">
      <div className="rose-visual center"><RoseIcon /></div>
      <h3 className="center">{benefit.kind === "rose_ticket" ? "99 朵玫瑰 · 演示券" : "相守达成 · 点数奖励"}</h3>
      {benefit.kind === "rose_ticket"
        ? <><p className="center muted">双方共同持有 · 每人各一张 · 此券不可实际核销、不可转卖</p>
          <p className="center muted">目标核验：模拟通过（演示材料，非真实证件）</p></>
        : <p className="center muted">你们各返还 100 点，并各获得 50 点奖励（独立奖励预算）</p>}
      {benefit.recipients.includes(user)
        ? <Button disabled={busy} onClick={() => act("benefits/redeem", { benefitId: benefit.id, idempotencyKey: benefit.idempotencyKey })}>
          {benefit.status === "settled" ? "已领取（重复点击不会重复发放）" : benefit.kind === "rose_ticket" ? "领取演示玫瑰券" : "领取演示点数"}</Button>
        : <p className="muted center">共同权益：任意一方领取后，双方各自得到属于自己的一份。</p>}
      <p className="muted center">条款版本 {plan.termsVersion} · <button className="text-button" onClick={onEvidence}>查看证据</button></p>
    </div>}

    {plan.status === "settled" && <Card>
      <h3>已结算</h3>
      <p className="muted">奖励已一次性发放（幂等）。普通分手不会追回已按规则结算的奖励；确证欺诈的追偿属于独立人工流程。</p>
      <Button className="ghost" onClick={onEvidence}>查看结算证据</Button>
    </Card>}

    {plan.status === "cancelled" && <Card><h3>已取消</h3>
      <p className="muted">{plan.endedReason === "cooling_cancel" ? "冷静期取消：双方投入已原路退回。" : plan.endedReason === "exception" ? "例外处理取消：按复核结论退回本金。" : "邀请过期或取消：未扣任何点数。"}</p>
    </Card>}
    {plan.status === "forfeited" && <Card><h3>已失效</h3>
      <p className="muted">投入共 {plan.investedTotal} 点已记入不可流通的演示失效账户，不转给前任、其他情侣或运营收入；奖励预算已释放。</p>
    </Card>}
  </>;
}
