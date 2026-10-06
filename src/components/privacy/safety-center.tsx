"use client";
// 安全与隐私中心（v2.6，依据安全与隐私交付 03-UI 规格）：
// 总览 / 授权管理 / 屏蔽列表 / 我的举报 / 我的数据（导出与注销）。
// 固定文案：屏蔽确认“屏蔽不会自动结束当前绑定”；解除屏蔽“不会恢复此前的连接和授权”。
import { useCallback, useEffect, useState } from "react";
import { Button, Chip } from "../ui";
import { Modal } from "../modal";
import { friendlyError, V2ApiError } from "../../lib/client/v2-api";
import { safetyReasonLabels, safetyReasons, dataExportScopeLabels, dataExportScopes } from "../../lib/domain/safety-types";
import type { SafetyReason, DataExportScope } from "../../lib/domain/safety-types";

type Section = "overview" | "grants" | "blocks" | "reports" | "data";
const sectionTabs: { id: Section; text: string }[] = [
  { id: "overview", text: "总览" },
  { id: "grants", text: "授权" },
  { id: "blocks", text: "屏蔽" },
  { id: "reports", text: "举报" },
  { id: "data", text: "我的数据" },
];

export async function safetyGet<T>(viewer: string, path: string): Promise<T> {
  const response = await fetch(`/api/v2/${path}${path.includes("?") ? "&" : "?"}viewer=${viewer}`, { cache: "no-store" });
  const json = await response.json();
  if (!response.ok) throw new V2ApiError(json.error?.code ?? "UNKNOWN", json.error?.message ?? "查询失败", response.status);
  return json.data as T;
}

export async function safetyPost<T = { ok: boolean }>(viewer: string, path: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(`/api/v2/${path}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, viewer }),
  });
  const json = await response.json();
  if (!response.ok) throw new V2ApiError(json.error?.code ?? "UNKNOWN", json.error?.message ?? "操作失败", response.status);
  return json.data as T;
}

interface OverviewDto {
  counts: { grantsActive: number; grantsTotal: number; blocks: number; reportsOpen: number };
  export: { id: string; status: string; createdAt: number; expiresAt: number | null } | null;
  deletion: { id: string; state: string; stateLabel: string; requestedAt: number } | null;
  note: string;
}
interface GrantDto {
  id: string; scopeLabel: string; audienceLabel: string;
  createdAt: number; expiresAt: number; revokedAt: number | null;
  status: "active" | "revoked" | "expired";
}
interface BlockDto { id: string; targetLabel: string; active: boolean; createdAt: number; revision: number }
interface ReportDto {
  id: string; targetLabel: string; reasonLabel: string; statusLabel: string; status: string;
  createdAt: number; revision: number;
  description: string;
  supplements: { at: number; text: string }[];
  events: { at: number; label: string }[];
  userResult: { at: number; userMessage: string } | null;
  appeal: { requestedAt: number; decidedAt: number | null; userMessage: string | null } | null;
}
interface ExportDto { jobId: string; status: string; expiresAt: number; scopes: string[] }

export function SafetyCenter({ open, onClose, viewer }: { open: boolean; onClose: () => void; viewer: string }) {
  const [section, setSection] = useState<Section>("overview");
  const [overview, setOverview] = useState<OverviewDto | null>(null);
  const [grants, setGrants] = useState<GrantDto[]>([]);
  const [blocks, setBlocks] = useState<BlockDto[]>([]);
  const [reports, setReports] = useState<ReportDto[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // 举报详情 / 导出 / 注销子状态
  const [openReport, setOpenReport] = useState<ReportDto | null>(null);
  const [supplementText, setSupplementText] = useState("");
  const [appealText, setAppealText] = useState("");
  const [exportDto, setExportDto] = useState<ExportDto | null>(null);
  const [exportScopes, setExportScopes] = useState<DataExportScope[]>(["profile", "contacts", "diaries"]);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deletePassword, setDeletePassword] = useState("");
  const [deleteConfirmText, setDeleteConfirmText] = useState("");
  const [deleteConsent, setDeleteConsent] = useState(false);
  const [deleteResult, setDeleteResult] = useState<{ stateLabel: string; retentionSummary: string[]; credential: string } | null>(null);

  const refresh = useCallback(async () => {
    try {
      setOverview(await safetyGet<OverviewDto>(viewer, "privacy/overview"));
      setGrants(await safetyGet<GrantDto[]>(viewer, "privacy/grants"));
      setBlocks(await safetyGet<BlockDto[]>(viewer, "safety/blocks"));
      setReports(await safetyGet<ReportDto[]>(viewer, "safety/reports"));
      setError("");
    } catch (e) {
      setError(friendlyError(e));
    }
  }, [viewer]);

  useEffect(() => { if (open) void refresh(); }, [open, refresh]);

  async function run(action: () => Promise<unknown>) {
    setBusy(true); setError("");
    try { await action(); await refresh(); }
    catch (e) { setError(friendlyError(e)); }
    finally { setBusy(false); }
  }

  if (!open) return null;
  return <Modal title="安全与隐私" onClose={onClose}>
    <div className="safety-tabs" role="tablist">
      {sectionTabs.map(t => (
        <button key={t.id} role="tab" aria-selected={section === t.id}
          className={section === t.id ? "active" : ""} onClick={() => { setSection(t.id); setOpenReport(null); }}>{t.text}</button>
      ))}
    </div>
    {error && <p className="login-error" role="alert">{error}</p>}

    {section === "overview" && <div className="safety-section">
      {overview ? <>
        <div className="safety-counts">
          <div><b>{overview.counts.grantsActive}</b><small>生效中授权</small></div>
          <div><b>{overview.counts.blocks}</b><small>屏蔽中</small></div>
          <div><b>{overview.counts.reportsOpen}</b><small>进行中举报</small></div>
        </div>
        <p className="muted">{overview.note}</p>
        {overview.deletion && <p className="muted">注销状态：{overview.deletion.stateLabel}</p>}
      </> : <p className="muted">正在读取……</p>}
    </div>}

    {section === "grants" && <div className="safety-section">
      {grants.length === 0
        ? <p className="muted">还没有开放任何资料。需要时再选择对象与范围。</p>
        : <div className="grant-list">
          {grants.map(g => (
            <div className={`grant-item ${g.status === "active" ? "" : "expired"}`} key={g.id}>
              <span>{g.audienceLabel} · {g.scopeLabel}</span>
              {g.status === "active" ? <Chip tone="success">生效中</Chip>
                : g.status === "revoked" ? <Chip tone="outline">已撤销</Chip> : <Chip tone="outline">已过期</Chip>}
              {g.status === "active" && <button className="text-button" disabled={busy}
                onClick={() => run(() => safetyPost(viewer, "share-grants/revoke", { grantId: g.id }))}>撤销</button>}
            </div>
          ))}
          {grants.filter(g => g.status === "active").length > 0 && <button className="text-button" disabled={busy}
            onClick={() => run(async () => {
              // 撤销全部生效授权 = 逐条撤销本人发出的授权（他人授权不受影响）。
              for (const g of grants.filter(x => x.status === "active")) {
                await safetyPost(viewer, "share-grants/revoke", { grantId: g.id });
              }
            })}>
            撤销全部生效授权
          </button>}
        </div>}
      <p className="muted">撤销后对方立即失去后续读取（包括已打开的页面刷新后）；再次授权需要你明确操作。</p>
    </div>}

    {section === "blocks" && <div className="safety-section">
      {blocks.length === 0
        ? <p className="muted">这里暂时没有人。你可以随时为互动设下边界。</p>
        : <div className="block-list">
          {blocks.map(b => (
            <div className="grant-item" key={b.id}>
              <span>{b.targetLabel}<small className="muted"> · {new Date(b.createdAt).toLocaleDateString("zh-CN")}</small></span>
              <button className="text-button" disabled={busy}
                onClick={() => {
                  if (window.confirm("解除屏蔽不会恢复此前的连接和授权。确定解除吗？")) {
                    void run(() => safetyPost(viewer, `safety/blocks/${b.id}/revoke`, { expectedRevision: b.revision }));
                  }
                }}>解除屏蔽</button>
            </div>
          ))}
        </div>}
      <p className="muted">屏蔽期间双方从彼此的候选中消失，停止新的铃声、邀请与共享；解除屏蔽不会恢复此前的连接和授权。</p>
    </div>}

    {section === "reports" && <div className="safety-section">
      {openReport ? (() => {
        const r = openReport;
        return <>
          <button className="text-button" onClick={() => { setOpenReport(null); setSupplementText(""); setAppealText(""); }}>← 返回列表</button>
          <div className="me-row"><b>工单号</b><span className="points">{r.id}</span></div>
          <div className="me-row"><b>对象</b><span>{r.targetLabel}</span></div>
          <div className="me-row"><b>原因</b><span>{r.reasonLabel}</span></div>
          <div className="me-row"><b>状态</b><span>{r.statusLabel}</span></div>
          <p className="quote-sm" style={{ marginTop: 8 }}>“{r.description}”</p>
          {r.events.length > 0 && <div className="safety-events">
            {r.events.map((e, i) => <div key={i}><small className="muted">{new Date(e.at).toLocaleString("zh-CN")}</small><small> · {e.label}</small></div>)}
          </div>}
          {r.userResult && <div className="safety-result">
            <b>处理结论</b>
            <p style={{ margin: "4px 0" }}>{r.userResult.userMessage}</p>
            <small className="muted">{new Date(r.userResult.at).toLocaleString("zh-CN")}</small>
          </div>}
          {r.appeal && <p className="muted">复核：{r.appeal.decidedAt ? (r.appeal.userMessage ?? "已复核") : "复核中（由不同审核员处理）"}</p>}
          {["submitted", "in_review", "awaiting_supplement"].includes(r.status) && <>
            <label className="field-label" htmlFor="supp-text">补充说明（5–1000 字）</label>
            <textarea id="supp-text" rows={3} value={supplementText} onChange={e => setSupplementText(e.target.value)} />
            <Button className="secondary small" disabled={busy || supplementText.trim().length < 5}
              onClick={() => run(async () => {
                const updated = await safetyPost<ReportDto>(viewer, `safety/reports/${r.id}/supplements`, { text: supplementText, expectedRevision: r.revision });
                setOpenReport(updated); setSupplementText("");
              })}>提交补充</Button>
          </>}
          {r.status === "submitted" && <Button className="ghost small" disabled={busy}
            onClick={() => run(async () => {
              const updated = await safetyPost<ReportDto>(viewer, `safety/reports/${r.id}/withdraw`, { expectedRevision: r.revision });
              setOpenReport(updated);
            })}>撤回举报</Button>}
          {["resolved", "rejected"].includes(r.status) && !r.appeal && <>
            <label className="field-label" htmlFor="appeal-text">申请复核（每案一次，结案后 7 天内）</label>
            <textarea id="appeal-text" rows={2} value={appealText} onChange={e => setAppealText(e.target.value)} />
            <Button className="secondary small" disabled={busy || appealText.trim().length < 5}
              onClick={() => run(async () => {
                const updated = await safetyPost<ReportDto>(viewer, `safety/reports/${r.id}/appeals`, { reason: appealText, expectedRevision: r.revision });
                setOpenReport(updated); setAppealText("");
              })}>提交复核申请</Button>
          </>}
        </>;
      })() : <>
        {reports.length === 0
          ? <p className="muted">还没有提交过举报。如遇不适，可从对象菜单发起。</p>
          : <div className="block-list">
            {reports.map(r => (
              <button className="grant-item report-row" key={r.id}
                onClick={() => {
                  safetyGet<ReportDto>(viewer, `safety/reports/${r.id}`)
                    .then(setOpenReport)
                    .catch(e => setError(friendlyError(e)));
                }}>
                <span>{r.id}<small className="muted"> · {r.reasonLabel}</small></span>
                <Chip tone={r.status === "resolved" ? "success" : r.status === "rejected" ? "outline" : "warning"}>{r.statusLabel}</Chip>
              </button>
            ))}
          </div>}
        <p className="muted">举报本身不影响对方履约分；处理与复核由不同运营人员完成。</p>
      </>}
    </div>}

    {section === "data" && <div className="safety-section">
      <h3>导出我的数据</h3>
      <div className="safety-scopes">
        {dataExportScopes.map(s => (
          <label className="checkbox" key={s}>
            <input type="checkbox" checked={exportScopes.includes(s)}
              onChange={e => setExportScopes(e.target.checked
                ? [...exportScopes, s]
                : exportScopes.filter(x => x !== s))} />
            {dataExportScopeLabels[s]}
          </label>
        ))}
      </div>
      <Button className="secondary small" disabled={busy || exportScopes.length === 0}
        onClick={() => run(async () => {
          const created = await safetyPost<ExportDto>(viewer, "privacy/exports", { scopes: exportScopes });
          setExportDto(created);
        })}>生成数据包（24 小时内可下载）</Button>
      {exportDto && <div className="safety-result">
        <b>任务 {exportDto.jobId}</b>
        <p className="muted" style={{ margin: "4px 0" }}>
          状态：{exportDto.status === "ready" ? "可下载" : exportDto.status}
          {exportDto.expiresAt ? ` · 有效期至 ${new Date(exportDto.expiresAt).toLocaleString("zh-CN")}` : ""}
        </p>
        {exportDto.status === "ready" && <a href={`/api/v2/privacy/exports/${exportDto.jobId}/download?viewer=${viewer}`} target="_blank" rel="noopener noreferrer">下载数据包（JSON）</a>}
      </div>}
      <p className="muted">数据包只包含你本人有权访问的内容，不含他人私人草稿、运营内部意见或存证证据包 salt。已公开上链的承诺与对方已取得的归档副本无法被平台收回。</p>

      <h3 style={{ marginTop: 16, color: "var(--danger)" }}>注销账号</h3>
      <p className="muted">注销会：结束当前绑定（需你明确同意）、关闭雷达、撤销全部授权、清理个人展示资料与未共同确认草稿；在途争议与必要处理材料按规则受限保留。已共同确认的历史双方各自保留归档副本。</p>
      {!deleteResult ? <>
        <Button className="danger small" disabled={busy} onClick={() => setDeleteOpen(true)}>申请注销账号</Button>
        {deleteOpen && <Modal title="确认注销账号" onClose={() => setDeleteOpen(false)}>
          <p className="muted">为确认是本人操作，请输入当前账号的登录密码。</p>
          <label className="field-label" htmlFor="del-password">登录密码（再认证）</label>
          <input id="del-password" type="password" autoComplete="current-password" value={deletePassword}
            onChange={e => setDeletePassword(e.target.value)} />
          <label className="field-label" htmlFor="del-confirm">输入“注销”以确认</label>
          <input id="del-confirm" value={deleteConfirmText} onChange={e => setDeleteConfirmText(e.target.value)} />
          <label className="checkbox" style={{ marginTop: 8 }}>
            <input type="checkbox" checked={deleteConsent} onChange={e => setDeleteConsent(e.target.checked)} />
            我理解并同意：停止共享并结束当前绑定
          </label>
          <Button className="danger" disabled={busy || deleteConfirmText !== "注销" || !deleteConsent || !deletePassword}
            onClick={() => run(async () => {
              const result = await safetyPost<{ stateLabel: string; retentionSummary: string[]; credential: string }>(viewer, "privacy/deletions", {
                password: deletePassword, confirmation: deleteConfirmText, endBindingConsent: deleteConsent,
              });
              setDeleteResult(result);
              setDeleteOpen(false);
            })}>确认注销</Button>
          <Button className="ghost" onClick={() => setDeleteOpen(false)}>再想想</Button>
        </Modal>}
      </> : <div className="safety-result">
        <b>{deleteResult.stateLabel}</b>
        {deleteResult.retentionSummary.length > 0 && <>
          <p className="muted" style={{ margin: "4px 0" }}>存在需保留的材料，不能显示“所有数据已彻底删除”：</p>
          <ul className="muted" style={{ margin: 0, paddingLeft: 18 }}>
            {deleteResult.retentionSummary.map(s => <li key={s}>{s}</li>)}
          </ul>
        </>}
        <p className="muted">查询凭据（仅显示一次，请保存）：<code>{deleteResult.credential}</code></p>
      </div>}
    </div>}
  </Modal>;
}

// ---------- 对象菜单：举报 / 屏蔽（相遇铃声 / 已回响连接 / 绑定关系三种来源） ----------

export function ReportBlockDialog({ open, onClose, viewer, sourceType, sourceId, hasBinding }: {
  open: boolean; onClose: () => void; viewer: string;
  sourceType: "bell" | "connection" | "relationship"; sourceId: string; hasBinding: boolean;
}) {
  const [context, setContext] = useState<{ sourceLabel: string; targetLabel: string; targetRef: string } | null>(null);
  const [mode, setMode] = useState<"menu" | "report" | "block">("menu");
  const [reason, setReason] = useState<SafetyReason>("harassment");
  const [description, setDescription] = useState("");
  const [blockAlso, setBlockAlso] = useState(false); // 默认不勾选
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<{ title: string; note: string } | null>(null);

  useEffect(() => {
    if (!open) return;
    setMode("menu"); setDone(null); setError(""); setDescription(""); setBlockAlso(false);
    safetyGet<{ sourceLabel: string; targetLabel: string; targetRef: string }>(viewer, `safety/target-context?sourceType=${sourceType}&sourceId=${sourceId}`)
      .then(setContext)
      .catch(e => setError(friendlyError(e)));
  }, [open, viewer, sourceType, sourceId]);

  if (!open) return null;
  return <Modal title="举报与屏蔽" onClose={onClose}>
    {!context ? <p className="muted">{error || "正在核对对象……"}</p>
      : done ? <>
        <h3>{done.title}</h3>
        <p className="muted">{done.note}</p>
        <Button className="ghost" onClick={onClose}>关闭</Button>
      </> : mode === "menu" ? <>
        <p className="muted">对象：{context.targetLabel}（来源：{context.sourceLabel}）。举报与屏蔽相互独立。</p>
        <Button className="secondary" onClick={() => setMode("report")}>举报此人</Button>
        <Button className="secondary" onClick={() => setMode("block")}>屏蔽此人</Button>
        <p className="muted">举报不影响对方履约分；屏蔽不会自动结束当前绑定，也不会通知对方。</p>
      </> : mode === "report" ? <>
        <p className="muted">对象：{context.targetLabel}。举报前不会揭晓匿名对象的身份。</p>
        <label className="field-label">原因</label>
        <div className="choice-list">
          {safetyReasons.map(r => (
            <button key={r} className={reason === r ? "chosen" : ""} onClick={() => setReason(r)}>{safetyReasonLabels[r]}</button>
          ))}
        </div>
        <label className="field-label" htmlFor="report-desc">说明（10–1000 字）</label>
        <textarea id="report-desc" rows={4} value={description} onChange={e => setDescription(e.target.value)} />
        <label className="checkbox" style={{ marginTop: 6 }}>
          <input type="checkbox" checked={blockAlso} onChange={e => setBlockAlso(e.target.checked)} />
          同时屏蔽此人（默认不勾选）
        </label>
        {error && <p className="login-error" role="alert">{error}</p>}
        <Button disabled={busy || description.trim().length < 10}
          onClick={async () => {
            setBusy(true); setError("");
            try {
              const result = await safetyPost<{ report: { id: string }; reused: boolean }>(viewer, "safety/reports", {
                targetRef: context.targetRef, reason, description: description.trim(), blockTarget: blockAlso,
              });
              setDone({
                title: result.reused ? "已并入未结案的同类工单" : "举报已提交",
                note: `工单号 ${result.report.id}。处理进度可在「我的 → 安全与隐私 → 举报」中查看；结论会通过站内通知送达。${blockAlso ? "已同时屏蔽此人。" : ""}`,
              });
            } catch (e) { setError(friendlyError(e)); }
            finally { setBusy(false); }
          }}>提交举报</Button>
        <Button className="ghost" onClick={() => setMode("menu")}>返回</Button>
      </> : <>
        <p className="muted">屏蔽 {context.targetLabel} 后：</p>
        <ul className="muted" style={{ paddingLeft: 18 }}>
          <li>双方从彼此的候选中消失，停止新的铃声、邀请与授权</li>
          <li>关闭现有连接，撤销双向资料授权</li>
          <li>取消待处理的铃声与关系邀请</li>
          {hasBinding && <li><b>屏蔽不会自动结束当前绑定</b>；如需结束请另行在关系设置中操作</li>}
        </ul>
        <p className="muted">你的草稿、本人可读的共同确认历史、申诉与既有权益处理都会保留。</p>
        {error && <p className="login-error" role="alert">{error}</p>}
        <Button className="danger" disabled={busy}
          onClick={async () => {
            setBusy(true); setError("");
            try {
              await safetyPost(viewer, "safety/blocks", { targetRef: context.targetRef });
              setDone({ title: "已屏蔽", note: "已停止向对方展示你的资料与新互动入口。解除屏蔽不会恢复此前的连接和授权。" });
            } catch (e) { setError(friendlyError(e)); }
            finally { setBusy(false); }
          }}>确认屏蔽</Button>
        <Button className="ghost" onClick={() => setMode("menu")}>再想想</Button>
      </>}
  </Modal>;
}
