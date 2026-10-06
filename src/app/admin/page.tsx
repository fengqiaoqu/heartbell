"use client";
// /admin 维护工作台（v2.5，依据《Heartbell v2.1-后台设计交付》）：
// 运行总览 / 核验工作台 / 例外与申诉 / 用户与关系 / 奖励与账本 / 存证任务 / 运行与审计。
// 与用户端共用同一业务数据（/api/v2/ops 受控接口）；权限由服务端 RBAC 校验，隐藏按钮不算数。
// 演示环境：两个测试管理账号（owner / reviewer）；APP_MODE=live 时登录被服务端拒绝。
import { useCallback, useEffect, useRef, useState } from "react";
import "./admin.css";

type Section = "overview" | "claims" | "safety" | "cases" | "users" | "rewards" | "anchors" | "system";
const sections: { id: Section; text: string }[] = [
  { id: "overview", text: "运行总览" },
  { id: "claims", text: "核验工作台" },
  { id: "safety", text: "安全工单" },
  { id: "cases", text: "例外与申诉" },
  { id: "users", text: "用户与关系" },
  { id: "rewards", text: "奖励与账本" },
  { id: "anchors", text: "存证任务" },
  { id: "system", text: "运行与审计" },
];

class OpsError extends Error {
  constructor(message: string, public status: number, public code: string) { super(message); }
}
async function opsGet<T>(path: string): Promise<T> {
  const r = await fetch(`/api/v2/ops/${path}`, { cache: "no-store" });
  const j = await r.json();
  if (!r.ok) throw new OpsError(j.error?.message ?? "查询失败", r.status, j.error?.code ?? "UNKNOWN");
  return j.data as T;
}
async function opsPost<T = { ok: boolean }>(path: string, body: Record<string, unknown> = {}): Promise<T> {
  const r = await fetch(`/api/v2/ops/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new OpsError(j.error?.message ?? "操作失败", r.status, j.error?.code ?? "UNKNOWN");
  return j.data as T;
}
const zhTime = (ts: number | null | undefined) => ts ? new Date(ts).toLocaleString("zh-CN", { hour12: false }) : "—";
const zhDate = (ts: number | null | undefined) => ts ? new Date(ts).toLocaleDateString("zh-CN") : "—";

interface SessionInfo { actor: string; username: string; roles: string[]; permissions: string[] }
interface Overview {
  metrics: { pendingClaims: number; needMoreClaims: number; exceptionReviews: number; failedAnchors: number; unconfiguredAnchors: number; availableRose: number; availablePoints: number };
  tasks: { source: string; targetId: string; owner: string; deadlineAt: number | null; impact: string }[];
  health: { appMode: string; storage: string; lastSweepAt: number | null; virtualNow: number; pendingApprovals: number; configVersion: number };
  asOf: number; dataOrigin: string;
}
interface ClaimRow {
  id: string; planId: string; status: string; targetType: string; membersMasked: string[];
  submittedAt: number; reviewDeadlineAt: number | null; assignedTo: string | null; revision: number; latestMaterial: string;
}
interface ClaimDetail extends ClaimRow {
  targetOccurredAt: number; decidedAt: number | null; decidedBy: string | null; decisionNote: string | null;
  reasonCode: string | null; lastSupplementAt: number | null; appealUntil: number | null;
  plan: { id: string; status: string; statusLabel: string; revision: number; rewardChoice: string; activatedAt: number | null; coolingUntil: number | null; expiresAt: number | null; graceUntil: number | null; exceptionOpenedAt: number | null };
  materials: { index: number; note: string; submittedBy: string; submittedAt: number; source: string }[];
  reviewEvents: { at: number; actor: string; decision: string; reasonCode: string | null; note: string | null }[];
  ruleChecks: { item: string; pass: boolean }[];
}
interface CasesView {
  exceptions: { planId: string; revision: number; targetType: string; openedAt: number | null; deadlineAt: number | null; raisedBy: string; note: string; escrowPoints: number; reservation: { kind: string; amount: number; status: string } | null; benefitIssued: boolean; membersMasked: string[] }[];
  trustDisputes: { disputeId: string; promiseId: string; raisedBy: string; note: string; createdAt: number; promiseContent: string; subjectUserId: string | null; subjects: { userId: string; raw: string; current: string }[] }[];
  asOf: number;
}
interface Approval { id: string; type: string; summary: string; targetId: string | null; status: string; proposerName: string; createdAt: number; approverName: string | null; rejectReason: string | null }

const claimStatusBadge = (status: string) =>
  status === "submitted" ? <span className="ops-badge warn">待审核</span>
    : status === "need_more" ? <span className="ops-badge warn">补正期</span>
      : status === "approved" ? <span className="ops-badge ok">已通过</span>
        : status === "rejected" ? <span className="ops-badge bad">不通过</span>
          : <span className="ops-badge mut">{status}</span>;
const anchorBadge = (status: string) =>
  status === "confirmed" ? <span className="ops-badge ok">链上已核验</span>
    : status === "failed" || status === "reorged" ? <span className="ops-badge bad">失败</span>
      : status === "unconfigured" ? <span className="ops-badge mut">未连接真实链</span>
        : <span className="ops-badge warn">{status === "queued" ? "排队中" : "已提交"}</span>;

export default function AdminWorkbenchPage() {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [sessionChecked, setSessionChecked] = useState(false);
  const [section, setSection] = useState<Section>("overview");
  const [error, setError] = useState("");
  const [flash, setFlash] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    opsGet<SessionInfo>("session").then(setSession).catch(() => setSession(null)).finally(() => setSessionChecked(true));
  }, []);
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(""), 4000);
    return () => clearTimeout(t);
  }, [flash]);

  const act = useCallback(async (fn: () => Promise<unknown>, okMessage?: string): Promise<boolean> => {
    setBusy(true); setError("");
    try {
      await fn();
      if (okMessage) setFlash(okMessage);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作失败");
      return false;
    } finally { setBusy(false); }
  }, []);

  if (!sessionChecked) return <main className="admin-shell"><div style={{ margin: "auto", color: "#8B7A83" }}>正在连接维护后台……</div></main>;
  if (!session) return <LoginGate onLogin={setSession} />;
  if (!session.permissions.includes("overview.read") && !session.permissions.includes("system.read")) {
    return <main className="admin-shell"><div className="admin-login"><h1>权限不足</h1><p>该账号没有任何后台读取权限。</p></div></main>;
  }

  return <main className="admin-shell">
    <Sidebar session={session} section={section} onSection={setSection} onLogout={async () => {
      await opsPost("logout").catch(() => undefined);
      setSession(null);
    }} />
    <div className="admin-main">
      {error && <div className="ops-error"><span>{error}</span><button className="ops-btn ghost sm" onClick={() => setError("")}>收起</button></div>}
      {flash && <div className="ops-ok">{flash}</div>}
      {section === "overview" && <OverviewPanel session={session} onSection={setSection} act={act} busy={busy} />}
      {section === "claims" && <ClaimsPanel session={session} act={act} busy={busy} />}
      {section === "safety" && <SafetyPanel session={session} act={act} busy={busy} />}
      {section === "cases" && <CasesPanel act={act} busy={busy} />}
      {section === "users" && <UsersPanel />}
      {section === "rewards" && <RewardsPanel session={session} act={act} busy={busy} />}
      {section === "anchors" && <AnchorsPanel session={session} act={act} busy={busy} />}
      {section === "system" && <SystemPanel session={session} act={act} busy={busy} />}
      <p style={{ color: "#B0A2A8", fontSize: 11, marginTop: 28 }}>
        演示边界：内存仓库（重启清空）；核验材料全部为演示材料；preview 存证未连接真实链；Postgres 持久化与正式管理员账号体系（设计 M3）未在本轮实现。
      </p>
    </div>
  </main>;
}

function LoginGate({ onLogin }: { onLogin: (s: SessionInfo) => void }) {
  const [username, setUsername] = useState("owner");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return <main className="admin-shell">
    <div className="admin-login">
      <img src="/visuals/heartbell/logo-primary.png" alt="" width={40} height={40} />
      <h1>心动铃铛 · 维护工作台</h1>
      <p style={{ color: "#8B7A83", fontSize: 12, margin: "4px 0 14px" }}>与用户端共用同一业务数据；所有操作记录审计。演示环境测试账号见下方说明。</p>
      <label className="ops-field" htmlFor="ops-user">账号</label>
      <input id="ops-user" className="ops-input" value={username} onChange={e => setUsername(e.target.value)} autoComplete="username" />
      <label className="ops-field" htmlFor="ops-pass">密码</label>
      <input id="ops-pass" className="ops-input" type="password" value={password} onChange={e => setPassword(e.target.value)} onKeyDown={e => { if (e.key === "Enter") void submit(); }} autoComplete="current-password" />
      {error && <div className="ops-error" style={{ marginTop: 10 }}><span>{error}</span></div>}
      <button className="ops-btn" style={{ width: "100%", marginTop: 16 }} disabled={busy} onClick={submit}>{busy ? "登录中…" : "登录"}</button>
      <div className="hint">
        演示测试账号（仅 APP_MODE=demo 有效）：<br />
        <b>owner</b> / heartbell-owner —— 负责人（全模块）<br />
        <b>owner2</b> / heartbell-owner2 —— 负责人（双人审批第二人）<br />
        <b>reviewer</b> / heartbell-reviewer —— 审核（核验/复核/例外与库存审批）<br />
        正式环境必须由服务器工具引导真实账号，登录页不内置生产密码。
      </div>
    </div>
  </main>;
  async function submit() {
    setBusy(true); setError("");
    try {
      const data = await opsPost<SessionInfo & { roles: string[] }>("login", { username, password });
      onLogin({ actor: data.actor, username, roles: data.roles, permissions: data.permissions });
    } catch (e) {
      setError(e instanceof Error ? e.message : "登录失败");
    } finally { setBusy(false); }
  }
}

function Sidebar({ session, section, onSection, onLogout }: {
  session: SessionInfo; section: Section; onSection: (s: Section) => void; onLogout: () => void;
}) {
  const [claimsPending, setClaimsPending] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => opsGet<{ items: ClaimRow[] }>("claims?status=submitted")
      .then(d => { if (alive) setClaimsPending(d.items.length); }).catch(() => undefined);
    load();
    const t = setInterval(load, 5000);
    return () => { alive = false; clearInterval(t); };
  }, [section]);
  return <aside className="admin-side">
    <div className="side-brand">
      <img src="/visuals/heartbell/logo-primary.png" alt="心动铃铛" />
      <div><b>维护工作台</b><small>HEARTBELL OPS · v2.5</small></div>
    </div>
    {sections.map(s => (
      <button key={s.id} className={`nav ${section === s.id ? "active" : ""}`} onClick={() => onSection(s.id)}>
        {s.text}
        {s.id === "claims" && claimsPending ? <span className="count">{claimsPending}</span> : null}
      </button>
    ))}
    <div className="side-foot">
      <div>{session.actor}<br /><small>{session.roles.join(" / ")}</small></div>
      <a href="/demo/admin" target="_blank" rel="noopener noreferrer">演示审核台 ↗</a>
      <a href="/">返回演示入口</a>
      <button onClick={onLogout}>退出登录</button>
    </div>
  </aside>;
}

type Act = (fn: () => Promise<unknown>, okMessage?: string) => Promise<boolean>;

// ---------- 运行总览 ----------
function OverviewPanel({ session, onSection, act, busy }: { session: SessionInfo; onSection: (s: Section) => void; act: Act; busy: boolean }) {
  const [data, setData] = useState<Overview | null>(null);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () => Promise.all([
      opsGet<Overview>("overview"),
      opsGet<Approval[]>("approvals"),
    ]).then(([o, a]) => { if (alive) { setData(o); setApprovals(a); } }).catch(() => undefined);
    load();
    const t = setInterval(load, 5000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  if (!data) return <p style={{ color: "#8B7A83" }}>加载中……</p>;
  const m = data.metrics;
  const canApprove = session.permissions.includes("approvals.approve");
  return <>
    <div className="topbar"><h1>运行总览</h1><span style={{ color: "#8B7A83", fontSize: 11.5 }}>asOf {zhTime(data.asOf)}</span></div>
    <p className="subline">{data.dataOrigin}</p>
    <div className="admin-metrics">
      <button className="admin-metric" onClick={() => onSection("claims")}><b>{m.pendingClaims}</b><span>待核验申请</span><small>待用户补正 {m.needMoreClaims} 项单独统计</small></button>
      <button className="admin-metric" onClick={() => onSection("cases")}><b>{m.exceptionReviews}</b><span>例外复核</span><small>30 天未结论退回本金</small></button>
      <button className="admin-metric" onClick={() => onSection("anchors")}><b>{m.failedAnchors}</b><span>失败存证任务</span><small>未连接真实链 {m.unconfiguredAnchors} 项（不计为失败）</small></button>
      <button className="admin-metric" onClick={() => onSection("rewards")}><b>{m.availableRose}</b><span>可用玫瑰券（张）</span><small>账面 − 已预留</small></button>
    </div>
    <div className="admin-panel">
      <h3>待办（按临近时限排序）</h3>
      <p className="panel-sub">来源、负责人、时限与用户影响；点击对应模块处理。</p>
      {data.tasks.length === 0 ? <p style={{ color: "#8B7A83", fontSize: 12 }}>当前没有待办。</p> : <table className="ops-table">
        <thead><tr><th>来源</th><th>对象</th><th>负责人</th><th>时限</th><th>用户影响</th></tr></thead>
        <tbody>{data.tasks.map(t => <tr key={t.source + t.targetId}>
          <td>{t.source}</td><td className="mono-xs">{t.targetId}</td><td>{t.owner}</td><td>{zhTime(t.deadlineAt)}</td><td>{t.impact}</td>
        </tr>)}</tbody>
      </table>}
    </div>
    {canApprove && approvals.filter(a => a.status === "pending").length > 0 && <ApprovalList approvals={approvals} act={act} busy={busy} title="等待第二人批准" />}
    <div className="admin-runbar">
      <span>应用模式 <b>{data.health.appMode}</b></span>
      <span>数据存储 <b>{data.health.storage}</b></span>
      <span>最近清扫 <b>{zhTime(data.health.lastSweepAt)}</b></span>
      <span>待批准 <b>{data.health.pendingApprovals}</b></span>
      <span>功能配置版本 <b>v{data.health.configVersion}</b></span>
      <span>虚拟业务时间 <b>{zhTime(data.health.virtualNow)}</b></span>
    </div>
  </>;
}

function ApprovalList({ approvals, act, busy, title }: { approvals: Approval[]; act: Act; busy: boolean; title: string }) {
  const [list, setList] = useState(approvals);
  useEffect(() => setList(approvals), [approvals]);
  const refresh = useCallback(() => {
    opsGet<Approval[]>("approvals").then(setList).catch(() => undefined);
  }, []);
  const pending = list.filter(a => a.status === "pending");
  if (pending.length === 0) return null;
  return <div className="admin-panel">
    <h3>{title}</h3>
    <p className="panel-sub">双人审批：申请人不能批准自己的操作；批准后立即执行并记入审计。</p>
    {pending.map(a => <div className="ops-approval" key={a.id}>
      <div className="row">
        <span><b>{a.summary}</b><br />
          <small style={{ color: "#8B7A83" }}>申请人 {a.proposerName} · {zhTime(a.createdAt)} · {a.type}</small></span>
        <span className="ops-actions">
          <button className="ops-btn sm" disabled={busy} onClick={() => act(async () => { await opsPost(`approvals/${a.id}/approve`); refresh(); }, "已批准并执行")}>批准执行</button>
          <button className="ops-btn ghost sm" disabled={busy} onClick={() => act(async () => { await opsPost(`approvals/${a.id}/reject`, { reason: "复核后驳回" }); refresh(); }, "已驳回")}>驳回</button>
        </span>
      </div>
    </div>)}
  </div>;
}

// ---------- 核验工作台 ----------
const reasonCodes = ["MATERIAL_COMPLETE", "MISSING_TARGET_DATE", "MATERIAL Unclear", "RULE_VIOLATION", "DEMO_FLOW"];
function ClaimsPanel({ session, act, busy }: { session: SessionInfo; act: Act; busy: boolean }) {
  const [filter, setFilter] = useState<"submitted" | "need_more" | "all">("submitted");
  const [rows, setRows] = useState<ClaimRow[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<ClaimDetail | null>(null);
  const [decision, setDecision] = useState<"approve" | "need_more" | "reject">("approve");
  const [reasonCode, setReasonCode] = useState("MATERIAL_COMPLETE");
  const [note, setNote] = useState("");
  const detailRef = useRef<string | null>(null);

  const loadList = useCallback(() => {
    opsGet<{ items: ClaimRow[] }>(`claims?status=${filter}`).then(d => setRows(d.items)).catch(() => undefined);
  }, [filter]);
  const loadDetail = useCallback((id: string) => {
    opsGet<ClaimDetail>(`claims/${id}`).then(setDetail).catch(() => setDetail(null));
  }, []);
  useEffect(() => { loadList(); const t = setInterval(loadList, 5000); return () => clearInterval(t); }, [loadList]);
  useEffect(() => {
    if (selected && detailRef.current !== selected) { detailRef.current = selected; loadDetail(selected); }
  }, [selected, loadDetail]);
  useEffect(() => { if (detail && selected === detail.id) { const t = setInterval(() => loadDetail(detail.id), 5000); return () => clearInterval(t); } }, [detail, selected, loadDetail]);

  const canDecide = session.permissions.includes("claims.decide");
  const mineLocked = detail?.assignedTo && detail.assignedTo !== "me" && detail.assignedTo.length > 0;
  return <>
    <div className="topbar"><h1>核验工作台</h1></div>
    <p className="subline">左侧申请队列、右侧详情；领取工单后才能处理。未领取、非被指派人、旧版本、已终结状态服务端均拒绝写入。</p>
    <div className="ops-tabs">
      {([["submitted", "待审核"], ["need_more", "补正期"], ["all", "全部"]] as const).map(([id, label]) => (
        <button key={id} className={filter === id ? "active" : ""} onClick={() => setFilter(id)}>{label}</button>
      ))}
    </div>
    <div className="admin-grid2">
      <div>
        {rows.length === 0 && <div className="admin-panel"><p style={{ color: "#8B7A83", fontSize: 12 }}>该筛选下没有申请。</p></div>}
        {rows.map(c => <div key={c.id} className={`ops-queue-item ${selected === c.id ? "selected" : ""}`} onClick={() => setSelected(c.id)}>
          <div className="row1"><span className="mono-xs">{c.id}</span>{claimStatusBadge(c.status)}</div>
          <small>{c.targetType} · 成员 {c.membersMasked.join(" / ")}<br />
            提交 {zhDate(c.submittedAt)} · 时限 {zhDate(c.reviewDeadlineAt)}<br />
            受理 {c.assignedTo ?? "未领取"} · rev {c.revision}</small>
        </div>)}
      </div>
      <div>
        {!detail ? <div className="admin-panel"><p style={{ color: "#8B7A83", fontSize: 12 }}>选择左侧申请查看详情（材料历史 / 规则核对 / 操作记录）。</p></div> : <>
          <div className="admin-panel">
            <h3>{detail.id} {claimStatusBadge(detail.status)}</h3>
            <p className="panel-sub">用户端结果预览：决定后 A/B 相守页在下一次刷新（约 3 秒内）看到同一结论。</p>
            <div className="ops-detail-row"><b>目标类型</b><span>{detail.targetType}</span></div>
            <div className="ops-detail-row"><b>计划状态</b><span>{detail.plan.statusLabel} · rev {detail.plan.revision}</span></div>
            <div className="ops-detail-row"><b>目标发生</b><span>{zhDate(detail.targetOccurredAt)}（冷静期结束 {zhDate(detail.plan.coolingUntil)} · 到期 {zhDate(detail.plan.expiresAt)}）</span></div>
            <div className="ops-detail-row"><b>材料来源</b><span>演示材料（非真实证件，isDemoMaterial）</span></div>
            <div className="ops-detail-row"><b>提交/到期</b><span>{zhTime(detail.submittedAt)} → 审核时限 {zhTime(detail.reviewDeadlineAt)}</span></div>
            <div className="ops-detail-row"><b>受理人</b><span>{detail.assignedTo ?? "未领取"}</span></div>
            {detail.appealUntil && <div className="ops-detail-row"><b>争议期至</b><span>{zhTime(detail.appealUntil)}</span></div>}
            {detail.lastSupplementAt && <div className="ops-detail-row"><b>最近补正</b><span>{zhTime(detail.lastSupplementAt)}</span></div>}
          </div>
          <div className="admin-panel">
            <h3>申请材料（只追加）</h3>
            {detail.materials.map(m => <div className="ops-detail-row" key={m.index}>
              <b>{m.source === "initial" ? "初始材料" : `补正 v${m.index}`}</b>
              <span>{m.note}<br /><small style={{ color: "#8B7A83" }}>{zhTime(m.submittedAt)} · 由用户提交</small></span>
            </div>)}
            <h3 style={{ marginTop: 12 }}>规则核对</h3>
            {detail.ruleChecks.map(r => <div className="ops-detail-row" key={r.item}><b>{r.pass ? "✓" : "×"}</b><span>{r.item}</span></div>)}
            <h3 style={{ marginTop: 12 }}>操作记录</h3>
            {detail.reviewEvents.length === 0 ? <p style={{ color: "#8B7A83", fontSize: 12 }}>尚无审核事件。</p> : detail.reviewEvents.map((e, i) => (
              <div className="ops-detail-row" key={i}><b>{zhTime(e.at)}</b><span>{e.actor} · {e.decision}{e.reasonCode ? ` · ${e.reasonCode}` : ""}{e.note ? `<br />${e.note}` : ""}</span></div>
            ))}
          </div>
          {canDecide && ["submitted", "need_more"].includes(detail.status) && <div className="ops-decisionbar">
            {detail.assignedTo === null && <p style={{ fontSize: 12, color: "#8C5B17", background: "#FBF0DE", borderRadius: 8, padding: "6px 10px" }}>工单未领取：先「领取工单」再处理。</p>}
            {mineLocked && <p style={{ fontSize: 12, color: "#B94360" }}>该工单已由其他管理员受理，你不能处理。</p>}
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              {detail.assignedTo === null && <button className="ops-btn plum sm" disabled={busy}
                onClick={() => act(async () => { await opsPost(`claims/${detail.id}/assign`, { assigneeId: "me" }); detailRef.current = null; setSelected(detail.id); }, "已领取工单")}>领取工单</button>}
              <span style={{ fontSize: 11.5, color: "#8B7A83" }}>expectedClaimRevision {detail.revision} · expectedPlanRevision {detail.plan.revision}</span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 10 }}>
              <div>
                <label className="ops-field">审核决定</label>
                <select className="ops-input" value={decision} onChange={e => setDecision(e.target.value as typeof decision)}>
                  <option value="approve">通过（进入 7 天争议期）</option>
                  <option value="need_more">补充材料（补正期 14 天）</option>
                  <option value="reject">不通过（计划回到进行中）</option>
                </select>
              </div>
              <div>
                <label className="ops-field">原因码</label>
                <input className="ops-input" value={reasonCode} maxLength={40} onChange={e => setReasonCode(e.target.value)} />
              </div>
            </div>
            <label className="ops-field">审核说明（补正必填缺失项）</label>
            <textarea className="ops-input" maxLength={200} value={note} onChange={e => setNote(e.target.value)} placeholder="例如：请补充目标发生日期的说明。" />
            <div className="ops-actions">
              <button className="ops-btn" disabled={busy || detail.assignedTo === null || !!mineLocked || (decision === "need_more" && !note.trim())}
                onClick={() => act(async () => {
                  await opsPost(`claims/${detail.id}/decision`, {
                    decision, reasonCode, note: note.trim() || null,
                    expectedClaimRevision: detail.revision,
                    expectedPlanRevision: detail.plan.revision,
                  });
                  setNote("");
                  loadDetail(detail.id);
                  loadList();
                }, "审核决定已保存，双方已收到站内通知")}>提交决定</button>
            </div>
          </div>}
        </>}
      </div>
    </div>
  </>;
}

// ---------- 安全工单（v2.6） ----------
interface SafetyReportRow {
  id: string; reason: string; reasonLabel: string; status: string; statusLabel: string;
  descriptionExcerpt: string; createdAt: number; updatedAt: number; assigned: boolean; hasAppeal: boolean;
}
interface SafetyReportDetail extends SafetyReportRow {
  targetLabel: string; description: string; revision: number;
  supplements: { at: number; text: string }[];
  events: { at: number; label: string }[];
  userResult: { at: number; userMessage: string } | null;
  appeal: { reason: string; requestedAt: number; decidedAt: number | null; userMessage: string | null } | null;
  internal: { assignedTo: string | null; decisions: { at: number; reviewerName: string; decision: string; userMessage: string; internalReason: string | null }[] };
}
function SafetyPanel({ session, act, busy }: { session: SessionInfo; act: Act; busy: boolean }) {
  const [filter, setFilter] = useState<"submitted" | "in_review" | "awaiting_supplement" | "appeal_requested" | "all">("submitted");
  const [rows, setRows] = useState<SafetyReportRow[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<SafetyReportDetail | null>(null);
  const [decision, setDecision] = useState<"resolved" | "rejected" | "need_supplement">("resolved");
  const [userMessage, setUserMessage] = useState("");
  const [internalReason, setInternalReason] = useState("");
  const [restrictDays, setRestrictDays] = useState(7);

  const canRead = session.permissions.includes("safety.read");
  const canAssign = session.permissions.includes("safety.assign");
  const canDecide = session.permissions.includes("safety.decide");
  const canAppeal = session.permissions.includes("safety.appeal");
  const canRestrict = session.permissions.includes("safety.restrict");

  const loadList = useCallback(() => {
    opsGet<{ items: SafetyReportRow[] }>(`safety/reports${filter === "all" ? "" : `?status=${filter}`}`)
      .then(d => setRows(Array.isArray(d) ? d : (d as { items: SafetyReportRow[] }).items))
      .catch(() => undefined);
  }, [filter]);
  const loadDetail = useCallback((id: string) => {
    opsGet<SafetyReportDetail>(`safety/reports/${id}`).then(setDetail).catch(() => setDetail(null));
  }, []);
  useEffect(() => { if (!canRead) return; loadList(); const t = setInterval(loadList, 5000); return () => clearInterval(t); }, [loadList, canRead]);
  useEffect(() => { if (selected) loadDetail(selected); }, [selected, loadDetail]);

  if (!canRead) return <>
    <div className="topbar"><h1>安全工单</h1></div>
    <div className="admin-panel"><p style={{ color: "#8B7A83", fontSize: 12 }}>当前角色没有 safety.read 权限，服务端拒绝读取举报队列。</p></div>
  </>;

  const statusBadge = (status: string) =>
    status === "resolved" ? <span className="ops-badge ok">已处理</span>
      : status === "rejected" ? <span className="ops-badge bad">暂无法处理</span>
        : status === "withdrawn" ? <span className="ops-badge mut">已撤回</span>
          : status === "appeal_requested" ? <span className="ops-badge warn">复核中</span>
            : <span className="ops-badge warn">{status === "submitted" ? "待领取" : status === "awaiting_supplement" ? "待补充" : "处理中"}</span>;

  return <>
    <div className="topbar"><h1>安全工单</h1></div>
    <p className="subline">队列脱敏（不含举报人/被举报者身份）；领取后才能读取案内材料并裁定，敏感读取已留痕。复核必须由不同审核员处理。</p>
    <div className="ops-tabs">
      {([["submitted", "待领取"], ["in_review", "处理中"], ["awaiting_supplement", "待补充"], ["appeal_requested", "待复核"], ["all", "全部"]] as const).map(([id, label]) => (
        <button key={id} className={filter === id ? "active" : ""} onClick={() => setFilter(id)}>{label}</button>
      ))}
    </div>
    <div className="admin-grid2">
      <div>
        {rows.length === 0 && <div className="admin-panel"><p style={{ color: "#8B7A83", fontSize: 12 }}>该筛选下没有工单。</p></div>}
        {rows.map(r => <div key={r.id} className={`ops-queue-item ${selected === r.id ? "selected" : ""}`} onClick={() => setSelected(r.id)}>
          <div className="row1"><span className="mono-xs">{r.id}</span>{statusBadge(r.status)}</div>
          <small>{r.reasonLabel} · {r.descriptionExcerpt}…<br />
            提交 {zhDate(r.createdAt)} · {r.assigned ? "已领取" : "未领取"}{r.hasAppeal ? " · 待复核" : ""}</small>
        </div>)}
      </div>
      <div>
        {!selected || !detail ? <div className="admin-panel"><p style={{ color: "#8B7A83", fontSize: 12 }}>选择左侧工单查看材料（仅被指派审核员/主管可读）。</p></div> : <>
          <div className="admin-panel">
            <h3>{detail.id} {statusBadge(detail.status)}</h3>
            <div className="ops-detail-row"><b>原因</b><span>{detail.reasonLabel}</span></div>
            <div className="ops-detail-row"><b>对象（脱敏）</b><span>{detail.targetLabel}</span></div>
            <div className="ops-detail-row"><b>举报说明</b><span>{detail.description}</span></div>
            <div className="ops-detail-row"><b>受理人</b><span>{detail.internal.assignedTo ?? "未领取"}</span></div>
            <div className="ops-detail-row"><b>版本</b><span>rev {detail.revision}</span></div>
            {detail.supplements.length > 0 && <>
              <h3 style={{ marginTop: 12 }}>用户补充</h3>
              {detail.supplements.map((s, i) => (
                <div className="ops-detail-row" key={i}><b>{zhTime(s.at)}</b><span>{s.text}</span></div>
              ))}
            </>}
            {detail.internal.decisions.length > 0 && <>
              <h3 style={{ marginTop: 12 }}>裁定历史（内部意见不出用户端）</h3>
              {detail.internal.decisions.map((d, i) => (
                <div className="ops-detail-row" key={i}><b>{zhTime(d.at)}</b>
                  <span>{d.reviewerName} · {d.decision}<br />用户可见：{d.userMessage}{d.internalReason ? <><br />内部：{d.internalReason}</> : null}</span></div>
              ))}
            </>}
          </div>
          {canAssign && !detail.internal.assignedTo && ["submitted", "appeal_requested"].includes(detail.status) && <div className="ops-decisionbar">
            <button className="ops-btn plum sm" disabled={busy}
              onClick={() => act(async () => { await opsPost(`safety/reports/${detail.id}/assign`); loadDetail(detail.id); loadList(); }, "已领取工单")}>领取工单</button>
          </div>}
          {canDecide && detail.internal.assignedTo && ["in_review", "awaiting_supplement"].includes(detail.status) && <div className="ops-decisionbar">
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <div>
                <label className="ops-field">裁定</label>
                <select className="ops-input" value={decision} onChange={e => setDecision(e.target.value as typeof decision)}>
                  <option value="resolved">已处理（用户可见结论）</option>
                  <option value="rejected">暂无法处理</option>
                  <option value="need_supplement">要求用户补充</option>
                </select>
              </div>
              <div>
                <label className="ops-field">限时限制（主管批准后生效）</label>
                <select className="ops-input" value={restrictDays} onChange={e => setRestrictDays(Number(e.target.value))} disabled={!canRestrict}>
                  <option value={0}>不限制</option>
                  <option value={3}>限制摇铃/发现 3 天</option>
                  <option value={7}>限制摇铃/发现 7 天</option>
                  <option value={30}>限制摇铃/发现 30 天</option>
                </select>
              </div>
            </div>
            <label className="ops-field">用户可见结果（5–200 字）</label>
            <textarea className="ops-input" maxLength={200} value={userMessage} onChange={e => setUserMessage(e.target.value)} placeholder="例如：已核实并已对相关账号做出处理。" />
            <label className="ops-field">内部意见（仅运营可见，补充要求必填）</label>
            <textarea className="ops-input" maxLength={500} value={internalReason} onChange={e => setInternalReason(e.target.value)} />
            <div className="ops-actions">
              <button className="ops-btn" disabled={busy || userMessage.trim().length < 5 || (decision === "need_supplement" && !internalReason.trim())}
                onClick={() => act(async () => {
                  await opsPost(`safety/reports/${detail.id}/decisions`, {
                    decision, userMessage: userMessage.trim(), internalReason: internalReason.trim() || null,
                    expectedRevision: detail.revision,
                  });
                  if (canRestrict && restrictDays > 0 && decision === "resolved") {
                    await opsPost("safety/restrictions", { reportId: detail.id, scope: "ring", days: restrictDays });
                  }
                  setUserMessage(""); setInternalReason("");
                  loadDetail(detail.id); loadList();
                }, "裁定已保存，用户已收到站内通知")}>提交裁定</button>
            </div>
          </div>}
          {canAppeal && detail.status === "appeal_requested" && detail.appeal && !detail.appeal.decidedAt && <div className="ops-decisionbar">
            <p className="panel-sub">复核理由：{detail.appeal.reason}。复核必须由非原审核员处理（服务端回避校验）。</p>
            <label className="ops-field">复核结论（用户可见）</label>
            <textarea className="ops-input" maxLength={200} value={userMessage} onChange={e => setUserMessage(e.target.value)} />
            <div className="ops-actions">
              <button className="ops-btn" disabled={busy || userMessage.trim().length < 5}
                onClick={() => act(async () => {
                  await opsPost(`safety/reports/${detail.id}/appeal-decision`, {
                    decision: "resolved", userMessage: userMessage.trim(),
                    internalReason: internalReason.trim() || null,
                  });
                  setUserMessage(""); loadDetail(detail.id); loadList();
                }, "复核结论已送达用户")}>维持/改判（已处理）</button>
              <button className="ops-btn ghost" disabled={busy || userMessage.trim().length < 5}
                onClick={() => act(async () => {
                  await opsPost(`safety/reports/${detail.id}/appeal-decision`, {
                    decision: "rejected", userMessage: userMessage.trim(),
                    internalReason: internalReason.trim() || null,
                  });
                  setUserMessage(""); loadDetail(detail.id); loadList();
                }, "复核结论已送达用户")}>暂无法处理</button>
            </div>
          </div>}
        </>}
      </div>
    </div>
  </>;
}

// ---------- 例外与申诉 ----------
function CasesPanel({ act, busy }: { act: Act; busy: boolean }) {
  const [tab, setTab] = useState<"exception" | "trust">("exception");
  const [data, setData] = useState<CasesView | null>(null);
  const [reason, setReason] = useState("");
  const [subjectChoice, setSubjectChoice] = useState<Record<string, string>>({});
  const load = useCallback(() => { opsGet<CasesView>("cases").then(setData).catch(() => undefined); }, []);
  useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, [load]);
  if (!data) return <p style={{ color: "#8B7A83" }}>加载中……</p>;
  return <>
    <div className="topbar"><h1>例外与申诉</h1></div>
    <p className="subline">计划例外：退款 / 维持失效需第二名管理员批准后执行；返回核验直接执行（必须有可继续审核的申请）。履约争议按单一责任人定向裁定。</p>
    <div className="ops-tabs">
      <button className={tab === "exception" ? "active" : ""} onClick={() => setTab("exception")}>计划例外（{data.exceptions.length}）</button>
      <button className={tab === "trust" ? "active" : ""} onClick={() => setTab("trust")}>履约争议（{data.trustDisputes.length}）</button>
    </div>
    {tab === "exception" && (data.exceptions.length === 0
      ? <div className="admin-panel"><p style={{ color: "#8B7A83", fontSize: 12 }}>暂无例外复核中的计划。</p></div>
      : data.exceptions.map(e => <div className="admin-panel" key={e.planId}>
        <h3>{e.planId} {e.targetType === "marriage" ? "登记结婚（演示核验）" : "周年目标"}</h3>
        <div className="ops-detail-row"><b>进入例外</b><span>{zhTime(e.openedAt)} · 期限 {zhTime(e.deadlineAt)}（超 30 天按平台无法履约取消并退款）</span></div>
        <div className="ops-detail-row"><b>发起方</b><span>{e.raisedBy} · {e.note}</span></div>
        <div className="ops-detail-row"><b>投入余额</b><span>{e.escrowPoints} 演示点（托管中）</span></div>
        <div className="ops-detail-row"><b>奖励预留</b><span>{e.reservation ? `${e.reservation.kind === "points" ? `${e.reservation.amount} 点` : `${e.reservation.amount} 张券`} · ${e.reservation.status}` : "无"}</span></div>
        <div className="ops-detail-row"><b>权益已发放</b><span>{e.benefitIssued ? "是（结算只执行一次）" : "否"}</span></div>
        <label className="ops-field">复核理由（≥4 字，进入审批与审计）</label>
        <input className="ops-input" value={reason} onChange={ev => setReason(ev.target.value)} placeholder="例如：核对时间线后确认目标发生在退出前" />
        <div className="ops-actions">
          <button className="ops-btn" disabled={busy || reason.trim().length < 4}
            onClick={() => act(async () => { await opsPost(`exceptions/${e.planId}/resolution-requests`, { decision: "refund", reason, expectedPlanRevision: e.revision }); setReason(""); load(); }, "已提交「例外退款」审批，等待第二人批准")}>例外退款（双人审批）</button>
          <button className="ops-btn plum" disabled={busy || reason.trim().length < 4}
            onClick={() => act(async () => { await opsPost(`exceptions/${e.planId}/resolution-requests`, { decision: "forfeit", reason, expectedPlanRevision: e.revision }); setReason(""); load(); }, "已提交「维持失效」审批，等待第二人批准")}>维持失效（双人审批）</button>
          <button className="ops-btn ghost" disabled={busy || reason.trim().length < 4}
            onClick={() => act(async () => { await opsPost(`exceptions/${e.planId}/resolution-requests`, { decision: "back_to_review", reason, expectedPlanRevision: e.revision }); setReason(""); load(); }, "已返回核验并重置审核期限")}>返回核验</button>
        </div>
      </div>))}
    {tab === "trust" && (data.trustDisputes.length === 0
      ? <div className="admin-panel"><p style={{ color: "#8B7A83", fontSize: 12 }}>暂无未决履约争议。</p></div>
      : data.trustDisputes.map(d => <div className="admin-panel" key={d.disputeId}>
        <h3>{d.promiseContent}</h3>
        <div className="ops-detail-row"><b>争议</b><span>{d.note}</span></div>
        <div className="ops-detail-row"><b>发起方</b><span>{d.raisedBy} · {zhTime(d.createdAt)}</span></div>
        <div className="ops-detail-row"><b>责任人当前结果</b>
          <span>{d.subjects.map(s => `${s.userId}：${s.current}`).join("；") || "—"}</span></div>
        {d.subjects.length > 0 && <>
          <label className="ops-field">裁定对象（责任人）</label>
          <select className="ops-input" value={subjectChoice[d.disputeId] ?? d.subjectUserId ?? d.subjects[0].raw}
            onChange={ev => setSubjectChoice({ ...subjectChoice, [d.disputeId]: ev.target.value })}>
            {d.subjects.map(s => <option key={s.raw} value={s.raw}>{s.userId}（当前 {s.current}）</option>)}
          </select>
          <div className="ops-actions">
            <button className="ops-btn" disabled={busy} onClick={() => act(async () => {
              await opsPost(`trust-disputes/${d.disputeId}/resolve`, { subjectUserId: subjectChoice[d.disputeId] ?? d.subjectUserId ?? d.subjects[0].raw, finalResult: "fulfilled", reason: "复核认定已履行" });
              load();
            }, "已按责任人定向裁定：已履行")}>认定已履行</button>
            <button className="ops-btn plum" disabled={busy} onClick={() => act(async () => {
              await opsPost(`trust-disputes/${d.disputeId}/resolve`, { subjectUserId: subjectChoice[d.disputeId] ?? d.subjectUserId ?? d.subjects[0].raw, finalResult: "unfulfilled", reason: "复核认定未履行" });
              load();
            }, "已按责任人定向裁定：未履行")}>认定未履行</button>
            <button className="ops-btn ghost" disabled={busy} onClick={() => act(async () => {
              await opsPost(`trust-disputes/${d.disputeId}/resolve`, { subjectUserId: subjectChoice[d.disputeId] ?? d.subjectUserId ?? d.subjects[0].raw, finalResult: "waived", reason: "双方同意豁免" });
              load();
            }, "已豁免该项承诺")}>一起豁免</button>
          </div>
        </>}
        <p className="panel-sub" style={{ marginTop: 8 }}>裁定只影响被复核的责任人：履约摘要仅刷新该用户的新版本，另一方结果不变；复核结论生成结算存证 v3。</p>
      </div>))}
  </>;
}

// ---------- 用户与关系 ----------
function UsersPanel() {
  const [users, setUsers] = useState<unknown[] | null>(null);
  const [rels, setRels] = useState<unknown[] | null>(null);
  useEffect(() => {
    const load = () => {
      opsGet<unknown[]>("users").then(setUsers).catch(() => undefined);
      opsGet<unknown[]>("relationships").then(setRels).catch(() => undefined);
    };
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);
  const u = (users ?? []) as { userId: string; adultDeclared: boolean; accountStatus: string; radar: { active: boolean; expiresAt: number | null }; relationshipStatus: string; planStatus: string; activeGrants: number; lastFaultJobId: string | null }[];
  const r = (rels ?? []) as { id: string; status: string; membersMasked: string[]; startedAt: number | null; endedAt: number | null; plan: { id: string; statusLabel: string } | null; diaryCount: number; promiseCount: number }[];
  return <>
    <div className="topbar"><h1>用户与关系</h1></div>
    <p className="subline">只读排障：仅脱敏标识与状态。性取向、联系方式、日记正文、salt 与钱包签名不进入后台 DTO；后台不能代用户确认或重建关系。</p>
    <div className="admin-panel">
      <h3>用户（演示）</h3>
      <table className="ops-table">
        <thead><tr><th>用户</th><th>成年声明</th><th>雷达</th><th>关系状态</th><th>计划状态</th><th>有效授权</th><th>最近故障任务</th></tr></thead>
        <tbody>{u.map(x => <tr key={x.userId}>
          <td className="mono-xs">{x.userId}</td>
          <td>{x.adultDeclared ? <span className="ops-badge ok">已声明</span> : <span className="ops-badge mut">未声明</span>}</td>
          <td>{x.radar.active ? `开启中（至 ${zhTime(x.radar.expiresAt)}）` : "关闭"}</td>
          <td>{x.relationshipStatus}</td>
          <td>{x.planStatus}</td>
          <td>{x.activeGrants}</td>
          <td className="mono-xs">{x.lastFaultJobId ?? "—"}</td>
        </tr>)}</tbody>
      </table>
    </div>
    <div className="admin-panel">
      <h3>关系</h3>
      <table className="ops-table">
        <thead><tr><th>关系</th><th>成员</th><th>状态</th><th>开始/结束</th><th>计划</th><th>日记/承诺</th></tr></thead>
        <tbody>{r.map(x => <tr key={x.id}>
          <td className="mono-xs">{x.id}</td>
          <td>{x.membersMasked.join(" / ")}</td>
          <td>{x.status}</td>
          <td>{zhDate(x.startedAt)}{x.endedAt ? ` → ${zhDate(x.endedAt)}` : ""}</td>
          <td>{x.plan ? `${x.plan.statusLabel}` : "—"}</td>
          <td>{x.diaryCount} / {x.promiseCount}</td>
        </tr>)}</tbody>
      </table>
    </div>
  </>;
}

// ---------- 奖励与账本 ----------
function RewardsPanel({ session, act, busy }: { session: SessionInfo; act: Act; busy: boolean }) {
  const [data, setData] = useState<Awaited<ReturnType<typeof loadRewards>> | null>(null);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [unit, setUnit] = useState<"demo-point" | "rose-ticket">("demo-point");
  const [delta, setDelta] = useState("");
  const [reason, setReason] = useState("");
  const loadRewards = () => opsGet<{
    pools: { unit: string; label: string; face: number; reserved: number; available: number }[];
    reservations: { id: string; planId: string; kind: string; amount: number; status: string; createdAt: number }[];
    ledger: { id: string; from: string; to: string; amount: number; unit: string; type: string; businessKey: string; note: string; createdAt: number }[];
    fixedRules: string;
  }>("rewards");
  const load = useCallback(() => {
    loadRewards().then(setData).catch(() => undefined);
    opsGet<Approval[]>("approvals").then(setApprovals).catch(() => undefined);
  }, []);
  useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, [load]);
  if (!data) return <p style={{ color: "#8B7A83" }}>加载中……</p>;
  return <>
    <div className="topbar"><h1>奖励与账本</h1></div>
    <p className="subline">{data.fixedRules}</p>
    <div className="admin-metrics">
      {data.pools.map(p => <div className="admin-metric" key={p.unit}>
        <b>{p.face}</b><span>{p.label} · 账面</span><small>已预留 {p.reserved} · 可用 {p.available}（可用 = 账面 − 预留）</small>
      </div>)}
    </div>
    <div className="admin-panel">
      <h3>预留明细</h3>
      {data.reservations.length === 0 ? <p style={{ color: "#8B7A83", fontSize: 12 }}>暂无预留。</p> : <table className="ops-table">
        <thead><tr><th>预留</th><th>计划</th><th>单位</th><th>数量</th><th>状态</th><th>创建</th></tr></thead>
        <tbody>{data.reservations.map(r => <tr key={r.id}>
          <td className="mono-xs">{r.id}</td><td className="mono-xs">{r.planId}</td>
          <td>{r.kind === "points" ? "演示点数" : "玫瑰券"}</td><td>{r.amount}</td>
          <td>{r.status === "reserved" ? <span className="ops-badge warn">预留中</span> : r.status === "consumed" ? <span className="ops-badge ok">已消费</span> : <span className="ops-badge mut">已释放</span>}</td>
          <td>{zhTime(r.createdAt)}</td>
        </tr>)}</tbody>
      </table>}
      <p className="panel-sub">结算成功的预留为「已消费」；取消/失效才是「已释放」。任一方领取只结算一次，双方各得属于自己的一份。</p>
    </div>
    {session.permissions.includes("inventory.propose") && <div className="admin-panel">
      <h3>库存校正（双人审批）</h3>
      <p className="panel-sub">只能追加调整与对应账项；减少不得低于已预留量；增加来自演示系统发放账户。不能直接改余额或删除历史账项。</p>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 2fr", gap: 10 }}>
        <div>
          <label className="ops-field">单位</label>
          <select className="ops-input" value={unit} onChange={e => setUnit(e.target.value as typeof unit)}>
            <option value="demo-point">演示点数</option>
            <option value="rose-ticket">玫瑰券（张）</option>
          </select>
        </div>
        <div>
          <label className="ops-field">数量（±）</label>
          <input className="ops-input" value={delta} onChange={e => setDelta(e.target.value)} placeholder="如 10 或 -5" />
        </div>
        <div>
          <label className="ops-field">原因（≥4 字）</label>
          <input className="ops-input" value={reason} onChange={e => setReason(e.target.value)} placeholder="原因与凭证引用" />
        </div>
      </div>
      <div className="ops-actions">
        <button className="ops-btn" disabled={busy || !Number.isFinite(Number(delta)) || Number(delta) === 0 || reason.trim().length < 4}
          onClick={() => act(async () => {
            await opsPost("inventory/adjustment-requests", { unit, signedDelta: Number(delta), reason });
            setDelta(""); setReason(""); load();
          }, "库存校正已提交审批，等待第二人批准")}>提交校正申请</button>
      </div>
    </div>}
    {session.permissions.includes("approvals.approve") && <ApprovalList approvals={approvals} act={act} busy={busy} title="等待第二人批准" />}
    <div className="admin-panel">
      <h3>账本（最近 60 条）</h3>
      <table className="ops-table">
        <thead><tr><th>时间</th><th>从</th><th>到</th><th>数量</th><th>类型</th><th>业务键</th><th>说明</th></tr></thead>
        <tbody>{data.ledger.map(e => <tr key={e.id}>
          <td>{zhTime(e.createdAt)}</td><td>{e.from}</td><td>{e.to}</td>
          <td>{e.amount}{e.unit}</td><td>{e.type}</td>
          <td className="mono-xs">{e.businessKey}</td><td>{e.note}</td>
        </tr>)}</tbody>
      </table>
    </div>
  </>;
}

// ---------- 存证任务 ----------
function AnchorsPanel({ session, act, busy }: { session: SessionInfo; act: Act; busy: boolean }) {
  const [jobs, setJobs] = useState<{ jobId: string; recordType: string; recordId: string; contentVersion: number; chainMode: string; status: string; attempts: number; commitment: string; txHash: string | null; blockNumber: number | null; error: string | null; createdAt: number; updatedAt: number }[] | null>(null);
  const load = useCallback(() => { opsGet<typeof jobs>("anchors").then(setJobs).catch(() => undefined); }, []);
  useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, [load]);
  if (!jobs) return <p style={{ color: "#8B7A83" }}>加载中……</p>;
  const canRetry = session.permissions.includes("anchors.retry");
  return <>
    <div className="topbar"><h1>存证任务</h1></div>
    <p className="subline">重试按 jobId + contentVersion 精确定位，保留同一承诺与版本；confirmed 禁止重发；未连接真实链不是失败。</p>
    <div className="admin-panel">
      <table className="ops-table">
        <thead><tr><th>任务</th><th>记录</th><th>版本</th><th>链模式</th><th>状态</th><th>尝试</th><th>更新时间</th><th>操作</th></tr></thead>
        <tbody>{jobs.map(j => <tr key={j.jobId}>
          <td className="mono-xs">{j.jobId}</td>
          <td>{j.recordType}<div className="mono-xs">{j.recordId}</div></td>
          <td>v{j.contentVersion}</td>
          <td>{j.chainMode}</td>
          <td>{anchorBadge(j.status)}{j.error && <div className="mono-xs" style={{ marginTop: 4 }}>{j.error.slice(0, 80)}</div>}</td>
          <td>{j.attempts}</td>
          <td>{zhTime(j.updatedAt)}</td>
          <td>{canRetry && (j.status === "failed" || j.status === "reorged" || j.status === "queued")
            ? <button className="ops-btn sm" disabled={busy} onClick={() => act(async () => {
              await opsPost(`anchors/${j.jobId}/retry`);
              load();
            }, `已重试 ${j.jobId.slice(0, 12)}…（保留同一承诺）`)}>重试</button>
            : <span style={{ color: "#B0A2A8", fontSize: 11 }}>{j.status === "confirmed" ? "已确认" : j.status === "unconfigured" ? "配置缺口" : "—"}</span>}</td>
        </tr>)}</tbody>
      </table>
      <p className="panel-sub">详情可复制 commitment；后台不读取 payloadJson 或 salt。真实链提交为待接入项（CHAIN_MODE 配置后走同一管线）。</p>
    </div>
  </>;
}

// ---------- 运行与审计 ----------
function SystemPanel({ session, act, busy }: { session: SessionInfo; act: Act; busy: boolean }) {
  const [tab, setTab] = useState<"health" | "config" | "audit">("health");
  const [health, setHealth] = useState<Awaited<ReturnType<typeof loadHealth>> | null>(null);
  const [auditItems, setAuditItems] = useState<{ id: string; actorName: string; action: string; targetType: string; targetId: string; detail: string; result: string; createdAt: number }[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [notice, setNotice] = useState("");
  const [flags, setFlags] = useState({ radarNew: true, planNew: true, anchorNew: true });
  const [reason, setReason] = useState("");
  const loadHealth = () => opsGet<{
    appMode: string; chainMode: string; chainConfigured: boolean; writerKeyConfigured: boolean; storage: string;
    lastSweepAt: number | null; anchorQueue: { failed: number; queued: number; unconfigured: number; confirmed: number };
    featureConfig: { version: number; radarNewEnabled: boolean; planNewEnabled: boolean; anchorSubmitEnabled: boolean; maintenanceNotice: string; updatedBy: string | null; updatedAt: number | null };
    virtualNow: number; note: string;
  }>("system/health");
  const load = useCallback(() => {
    loadHealth().then(h => { setHealth(h); setNotice(h.featureConfig.maintenanceNotice); setFlags({ radarNew: h.featureConfig.radarNewEnabled, planNew: h.featureConfig.planNewEnabled, anchorNew: h.featureConfig.anchorSubmitEnabled }); }).catch(() => undefined);
    opsGet<Approval[]>("approvals").then(setApprovals).catch(() => undefined);
    if (session.permissions.includes("audit.read")) {
      opsGet<{ items: typeof auditItems }>("audit").then(d => setAuditItems(d.items)).catch(() => undefined);
    }
  }, [session.permissions]);
  useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, [load]);
  return <>
    <div className="topbar"><h1>运行与审计</h1></div>
    <p className="subline">功能暂停只影响新的提交（雷达/计划/存证）；退出、撤权、申诉与已成立权益处理始终可用。</p>
    <div className="ops-tabs">
      <button className={tab === "health" ? "active" : ""} onClick={() => setTab("health")}>运行状态</button>
      <button className={tab === "config" ? "active" : ""} onClick={() => setTab("config")}>功能与公告</button>
      <button className={tab === "audit" ? "active" : ""} onClick={() => setTab("audit")}>审计日志</button>
    </div>
    {tab === "health" && health && <div className="admin-panel">
      <div className="ops-detail-row"><b>应用模式</b><span>{health.appMode}</span></div>
      <div className="ops-detail-row"><b>链模式</b><span>{health.chainMode} · RPC/合约 {health.chainConfigured ? "已配置" : <span className="ops-badge mut">未配置</span>} · writer 密钥 {health.writerKeyConfigured ? "已配置" : <span className="ops-badge mut">未配置</span>}</span></div>
      <div className="ops-detail-row"><b>数据存储</b><span>{health.storage}</span></div>
      <div className="ops-detail-row"><b>任务队列</b><span>失败 {health.anchorQueue.failed} · 排队 {health.anchorQueue.queued} · 未连接真实链 {health.anchorQueue.unconfigured} · 已确认 {health.anchorQueue.confirmed}</span></div>
      <div className="ops-detail-row"><b>最近清扫</b><span>{zhTime(health.lastSweepAt)}</span></div>
      <div className="ops-detail-row"><b>虚拟业务时间</b><span>{zhTime(health.virtualNow)}（演示台可推进）</span></div>
      <p className="panel-sub">{health.note}</p>
    </div>}
    {tab === "config" && health && <div className="admin-panel">
      <h3>功能配置与公告（当前 v{health.featureConfig.version}，{health.featureConfig.updatedBy ? `由 ${health.featureConfig.updatedBy} 发布` : "默认"}）</h3>
      <p className="panel-sub">发布需要双人批准；回滚 = 发布一个新版本，历史保留。用户端在下一次轮询（≤3 秒）看到公告与限制。</p>
      <label className="checkbox" style={{ color: "#352B30" }}>
        <input type="checkbox" checked={flags.radarNew} onChange={e => setFlags({ ...flags, radarNew: e.target.checked })} />
        允许新的心动雷达开启（暂停只影响新开启）
      </label>
      <label className="checkbox" style={{ color: "#352B30" }}>
        <input type="checkbox" checked={flags.planNew} onChange={e => setFlags({ ...flags, planNew: e.target.checked })} />
        允许新建/接受相守计划（已激活计划的审核/退款/领取不受影响）
      </label>
      <label className="checkbox" style={{ color: "#352B30" }}>
        <input type="checkbox" checked={flags.anchorNew} onChange={e => setFlags({ ...flags, anchorNew: e.target.checked })} />
        允许新的存证提交（暂停期间任务排队，内容不丢失；恢复后由运维重试）
      </label>
      <label className="ops-field">维护公告（≤120 字，显示在用户端顶部）</label>
      <textarea className="ops-input" maxLength={120} value={notice} onChange={e => setNotice(e.target.value)} placeholder="例如：今晚 23:00–24:00 例行维护，期间暂停新的存证提交。" />
      <label className="ops-field">发布原因（≥4 字，进入审计）</label>
      <input className="ops-input" value={reason} onChange={e => setReason(e.target.value)} placeholder="例如：配合存证服务升级" />
      <div className="ops-actions">
        {session.permissions.includes("config.propose")
          ? <button className="ops-btn" disabled={busy || reason.trim().length < 4}
            onClick={() => act(async () => {
              await opsPost("config/drafts", {
                radarNewEnabled: flags.radarNew, planNewEnabled: flags.planNew, anchorSubmitEnabled: flags.anchorNew,
                maintenanceNotice: notice, reason,
              });
              setReason(""); load();
            }, "配置已提交发布审批，等待第二人批准")}>提交发布请求（双人审批）</button>
          : <span style={{ color: "#8B7A83", fontSize: 12 }}>当前角色不能发布配置。</span>}
      </div>
      {session.permissions.includes("approvals.approve") && <ApprovalList approvals={approvals} act={act} busy={busy} title="等待第二人批准" />}
    </div>}
    {tab === "audit" && (session.permissions.includes("audit.read")
      ? <div className="admin-panel">
        <h3>审计日志（脱敏）</h3>
        <table className="ops-table">
          <thead><tr><th>时间</th><th>操作者</th><th>动作</th><th>对象</th><th>摘要</th><th>结果</th></tr></thead>
          <tbody>{auditItems.map(a => <tr key={a.id}>
            <td>{zhTime(a.createdAt)}</td><td>{a.actorName}</td><td>{a.action}</td>
            <td>{a.targetType} {a.targetId !== "-" && <span className="mono-xs">{a.targetId}</span>}</td>
            <td>{a.detail}</td>
            <td>{a.result === "ok" ? <span className="ops-badge ok">成功</span> : <span className="ops-badge bad">拒绝</span>}</td>
          </tr>)}</tbody>
        </table>
      </div>
      : <div className="admin-panel"><p style={{ color: "#8B7A83", fontSize: 12 }}>当前角色没有审计读取权限。</p></div>)}
  </>;
}
