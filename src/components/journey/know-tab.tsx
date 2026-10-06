"use client";
// 了解（计划书第 4 节 / UI-05/06）：意向、应用内状态、履约参考、联系方式独立授权、邀请关系。
import { useState } from "react";
import { Button, Card, Chip, EmptyState, StageArt, zhDate, countdownText } from "../ui";
import { Modal } from "../modal";
import { AvatarZoom } from "../avatar-zoom";
import type { KnowConnectionDto, V2StateView } from "../../lib/domain/view-dtos";
import { orientationDisplay } from "../../lib/domain/v2-types";
import type { TabId } from "./app-shell";

export function KnowTab({ view, user, busy, act, switchTab }: {
  view: V2StateView; user: string; busy: boolean;
  act(path: string, body?: Record<string, unknown>): Promise<boolean>;
  switchTab(tab: TabId): void;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [closeOpen, setCloseOpen] = useState<string | null>(null);
  const connections = view.know.connections.filter(c => !c.closed);
  const closedOnes = view.know.connections.filter(c => c.closed);

  if (!connections.length) {
    return <>
      <p className="eyebrow">慢慢了解</p>
      <h1>先看看彼此<br />想要怎样的关系</h1>
      <StageArt stage="know" />
      <EmptyState title="还没有认识任何人" hint="从轻轻摇一下铃铛开始。这里不做高分推荐，也不按分数隐藏任何人。"
        action={<Button onClick={() => switchTab("meet")}>去相遇</Button>} />
      {closedOnes.length > 0 && <Card className="tight">
        <h3>已关闭的连接</h3>
        {closedOnes.map(c => <div className="me-row" key={c.id}><span>已关闭的连接</span><Chip>停止访问</Chip></div>)}
      </Card>}
    </>;
  }

  const conn = connections.find(c => c.id === openId) ?? connections[0];
  const myGrantForContact = view.me.grantsIssued.find(g => g.scope === "profile_contact" && g.active);
  const hasRelationship = !!view.us.relationship || !!view.us.incomingInvite || !!view.us.outgoingInvite;

  return <>
    <p className="eyebrow">慢慢了解</p>
    <h1>了解彼此</h1>
    {connections.length > 1 && <div className="filter-row">
      {connections.map(c => <button key={c.id} className={c.id === conn.id ? "active" : ""} onClick={() => setOpenId(c.id)}>{c.profile?.nickname ?? "匿名"}</button>)}
    </div>}
    <Card>
      <div className="profile-head">
        <AvatarZoom value={conn.profile?.avatar} size={64} className="reveal-avatar" />
        <div>
          <h3>{conn.profile?.nickname ?? "尚未揭晓"}</h3>
          {conn.intentionLabel && <span className="intent-badge">意向：{conn.intentionLabel}</span>}
        </div>
      </div>
      {conn.profile && <>
        <p className="quote-sm" style={{ marginTop: 8 }}>“{conn.profile.bio}”</p>
        <div className="me-row"><b>出生年代</b><span>{conn.profile.ageWindow || "未填写"}</span></div>
        <div className="me-row"><b>性取向</b><span>{conn.profile.orientation ? orientationDisplay(conn.profile.orientation, conn.profile.orientationCustom) : "未填写"}</span></div>
        <div className="me-row"><b>MBTI</b><span>{conn.profile.mbti ?? "未填写"}</span></div>
        <div className="me-row" style={{ alignItems: "flex-start" }}><b>爱好标签</b>
          <span className="interest-tags" style={{ justifyContent: "flex-end" }}>
            {conn.profile.interests.length ? conn.profile.interests.map(i => <span key={i}>{i}</span>) : "未填写"}
          </span>
        </div>
      </>}
      <div className="me-row"><b>应用内关系状态</b>
        <span>{conn.appBindingStatus === "none" ? <Chip tone="success">暂无有效恋爱绑定</Chip> : conn.appBindingStatus === "active" ? <Chip tone="warning">已在应用内绑定</Chip> : <Chip tone="warning">应用内已婚标记</Chip>}</span>
      </div>
      <p className="muted">应用内无绑定不等于现实单身；有绑定也不代表现实已婚。性取向与出生年代为对方本人填写，仅作了解参考。</p>
    </Card>

    <TrustCard conn={conn} viewerId={view.me.id} busy={busy} act={act} />

    <Card>
      <h3>联系方式</h3>
      {conn.contacts && conn.contacts.length
        ? <>
          {conn.contacts.map(c => <div className="me-row" key={c.label}><b>{c.label}</b><span className="points">{c.value}</span></div>)}
          <p className="muted">由对方独立授权给你，有效期 72 小时，可随时撤销。</p>
        </>
        : <p className="muted">联系方式需要对方单独授权；拒绝交换仍可以继续了解。</p>}
      {myGrantForContact
        ? <p className="muted">你已授权对方查看你的联系方式（剩余 {countdownText(myGrantForContact.expiresAt - view.modes.virtualNow)}）。</p>
        : <Button className="secondary" disabled={busy} onClick={() => act("share-grants", { scope: "profile_contact" })}>授权对方查看我的联系方式</Button>}
    </Card>

    {view.us.incomingInvite && view.us.incomingInvite.members.includes(conn.userId) && <Card>
      <h3>TA 邀请你建立关系</h3>
      <p className="muted">邀请有效期至 {zhDate(view.us.incomingInvite.inviteExpiresAt)}。双方确认后才会建立；建立后雷达将停止。</p>
      <Button disabled={busy} onClick={() => act("relationships/accept", { relationshipId: view.us.incomingInvite!.id })}>我愿意建立这段关系</Button>
      <Button className="secondary" disabled={busy} onClick={() => act("relationships/decline", { relationshipId: view.us.incomingInvite!.id })}>暂时不想</Button>
    </Card>}

    {view.us.outgoingInvite && <Card><h3>已送出关系邀请</h3>
      <p className="muted">等待对方确认（{countdownText(view.us.outgoingInvite.inviteExpiresAt - view.modes.virtualNow)}）。取消后不会建立关系。</p>
      <Button className="ghost" disabled={busy} onClick={() => act("relationships/cancel", { relationshipId: view.us.outgoingInvite!.id })}>取消邀请</Button>
    </Card>}

    {!hasRelationship && !view.us.incomingInvite && !view.us.outgoingInvite && <Card>
      <h3>下一步</h3>
      <p className="muted">是否进入关系，始终由你们自己决定；分数和资料都只是参考。</p>
      <Button disabled={busy} onClick={() => setInviteOpen(true)}>邀请建立关系</Button>
      <Button className="ghost" disabled={busy} onClick={() => setCloseOpen(conn.id)}>关闭这个连接</Button>
    </Card>}

    {inviteOpen && <Modal title="邀请建立关系" onClose={() => setInviteOpen(false)}>
      <p className="muted">双方确认后建立应用内关系：共享「我们」空间、可共同写日记与承诺，恋爱雷达随之停止。任一方都可以随时结束绑定，不需要对方同意。</p>
      <p className="muted">关系建立事件会生成存证任务（链上只写随机化承诺，不公开身份）。</p>
      <Button disabled={busy} onClick={async () => { if (await act("relationships/propose")) setInviteOpen(false); }}>送出邀请（72 小时内有效）</Button>
    </Modal>}
    {closeOpen && <Modal title="关闭连接" onClose={() => setCloseOpen(null)}>
      <p className="muted">关闭后停止新铃声与双方继续访问；保留必要的本人记录。这不是举报，也不影响你的履约分。</p>
      <Button className="danger" disabled={busy} onClick={async () => { if (await act("connection-close", { connectionId: closeOpen })) setCloseOpen(null); }}>确认关闭连接</Button>
      <Button className="ghost" onClick={() => setCloseOpen(null)}>再想想</Button>
    </Modal>}
  </>;
}

function TrustCard({ conn, viewerId, busy, act }: {
  conn: KnowConnectionDto; viewerId: string; busy: boolean;
  act(path: string, body?: Record<string, unknown>): Promise<boolean>;
}) {
  const [detailOpen, setDetailOpen] = useState(false);
  const myGrant = null; // 摘要授权由资料所有人在“我的”里管理
  void myGrant; void viewerId; void busy; void act;
  const t = conn.trust;
  return <div className="trust-card">
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
      <h3 style={{ margin: 0 }}>关系履约参考</h3>
      <Chip tone="outline">演示数据</Chip>
    </div>
    {t.status === "granted" && t.summary ? <>
      <div className="trust-score"><b>{t.summary.score === null ? "—" : t.summary.score}</b><small>/ 100{t.summary.score !== null ? ` · 基于 ${t.summary.settled} 项已结算承诺` : ""}</small></div>
      <p className="muted">仅反映应用内已记录事项，不代表人格、现实单身或未来表现。</p>
      <div style={{ display: "flex", gap: 10 }}>
        <Button className="secondary small" onClick={() => setDetailOpen(true)}>查看依据</Button>
        <span className="muted" style={{ alignSelf: "center" }}>非人品认证</span>
      </div>
    </> : t.status === "revoked" ? <p className="muted" style={{ margin: "10px 0" }}>目前未开放参考记录（对方已撤销授权）。这不暗示任何失信。</p>
      : t.status === "expired" ? <p className="muted" style={{ margin: "10px 0" }}>授权已过期，目前未开放参考记录。这不暗示任何失信。</p>
      : <p className="muted" style={{ margin: "10px 0" }}>对方尚未授权查看履约参考。授权完全自愿，拒绝不影响你们继续了解。</p>}
    {detailOpen && t.summary && <Modal title="履约明细" onClose={() => setDetailOpen(false)}>
      {t.summary.score === null
        ? <p><b>{t.summary.reasonLabel}</b></p>
        : <div className="trust-score"><b>{t.summary.score}</b><small>/ 100</small></div>}
      <div className="trust-meta">
        <div><b>{t.summary.s}</b><small>已履行</small></div>
        <div><b>{t.summary.f}</b><small>未完成</small></div>
        <div><b>{t.summary.pending}</b><small>待结算</small></div>
        <div><b>{Math.round(t.summary.coverage * 100)}%</b><small>覆盖率</small></div>
      </div>
      <p className="muted" style={{ marginTop: 10 }}>计算方式：score = round(100 × (s+1)/(n+2))，n = 已履行 + 未完成。样本不足 3 项、覆盖率低于 80% 或存在未决申诉时不显示分数。</p>
      <div className="evidence-rows">
        <div className="row"><b>算法版本</b><span>{t.summary.algorithmVersion}</span></div>
        <div className="row"><b>数据截至</b><span>{new Date(t.summary.asOf).toLocaleString("zh-CN")}</span></div>
        <div className="row"><b>摘要版本</b><span>v{t.summary.version}{t.summary.revokedAt ? "（已撤销）" : ""}</span></div>
        <div className="row"><b>来源</b><span>{t.summary.origin === "demo" ? "演示数据（虚构前史）" : "用户业务记录"}</span></div>
      </div>
      <p className="muted">可见：分数或无分状态、样本数量、算法说明、更新时间。不可见：前任姓名、钱包、关系次数、日记正文与分手原因。每次打开都会向服务端校验版本与撤销状态。</p>
    </Modal>}
  </div>;
}
