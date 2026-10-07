"use client";
// 我们（计划书第 5 节 / UI-08/09/10）：关系空间、日记版本、双方确认、承诺与归档。
// v2.2：日记/承诺草稿不再被轮询刷新覆盖；承诺生效与结算均有存证状态；空间支持自定义。
// v2.5：新增「待确认」栏（反馈 4）；日记/纪念日/承诺支持附件上传（反馈 6）；
// 生成存证后凭证视图自动刷新为「查看证据」，无需关闭弹层（反馈 5）。
// v2.7（双用户实测修复）：确认/退回/撤回携带 expectedVersion 并在操作后刷新详情；
// 弹层打开期间自动同步对方改版；新增按钮固定在列表上方；待确认超过 5 项折叠；
// 时间线支持搜索与分页加载；旧归档可点开只读查看；日期按业务时区（北京时间）取默认值。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Card, Chip, EmptyState, BookIcon, GiftIcon, BellIcon, StageArt, anchorStatusChip, zhDate } from "../ui";
import { Modal } from "../modal";
import { getV2, postV2 } from "../../lib/client/v2-api";
import { demoImageLibrary } from "../../lib/repositories/demo-images";
import { AttachmentList, AttachmentUploader, type UploadedAttachment } from "../attachment-upload";
import type { ArchiveSummaryDto, DiaryDetailDto, TimelineItemDto, V2StateView } from "../../lib/domain/view-dtos";
import { businessDateKey, spaceThemeLabels, type SpaceSettings, type SpaceTheme } from "../../lib/domain/v2-types";
import { EvidenceDrawer } from "./evidence-drawer";
import { ReportBlockDialog } from "../privacy/safety-center";
import type { TabId } from "./app-shell";

type Filter = "all" | "diary" | "promise" | "milestone";
// v2.7：日期默认值/上限按业务时区（北京时间）计算，不再用 UTC（凌晨时“今天”会错成昨天）。
const todayOf = (virtualNow: number) => businessDateKey(virtualNow);
const PAGE_SIZE = 20;
const PENDING_PREVIEW = 5;

export function UsTab({ view, user, busy, act, switchTab }: {
  view: V2StateView; user: string; busy: boolean;
  act(path: string, body?: Record<string, unknown>): Promise<boolean>;
  switchTab(tab: TabId): void;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const [creating, setCreating] = useState(false);
  const [openDiary, setOpenDiary] = useState<string | null>(null);
  const [openPromise, setOpenPromise] = useState<string | null>(null);
  const [promiseCreating, setPromiseCreating] = useState(false);
  const [endOpen, setEndOpen] = useState(false);
  const [spaceOpen, setSpaceOpen] = useState(false);
  const [safetyOpen, setSafetyOpen] = useState(false); // v2.6：关系内举报/屏蔽入口
  const [evidence, setEvidence] = useState<{ anchor: TimelineItemDto["anchor"]; business: string; recordId?: string } | null>(null);
  // v2.7：长列表三件套 —— 关键字搜索、日期筛选、分页加载（实测 200 条后新增入口沉底 2 万像素）。
  const [search, setSearch] = useState("");
  const [dateFilter, setDateFilter] = useState("");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [pendingExpanded, setPendingExpanded] = useState(false);
  // v2.7：旧归档弹层（已结束关系的只读记录列表）。
  const [archiveOpen, setArchiveOpen] = useState<string | null>(null);
  const [archiveReadOnlyId, setArchiveReadOnlyId] = useState<string | null>(null);

  const rel = view.us.relationship;
  const allTimeline = view.us.timeline.filter(t =>
    filter === "all" ? true : filter === "diary" ? t.type === "diary" : filter === "promise" ? t.type === "promise" : t.type === "milestone" || t.type === "auto-milestone");
  const keyword = search.trim().toLowerCase();
  // v2.5（反馈 4）：待确认栏 = 所有需要我处理的项目（日记确认/承诺确认/履约证据确认/关系邀请）。
  const pendingItems = allTimeline.filter(t => t.needsMyAction);
  const pendingInvite = view.us.incomingInvite;

  useEffect(() => { setVisibleCount(PAGE_SIZE); }, [filter, keyword, dateFilter]);

  if (!rel) {
    // v2.7：有待回应的关系邀请时，直接在「我们」显示邀请卡（实测：此前误显示“去邀请关系”空态）。
    const invite = view.us.incomingInvite;
    const inviter = invite ? invite.nicknameOf?.[invite.proposedBy] ?? invite.proposedBy : null;
    return <>
      <p className="eyebrow">一起记录</p>
      <h1>我们</h1>
      <StageArt stage="us" />
      {invite ? <>
        <Card className="tight pending-card">
          <div className="pending-head">
            <h3>关系邀请待回应 <span className="pending-count">1</span></h3>
            <small className="muted">{inviter} 邀请你建立关系；回应后才能一起写日记。</small>
          </div>
          <div style={{ display: "grid", gap: 8, marginTop: 10 }}>
            <Button disabled={busy} onClick={() => act("relationships/accept", { relationshipId: invite.id })}>接受邀请，开始共同记录</Button>
            <Button className="secondary" disabled={busy} onClick={() => act("relationships/decline", { relationshipId: invite.id })}>婉拒这次邀请</Button>
          </div>
        </Card>
      </> : <EmptyState title="确认关系后，一起写下第一天" hint="共同日记、重要承诺和纪念时间线，都属于你们的关系空间。"
        action={<Button onClick={() => switchTab("know")}>去了解并邀请关系</Button>} />}
      {view.us.archives.length > 0 && <Card className="tight">
        <h3>我的旧归档</h3>
        {view.us.archives.map(a => <div className="me-row" key={a.id}>
          <span>{a.partnerLabel}</span>
          <span className="muted" style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {a.timelineCount} 条记录 · 只读
            <button className="text-button" onClick={() => setArchiveOpen(a.id)}>查看记录</button>
          </span>
        </div>)}
        <p className="muted">归档仅本人可见，不能新增共同内容；已有承诺的结果确认与计划结算走独立接口。</p>
      </Card>}
      <ArchiveModal open={archiveOpen} onClose={() => setArchiveOpen(null)} user={user}
        onOpenDiary={(id) => { setArchiveOpen(null); setArchiveReadOnlyId(id); setOpenDiary(id); }} />
      <DiaryDetail open={openDiary} onClose={() => { setOpenDiary(null); setArchiveReadOnlyId(null); }} user={user}
        busy={busy} act={act} onEvidence={setEvidence} readOnly={archiveReadOnlyId !== null} />
    </>;
  }

  const space = rel.spaceSettings;
  const timeline = keyword || dateFilter ? allTimeline.filter(t =>
    (!keyword || t.title.toLowerCase().includes(keyword) || t.subtitle.toLowerCase().includes(keyword))
    && (!dateFilter || t.dateLabel.includes(dateFilter))) : allTimeline;
  const visibleTimeline = timeline.slice(0, visibleCount);
  const shownPending = pendingExpanded ? pendingItems : pendingItems.slice(0, PENDING_PREVIEW);
  const hiddenPendingCount = pendingItems.length - shownPending.length;

  return <>
    <div className={`us-hero theme-${space.theme}`}>
      {/* v2.9：交错双环水印（Consensus Bell 轨道舞台 · 纯装饰） */}
      <svg className="hero-rings" viewBox="0 0 120 120" fill="none" aria-hidden="true">
        <defs>
          <linearGradient gradientUnits="userSpaceOnUse" id="hbHeroBand" x1="18" x2="102" y1="18" y2="102">
            <stop offset="0" stopColor="#FFFFFF" /><stop offset=".35" stopColor="#F4DDE0" />
            <stop offset=".7" stopColor="#C98877" /><stop offset="1" stopColor="#E7B7A8" />
          </linearGradient>
        </defs>
        <ellipse cx="60" cy="106" fill="#252323" opacity=".06" rx="30" ry="6" />
        <circle cx="52" cy="56" r="31" stroke="url(#hbHeroBand)" strokeWidth="7.5" />
        <circle cx="77" cy="64" opacity=".92" r="23" stroke="url(#hbHeroBand)" strokeWidth="6" />
        <circle cx="49" cy="26" fill="#FFFFFF" r="2.6" />
      </svg>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <p className="eyebrow" style={{ marginTop: 0 }}>{space.name}</p>
          <div className="us-monogram">
            {rel.members.map(m => rel.nicknameOf?.[m] ?? m).map((name, i) => (
              <span key={i}>{i > 0 && <em aria-hidden="true">✕</em>}{name}</span>
            ))}
          </div>
          <div className="us-days">{rel.status === "married" ? "已婚（应用内标记）" : space.showDays ? `我们的第 ${view.us.daysTogether ?? 1} 天` : "我们的空间"}</div>
          {space.showDays && <p className="muted">{view.us.nextAnniversaryInDays !== null ? `下一个纪念日还有 ${view.us.nextAnniversaryInDays} 天` : ""}{rel.startedAt ? ` · 自 ${zhDate(rel.startedAt)}` : ""}</p>}
        </div>
        <div style={{ display: "grid", gap: 4, justifyItems: "end" }}>
          <button className="text-button" onClick={() => setSpaceOpen(true)}>空间设置</button>
          <button className="text-button" onClick={() => setEndOpen(true)}>关系设置</button>
        </div>
      </div>
      <div className="status-line">
        <Chip tone="brand">{rel.status === "married" ? "应用内已婚标记（非婚姻核验）" : "在一起"}</Chip>
        <Chip tone="outline">存证范围：双方确认后可选择</Chip>
      </div>
    </div>

    {/* v2.9：共享数据条（参考稿 Shared Vital Statistics Bar · 计数全部来自现有视图，点击联动筛选） */}
    <div className="stats-bar">
      <button type="button" className="stat" onClick={() => setFilter("diary")}>
        <b className="num">{allTimeline.filter(t => t.type === "diary").length}</b>
        <span>共同日记</span>
        <small><i className="st-rose" aria-hidden="true" />我们的故事</small>
      </button>
      <div className="stat-divider" aria-hidden="true" />
      <button type="button" className="stat" onClick={() => setFilter("promise")}>
        <b className="num">{view.us.promises.length}</b>
        <span>重要承诺</span>
        <small><i className="st-sage" aria-hidden="true" />{view.us.promises.some(p => p.status === "active") ? "履行中" : "已立下"}</small>
      </button>
      <div className="stat-divider" aria-hidden="true" />
      <button type="button" className="stat" onClick={() => switchTab("future")}>
        <b className="num">{view.future.plan?.investedTotal ?? 0}<em>点</em></b>
        <span>相守托管</span>
        <small><i className="st-amber" aria-hidden="true" />{view.future.plan ? "共同成长" : "待开启"}</small>
      </button>
    </div>

    {/* v2.7：新增入口固定在列表上方（实测 200 条后按钮沉到 2 万像素深，找不到入口）。 */}
    <div className="us-create-bar">
      <button className="diary-new" onClick={() => setCreating(true)}>＋ 写下今天</button>
      <button className="text-button" onClick={() => setPromiseCreating(true)}>立下一个重要承诺</button>
      <span className="muted" style={{ fontSize: 10.5 }}>计分承诺 {view.us.scoringUsage.used}/{view.us.scoringUsage.max} · 今日已新增 {view.us.scoringUsage.todayNew} 项</span>
    </div>

    <div className="filter-row">
      {([["all", "全部"], ["diary", "日记"], ["promise", "承诺"], ["milestone", "纪念"]] as const).map(([id, label]) => (
        <button key={id} className={filter === id ? "active" : ""} onClick={() => setFilter(id)}>{label}</button>
      ))}
    </div>

    {/* v2.7：关键字 + 日期搜索，长列表可定位；不与顶部待确认栏重复铺开。 */}
    <div className="us-search-row">
      <input aria-label="搜索记录" placeholder="搜索标题或内容摘要…" value={search} maxLength={40}
        onChange={e => setSearch(e.target.value)} />
      <input aria-label="按日期筛选" type="date" value={dateFilter} onChange={e => setDateFilter(e.target.value)} />
      {(keyword || dateFilter) && <button className="text-button" onClick={() => { setSearch(""); setDateFilter(""); }}>清除</button>}
    </div>

    {(pendingItems.length > 0 || pendingInvite) && <Card className="tight pending-card">
      <div className="pending-head">
        <h3>待确认 <span className="pending-count">{pendingItems.length + (pendingInvite ? 1 : 0)}</span></h3>
        <small className="muted">这些事项等待你处理；确认后自动移出{pendingItems.length > PENDING_PREVIEW ? "（默认只显示前几项）" : ""}</small>
      </div>
      {pendingInvite && <button className="pending-item" onClick={() => switchTab("know")}>
        <span className="t-icon"><BellIcon /></span>
        <span className="t-main"><strong>关系邀请待回应</strong><small>TA 邀请你建立关系，点这里去了解页回应</small></span>
        <Chip tone="warning">待确认</Chip>
      </button>}
      {shownPending.map(item => <button className="pending-item" key={item.id} onClick={() => {
        if (item.type === "promise") setOpenPromise(item.id); else setOpenDiary(item.id);
      }}>
        <span className="t-icon">{item.type === "promise" ? <GiftIcon /> : <BookIcon />}</span>
        <span className="t-main">
          <strong>{item.title}</strong>
          <small>{item.type === "promise" ? "承诺" : item.type === "milestone" || item.type === "auto-milestone" ? "纪念节点" : "日记"} · {item.statusText}</small>
        </span>
        <Chip tone="warning">{item.needsMyAction ? "待确认" : "提醒"}</Chip>
      </button>)}
      {pendingItems.length > PENDING_PREVIEW && <button className="text-button" style={{ margin: "6px auto", display: "block" }}
        onClick={() => setPendingExpanded(v => !v)}>
        {pendingExpanded ? "收起待确认列表" : `展开全部 ${pendingItems.length} 项待确认`}
      </button>}
    </Card>}

    <div className="timeline">
      {timeline.length === 0 && <EmptyState compact title={keyword || dateFilter ? "没有匹配的记录" : "还没有记录"} hint={keyword || dateFilter ? "换个关键词或清除筛选试试。" : "第一天，从一页日记或一个小承诺开始。"} />}
      {visibleTimeline.map(item => <TimelineRow key={item.id} item={item} onOpen={() => {
        if (item.type === "promise") setOpenPromise(item.id); else setOpenDiary(item.id);
      }} onEvidence={() => setEvidence({ anchor: item.anchor, business: item.statusText, recordId: item.id })} />)}
      {timeline.length > visibleCount && <Button className="ghost" onClick={() => setVisibleCount(c => c + PAGE_SIZE)}>
        加载更多（还有 {timeline.length - visibleCount} 条）
      </Button>}
    </div>

    <DiaryEditor open={creating} onClose={() => setCreating(false)} busy={busy} act={act} virtualNow={view.modes.virtualNow} />
    <DiaryDetail open={openDiary} onClose={() => setOpenDiary(null)} user={user} busy={busy} act={act} onEvidence={setEvidence} />
    <PromiseFlow open={openPromise} onClose={() => setOpenPromise(null)} view={view} user={user} busy={busy} act={act} creating={promiseCreating} setCreating={setPromiseCreating} onEvidence={setEvidence} />
    <SpaceSettingsModal open={spaceOpen} onClose={() => setSpaceOpen(false)} relationshipId={rel.id} settings={space} busy={busy} act={act} />

    {endOpen && <Modal title="关系设置" onClose={() => setEndOpen(false)}>
      <h3>关系详情</h3>
      <div className="me-row"><b>成员</b><span>{rel.members.map(m => rel.nicknameOf?.[m] ?? m).join(" · ")}</span></div>
      <div className="me-row"><b>状态</b><span>{rel.status === "married" ? "已婚（应用内标记）" : "在一起"}</span></div>
      <div className="me-row"><b>开始于</b><span className="date">{zhDate(rel.startedAt)}</span></div>
      <div className="me-row"><b>在一起</b><span className="points">{view.us.daysTogether ?? 1} 天</span></div>
      <div className="me-row"><b>条款版本</b><span>{rel.termsVersion}</span></div>
      <h3 style={{ marginTop: 16 }}>存证与证据</h3>
      <p className="muted">关系建立/结束事件、双方确认的日记与承诺都会生成存证任务（preview 模式保留本地承诺指纹，无需钱包）。可在各记录的「查看证据」中核对与导出证据包。</p>
      <Button className="secondary" onClick={() => { setEndOpen(false); switchTab("future"); }}>查看相守计划</Button>
      <h3 style={{ marginTop: 16, color: "var(--danger)" }}>结束当前绑定</h3>
      <p className="muted">结束只需你本人确认，立即生效：共享写入关闭、雷达限制解除、后续联系方式共享停止。不等待对方同意、不等待链上确认、不等待相守计划结算。已有争议或资金处理继续按独立流程进行。</p>
      <p className="muted">进行中的相守计划会按规则独立处理（复核或进入失效等待），不会锁住这次退出。</p>
      <Button className="danger" disabled={busy} onClick={async () => { if (await act("relationships/end", { relationshipId: rel.id })) setEndOpen(false); }}>结束当前绑定</Button>
      <Button className="ghost" onClick={() => setEndOpen(false)}>继续这段关系</Button>
      <h3 style={{ marginTop: 16 }}>举报与屏蔽</h3>
      <p className="muted">屏蔽不会自动结束当前绑定；两种动作相互独立，均无需对方同意或审核。</p>
      <Button className="secondary" onClick={() => { setEndOpen(false); setSafetyOpen(true); }}>举报 / 屏蔽对方</Button>
    </Modal>}

    <EvidenceDrawer open={!!evidence} onClose={() => setEvidence(null)} anchor={evidence?.anchor ?? null}
      businessStatus={evidence?.business ?? ""} sourceLabel="双方确认（应用内）"
      onExport={evidence?.recordId ? () => exportEvidence(evidence.recordId!, user) : undefined} />

    {safetyOpen && rel && <ReportBlockDialog open onClose={() => setSafetyOpen(false)} viewer={view.me.id}
      sourceType="relationship" sourceId={rel.id} hasBinding />}
  </>;
}

function TimelineRow({ item, onOpen, onEvidence }: { item: TimelineItemDto; onOpen: () => void; onEvidence: () => void }) {
  const anchor = item.anchor;
  const icon = item.type === "promise" ? <GiftIcon /> : item.type === "diary" ? <BookIcon /> : <BellIcon />;
  return <button className="timeline-item" onClick={onOpen}>
    <span className="t-icon">{icon}</span>
    <span className="t-main">
      <strong>{item.title}</strong>
      <small>{item.dateLabel} · {item.subtitle}</small>
      <small className="muted">{item.confirmSummary}</small>
    </span>
    <span className="t-side">
      {item.needsMyAction ? <Chip tone="warning">{item.statusText}</Chip> : <Chip>{item.statusText}</Chip>}
      {anchor && <button className="text-button" style={{ fontSize: 10.5 }} onClick={e => { e.stopPropagation(); onEvidence(); }}>证据</button>}
    </span>
  </button>;
}

function DiaryEditor({ open, onClose, busy, act, virtualNow }: { open: boolean; onClose: () => void; busy: boolean; virtualNow: number; act: (p: string, b?: Record<string, unknown>) => Promise<boolean> }) {
  const [kind, setKind] = useState<"diary" | "milestone">("diary");
  const [date, setDate] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [photos, setPhotos] = useState<string[]>([]);
  const [uploads, setUploads] = useState<UploadedAttachment[]>([]);
  const [asDraft, setAsDraft] = useState(false);
  // v2.7：每次打开生成新的幂等键 —— 网络重试/双击提交返回同一条日记，不再产生重复记录。
  const [idempotencyKey, setIdempotencyKey] = useState("");
  // v2.2 修复：虚拟时钟通过 ref 读取，仅在弹层打开瞬间取默认日期；
  // 1.2s 轮询刷新 virtualNow 不再重置表单（此前正文输入约 1 秒即被清空）。
  const virtualNowRef = useRef(virtualNow);
  virtualNowRef.current = virtualNow;
  useEffect(() => {
    if (open) {
      setDate(todayOf(virtualNowRef.current)); setTitle(""); setBody(""); setPhotos([]); setUploads([]); setAsDraft(false); setKind("diary");
      setIdempotencyKey(typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `ed-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    }
  }, [open]);
  if (!open) return null;
  return <Modal title="写下今天" onClose={onClose}>
    <div className="kind-options">
      <button className={kind === "diary" ? "chosen" : ""} onClick={() => setKind("diary")}><span>📖</span>共同日记</button>
      <button className={kind === "milestone" ? "chosen" : ""} onClick={() => setKind("milestone")}><span>🎀</span>纪念节点</button>
    </div>
    <label className="field-label" htmlFor="diary-date">这一天发生在</label>
    <input id="diary-date" type="date" value={date} max={todayOf(virtualNow)} onChange={e => setDate(e.target.value)} />
    <label className="field-label" htmlFor="diary-title">标题（40 字内）</label>
    <input id="diary-title" maxLength={40} value={title} placeholder="例如：一起等了一场雨" onChange={e => setTitle(e.target.value)} />
    <label className="field-label" htmlFor="diary-body">正文（3000 字内）</label>
    <textarea id="diary-body" maxLength={3000} rows={5} value={body} placeholder="当时的心情、地点，或只有你们懂的话。" onChange={e => setBody(e.target.value)} />
    <label className="field-label">演示图片（可选，与附件合计最多 6 个 · 本地演示库）</label>
    <div className="photo-picker">
      {demoImageLibrary.map(img => (
        <button key={img.id} className={photos.includes(img.id) ? "chosen" : ""} aria-pressed={photos.includes(img.id)}
          onClick={() => setPhotos(photos.includes(img.id) ? photos.filter(p => p !== img.id) : photos.length + uploads.length >= 6 ? photos : [...photos, img.id])}>
          {img.name}
        </button>
      ))}
    </div>
    <AttachmentUploader files={uploads} onChange={setUploads} extraCount={photos.length} label={`附件（可选，png / jpg / pdf / md / word，与演示图片合计最多 6 个）`} />
    <label className="checkbox"><input type="checkbox" checked={asDraft} onChange={e => setAsDraft(e.target.checked)} />先存为私人草稿（仅你可见，不通知对方、不存证）</label>
    <Button disabled={busy || !date || !title.trim() || !body.trim()} onClick={async () => {
      if (await act("diaries", { kind, date, title, body, attachmentIds: photos, attachments: uploads, visibility: asDraft ? "draft" : "shared", idempotencyKey })) onClose();
    }}>{busy ? "保存中…" : asDraft ? "保存草稿" : "发给 TA 确认"}</Button>
  </Modal>;
}

function DiaryDetail({ open, onClose, user, busy, act, onEvidence, readOnly = false }: {
  open: string | null; onClose: () => void; user: string; busy: boolean;
  act(path: string, body?: Record<string, unknown>): Promise<boolean>;
  onEvidence(e: { anchor: TimelineItemDto["anchor"]; business: string; recordId?: string }): void;
  readOnly?: boolean; // v2.7：旧归档查看 —— 隐藏全部写操作按钮
}) {
  const [detail, setDetail] = useState<DiaryDetailDto | null>(null);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [returnNote, setReturnNote] = useState("");
  const load = useCallback(async (id: string) => {
    try { setDetail(await getV2<DiaryDetailDto>(`diaries/detail?id=${id}&viewer=${user}`)); }
    catch { setDetail(null); }
  }, [user]);
  useEffect(() => { if (open) { load(open); setEditing(false); setReturnNote(""); } else setDetail(null); }, [open, load]);
  // v2.7：弹层打开期间每 1.5s 同步详情 —— 对方改版后弹层内容即时更新，
  // 配合服务端 expectedVersion 校验，杜绝“看旧版却确认了新版”（实测缺陷 02/06）。
  useEffect(() => {
    if (!open || editing) return;
    const timer = setInterval(() => { void load(open); }, 1500);
    return () => clearInterval(timer);
  }, [open, editing, load]);
  if (!open || !detail) return null;
  const version = detail.versions[detail.versions.length - 1];
  const myConfirmed = !!version.confirmations[user];
  const author = version.author === user ? "你" : "TA";
  const anchorChip = anchorStatusChip(detail.anchor?.chainStatus);
  return <Modal title={version.kind === "milestone" ? "纪念节点" : "这一页日记"} onClose={onClose}>
    <div className="promise-card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
        <div>
          <h3>{version.title}</h3>
          <p className="muted">{version.date} · 版本 {version.version} · {author}写下</p>
        </div>
        <span className={`stamp ${version.status === "confirmed" ? "confirmed" : "waiting"}`}>{version.status === "confirmed" ? "共同\n确认" : "待确认"}</span>
      </div>
      <p style={{ whiteSpace: "pre-wrap", marginTop: 8 }}>{version.body}</p>
      {version.attachments.length > 0 && <AttachmentList attachments={version.attachments} />}
      <p className="muted">{Object.keys(version.confirmations).length >= 2 ? "双方已确认这一版本" : myConfirmed ? "你已确认，等待 TA" : "等待你确认"}{detail.versions.length > 1 ? ` · 历史共 ${detail.versions.length} 版` : ""}</p>
      {version.returnedNote && <p className="muted">退回备注：{version.returnedNote}</p>}
    </div>
    <div className="status-line">
      <Chip tone={version.status === "confirmed" ? "success" : "warning"}>业务：{version.status === "confirmed" ? "双方已确认" : version.status === "awaiting" ? "等待确认" : version.status === "returned" ? "已退回" : version.status === "withdrawn" ? "已撤回" : "私人草稿"}</Chip>
      {/* v2.8 复测修复（N06）：存证凭证明示对应版本；当前版本与凭证版本分开判断。 */}
      {detail.anchor && detail.anchoredVersion === version.version
        && <Chip tone={anchorChip.tone}>存证：{anchorChip.label}（版本 {detail.anchoredVersion}）</Chip>}
      {detail.anchor && detail.anchoredVersion !== version.version
        && <Chip tone="outline">存证：{anchorChip.label}（对应版本 {detail.anchoredVersion}，非当前版）</Chip>}
      <Chip tone="outline">来源：应用内记录</Chip>
    </div>
    {readOnly && <p className="muted">这段关系已结束：记录只读，仅双方确认过的版本保留在归档中。</p>}
    {!readOnly && version.status === "awaiting" && !myConfirmed && version.author !== user && <>
      <p className="muted">确认绑定的是版本 {version.version} 的内容；TA 之后任何修改都会生成新版本并重新确认。若对方刚刚修改，这里会自动更新并要求重新阅读。</p>
      {/* v2.7：提交 expectedVersion —— 服务端严格比对，旧版本请求返回冲突（实测缺陷 02）。
          操作成功后立即重新加载详情，弹层状态不再滞后（实测缺陷 06）。 */}
      <Button disabled={busy} onClick={async () => {
        if (await act("diaries/confirm", { diaryId: detail.id, expectedVersion: version.version })) await load(detail.id);
      }}>确认这一版</Button>
      <input aria-label="退回备注" placeholder="退回时可以留一句话（可选）" value={returnNote} maxLength={120} onChange={e => setReturnNote(e.target.value)} style={{ marginTop: 10 }} />
      <Button className="secondary" disabled={busy} onClick={async () => {
        if (await act("diaries/return", { diaryId: detail.id, expectedVersion: version.version, note: returnNote })) await load(detail.id);
      }}>退回请 TA 修改</Button>
    </>}
    {!readOnly && version.status === "awaiting" && version.author === user && <>
      <Button className="ghost" disabled={busy} onClick={async () => {
        if (await act("diaries/withdraw", { diaryId: detail.id, expectedVersion: version.version })) await load(detail.id);
      }}>撤回这一页（不再提交）</Button>
    </>}
    {!readOnly && version.status === "draft" && version.author === user && <>
      <p className="muted">私人草稿仅你可见。发送后将等待 TA 确认。</p>
      <Button disabled={busy} onClick={async () => {
        if (await act("diaries/share", { diaryId: detail.id })) await load(detail.id);
      }}>发给 TA 确认</Button>
    </>}
    {!readOnly && (editing ? <>
      <label className="field-label" htmlFor="edit-title">修改标题</label>
      <input id="edit-title" maxLength={40} value={title} onChange={e => setTitle(e.target.value)} />
      <label className="field-label" htmlFor="edit-body">修改正文</label>
      <textarea id="edit-body" maxLength={3000} rows={4} value={body} onChange={e => setBody(e.target.value)} />
      <Button disabled={busy || !title.trim() || !body.trim()} onClick={async () => {
        // v2.8 复测修复（N07）：expectedVersion 使用实际版本号 —— 有私人历史时可见版本数 ≠ 实际版本号，
        // 此前以数组长度代替导致持续 409、对方无法修改。
        if (await act("diaries/version", { diaryId: detail.id, expectedVersion: version.version, date: version.date, title, body, attachmentIds: version.attachments.map(a => a.id), visibility: "shared" })) {
          setEditing(false); await load(detail.id);
        }
      }}>生成新版本并重新确认</Button>
      <Button className="ghost" onClick={() => setEditing(false)}>取消</Button>
    </> : <Button className="secondary" onClick={() => { setEditing(true); setTitle(version.title); setBody(version.body); }}>修改内容（生成新版本）</Button>)}
    {!readOnly && version.status !== "confirmed" && (!detail.anchor || detail.anchoredVersion !== version.version) && <>
      <Button disabled title="需要双方确认这一版本后才能存证">为这一版生成存证</Button>
      <p className="muted center">需要双方确认这一版本后才能生成存证；当前状态：{version.status === "awaiting" ? (myConfirmed ? "等待 TA 确认" : "等待你确认") : version.status === "draft" ? "私人草稿" : "已退回/撤回"}。</p>
    </>}
    {/* v2.8 复测修复（N06）：按“当前版本是否已有存证”判断入口 —— v1 存证后改成 v2 并确认，
        此前误显示 v1 凭证并隐藏新版存证按钮。 */}
    {!readOnly && version.status === "confirmed" && (!detail.anchor || detail.anchoredVersion !== version.version) && <>
      <Button disabled={busy} onClick={async () => {
        if (await act("diaries/anchor", { diaryId: detail.id })) await load(detail.id);
      }}>为这一版生成存证</Button>
      <p className="muted center">preview 模式无需连接钱包：生成的是本地承诺指纹（可导出核验），不会发起链上交易。</p>
    </>}
    {detail.anchor && <Button className="ghost" onClick={() => onEvidence({ anchor: detail.anchor, business: `双方已确认的日记版本（版本 ${detail.anchoredVersion}）`, recordId: detail.id })}>查看证据</Button>}
    <p className="muted">这一版内容会留下可核验的指纹；原文与附件保存在应用里，哈希无法恢复丢失的内容，请及时导出备份。</p>
  </Modal>;
}

// v2.7：旧归档弹层 —— 已结束关系的只读记录列表（实测：此前只有“213 条记录·只读”计数，无法找回内容）。
function ArchiveModal({ open, onClose, user, onOpenDiary }: {
  open: string | null; onClose: () => void; user: string;
  onOpenDiary(id: string): void;
}) {
  const [data, setData] = useState<ArchiveSummaryDto | null>(null);
  const [search, setSearch] = useState("");
  useEffect(() => {
    if (!open) { setData(null); setSearch(""); return; }
    getV2<ArchiveSummaryDto>(`diaries/archive?relationshipId=${open}&viewer=${user}`)
      .then(setData)
      .catch(() => setData(null));
  }, [open, user]);
  if (!open) return null;
  const keyword = search.trim().toLowerCase();
  const items = data?.items.filter(i => !keyword || i.title.toLowerCase().includes(keyword) || i.date.includes(keyword)) ?? [];
  return <Modal title="旧归档（只读）" onClose={onClose}>
    {!data ? <p className="muted">正在读取归档……</p> : <>
      <p className="muted">
        共 {data.total} 条可读记录{data.endedAt ? ` · 关系结束于 ${zhDate(data.endedAt)}` : ""}；
        只保留双方共同确认过的版本，不能新增或修改。
      </p>
      <input aria-label="搜索归档" placeholder="搜索标题或日期（如 2026-09）" value={search} maxLength={40}
        style={{ width: "100%" }} onChange={e => setSearch(e.target.value)} />
      <div className="archive-list">
        {items.length === 0 && <p className="muted center" style={{ padding: "10px 0" }}>没有匹配的归档记录。</p>}
        {items.map(item => <button className="pending-item" key={item.id} onClick={() => onOpenDiary(item.id)}>
          <span className="t-icon">{item.kind === "milestone" ? <BellIcon /> : <BookIcon />}</span>
          <span className="t-main">
            <strong>{item.title}</strong>
            <small>{item.date} · {item.kind === "milestone" ? "纪念节点" : "日记"}{item.versionCount > 1 ? ` · ${item.versionCount} 版` : ""}{item.anchored ? " · 已存证" : ""}</small>
          </span>
          <Chip tone="outline">查看</Chip>
        </button>)}
      </div>
      <p className="muted">需要完整备份时，可在各记录的「查看证据」中导出证据包。</p>
    </>}
  </Modal>;
}

function PromiseFlow({ open, onClose, view, user, busy, act, creating, setCreating, onEvidence }: {
  open: string | null; onClose: () => void; view: V2StateView; user: string; busy: boolean;
  act(path: string, body?: Record<string, unknown>): Promise<boolean>;
  creating: boolean; setCreating(v: boolean): void;
  onEvidence(e: { anchor: TimelineItemDto["anchor"]; business: string; recordId?: string }): void;
}) {
  const [content, setContent] = useState("");
  const [dueAt, setDueAt] = useState("");
  const [criteria, setCriteria] = useState("");
  const [responsible, setResponsible] = useState<"me" | "both">("both");
  const [scoring, setScoring] = useState(false);
  const [uploads, setUploads] = useState<UploadedAttachment[]>([]);
  const [evidenceNote, setEvidenceNote] = useState("");
  // v2.7：创建承诺同样走服务端幂等键。
  const [idempotencyKey, setIdempotencyKey] = useState("");
  const promise = view.us.promises.find(p => p.id === open) ?? null;
  const defaultDueAt = () => {
    // v2.7：业务时区（北京时间）取默认截止日，与日期校验同口径。
    return businessDateKey(view.modes.virtualNow + 3 * 86_400_000);
  };
  useEffect(() => {
    if (creating) {
      setContent(""); setDueAt(defaultDueAt()); setCriteria(""); setResponsible("both"); setScoring(false); setUploads([]);
      setIdempotencyKey(typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `pr-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    }
  }, [creating]);

  if (creating) return <Modal title="立下一个重要承诺" onClose={() => setCreating(false)}>
    <label className="field-label" htmlFor="promise-content">承诺内容（4–80 字）</label>
    <input id="promise-content" maxLength={80} value={content} placeholder="例如：每周留一个共同的晚上" onChange={e => setContent(e.target.value)} />
    <label className="field-label" htmlFor="promise-due">截止日期</label>
    <input id="promise-due" type="date" value={dueAt} min={todayOf(view.modes.virtualNow + 86_400_000)} onChange={e => setDueAt(e.target.value)} />
    <label className="field-label" htmlFor="promise-criteria">验收方式（2–60 字）</label>
    <input id="promise-criteria" maxLength={60} value={criteria} placeholder="例如：双方确认本次安排即可" onChange={e => setCriteria(e.target.value)} />
    <div className="choice-list">
      <button className={responsible === "both" ? "chosen" : ""} onClick={() => setResponsible("both")}>双方共同负责</button>
      <button className={responsible === "me" ? "chosen" : ""} onClick={() => setResponsible("me")}>我负责（只考核我）</button>
    </div>
    <AttachmentUploader files={uploads} onChange={setUploads} label="附件（可选，png / jpg / pdf / md / word，最多 6 个 · 随承诺一起存证指纹）" />
    <label className="checkbox"><input type="checkbox" checked={scoring} onChange={e => setScoring(e.target.checked)} />
      双方同意此项计入履约参考（需在截止前至少 24 小时创建；每段关系最多 10 项）</label>
    <p className="muted">限制人身选择或难以客观判定的承诺（如“永不分手”、亲密行为、密码/定位、借钱）会被拒绝。</p>
    <Button disabled={busy || !content.trim() || !dueAt || !criteria.trim()} onClick={async () => {
      if (await act("promises", { content, dueAt: Date.parse(`${dueAt}T12:00:00Z`), criteria, responsible, scoringOptIn: scoring, attachments: uploads, idempotencyKey })) setCreating(false);
    }}>{busy ? "保存中…" : "提交承诺（等待 TA 确认）"}</Button>
  </Modal>;

  if (!open || !promise) return null;
  const myResponsible = promise.responsibleUserIds.includes(user);
  const other = promise.responsibleUserIds.find(uid => uid !== user);
  const myResolution = promise.resolutions[user];
  const otherResolution = other ? promise.resolutions[other] : undefined;
  // v2.2：印章跟随履约进度（确认完成后不再停留在“承诺生效”）。
  const results = promise.responsibleUserIds.map(uid => promise.resolutions[uid]?.result ?? "pending");
  const allFulfilled = results.length > 0 && results.every(r => r === "fulfilled");
  const allSettled = results.length > 0 && results.every(r => ["fulfilled", "unfulfilled", "waived"].includes(r));
  const stampClass = promise.status === "active" && (allFulfilled || allSettled) ? "confirmed" : promise.status === "active" ? "confirmed" : "waiting";
  const stampText = promise.status !== "active" ? "待确认" : allFulfilled ? "已完成" : allSettled ? "已结算" : "承诺\n生效";
  const anchorChip = anchorStatusChip(promise.anchor?.chainStatus);
  return <Modal title="重要承诺" onClose={onClose}>
    <div className="promise-card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
        <div>
          <h3>{promise.content}</h3>
          <p className="muted">截止 {zhDate(promise.dueAt)} · 验收：{promise.criteria}</p>
          <p className="muted">责任人：{promise.responsibleUserIds.length > 1 ? "双方" : myResponsible ? "我" : "TA"}</p>
        </div>
        <span className={`stamp ${stampClass}`}>{stampText}</span>
      </div>
      {promise.attachments.length > 0 && <AttachmentList attachments={promise.attachments} />}
      <p className="muted">{promise.scoringOptIn ? "此项计入履约参考（双方事前同意）" : "浪漫约定，不计入履约分"}</p>
    </div>
    <div className="status-line">
      {promise.anchor
        ? <Chip tone={anchorChip.tone}>存证：{anchorChip.label}</Chip>
        : <Chip tone="outline">存证：承诺生效后生成</Chip>}
      {promise.status === "active" && !promise.anchor && <Chip tone="warning">等待双方确认生效</Chip>}
    </div>
    <p className="muted">v2.2 起：承诺经双方确认生效即生成存证任务；履约结算（完成/未完成/豁免）后生成结算存证，均可在“查看证据”中导出核对。</p>
    {promise.anchor && <Button className="ghost" onClick={() => onEvidence({ anchor: promise.anchor!, business: "承诺生效与履约结算存证", recordId: promise.id })}>查看证据</Button>}
    {promise.status === "proposed" && !promise.confirmations[user] && <>
      <p className="muted">提出者单方面写下不代表你同意。确认后承诺生效。</p>
      <Button disabled={busy} onClick={() => act("promises/confirm", { promiseId: promise.id, expectedRevision: promise.revision })}>确认承诺</Button>
      <Button className="secondary" disabled={busy} onClick={() => act("promises/return", { promiseId: promise.id })}>退回</Button>
    </>}
    {promise.status === "active" && myResponsible && (!myResolution || (myResolution.result === "pending" && myResolution.confirmedBy.length === 0)) && <>
      <label className="field-label" htmlFor="evidence-note">履约证据说明</label>
      <input id="evidence-note" maxLength={120} value={evidenceNote} placeholder="例如：10 月 18 日晚一起做了饭（双方都在）" onChange={e => setEvidenceNote(e.target.value)} />
      <Button disabled={busy || !evidenceNote.trim()} onClick={() => act("promises/resolutions", { promiseId: promise.id, result: "fulfilled", note: evidenceNote })}>记录本次完成（待 TA 确认证据）</Button>
      <Button className="secondary" disabled={busy} onClick={() => act("promises/resolutions", { promiseId: promise.id, result: "unfulfilled" })}>确认未完成</Button>
    </>}
    {promise.status === "active" && myResponsible && myResolution?.result === "pending" && myResolution.confirmedBy.length > 0 && <>
      <p className="muted">已提交证据，等待 TA 确认：“{myResolution.note}”</p>
    </>}
    {promise.status === "active" && otherResolution?.result === "pending" && otherResolution.confirmedBy.length > 0 && <>
      <p className="muted">TA 提交了履约证据：“{otherResolution.note}”</p>
      <Button disabled={busy} onClick={() => act("promises/resolutions/confirm", { promiseId: promise.id, subjectUserId: other, outcome: "fulfilled" })}>确认这份证据</Button>
      <Button className="secondary" disabled={busy} onClick={() => act("promises/resolutions/confirm", { promiseId: promise.id, subjectUserId: other, outcome: "waived" })}>一起豁免这项承诺</Button>
    </>}
    {(["fulfilled", "unfulfilled"] as const).map(result => {
      const entry = myResolution?.result === result ? myResolution : otherResolution?.result === result ? otherResolution : null;
      if (!entry) return null;
      const subject = myResolution?.result === result ? user : other;
      return <Card className="tight" key={result}>
        <div className="me-row"><b>{result === "fulfilled" ? "已完成" : "未完成"}</b>
          <button className="text-button" disabled={busy} onClick={() => act("promises/resolutions/dispute", { promiseId: promise.id, subjectUserId: subject })}>申诉</button>
        </div>
        {entry.note && <p className="muted">证据：{entry.note}</p>}
      </Card>;
    })}
    <p className="muted">单方申诉不会直接扣分：分数冻结为“申诉中”，由人工复核后更新摘要版本。</p>
  </Modal>;
}

// 空间自定义（v2.2 需求 10）：只开放外观与展示项。
// 需求确认结论：可自定义 = 空间名称 / 空间主题 / 天数与纪念日显示；
// 不可自定义 = 履约计分规则、存证条款版本、对方资料、承诺与日记历史（公平性与合规边界）。
function SpaceSettingsModal({ open, onClose, relationshipId, settings, busy, act }: {
  open: boolean; onClose: () => void; relationshipId: string; settings: SpaceSettings;
  busy: boolean; act(path: string, body?: Record<string, unknown>): Promise<boolean>;
}) {
  const [name, setName] = useState(settings.name);
  const [theme, setTheme] = useState<SpaceTheme>(settings.theme);
  const [showDays, setShowDays] = useState(settings.showDays);
  useEffect(() => { if (open) { setName(settings.name); setTheme(settings.theme); setShowDays(settings.showDays); } }, [open, settings.name, settings.theme, settings.showDays]);
  if (!open) return null;
  return <Modal title="空间设置" onClose={onClose}>
    <label className="field-label" htmlFor="space-name">空间名称（16 字内，双方可见）</label>
    <input id="space-name" maxLength={16} value={name} placeholder="例如：小铃和阿响的小屋" onChange={e => setName(e.target.value)} />
    <label className="field-label">空间主题</label>
    <div className="theme-swatches">
      {(Object.keys(spaceThemeLabels) as SpaceTheme[]).map(key => (
        <button key={key} type="button" className={`theme-swatch theme-${key} ${theme === key ? "chosen" : ""}`}
          aria-pressed={theme === key} onClick={() => setTheme(key)}>
          <i aria-hidden="true" />{spaceThemeLabels[key]}
        </button>
      ))}
    </div>
    <label className="checkbox"><input type="checkbox" checked={showDays} onChange={e => setShowDays(e.target.checked)} />
      显示“在一起第 N 天”与纪念日倒计时（关闭后仅显示空间名称）</label>
    <p className="muted">任一成员都可以修改空间设置，改动立即对双方生效。</p>
    <Button disabled={busy || !name.trim()} onClick={async () => {
      if (await act("space-settings", { relationshipId, name: name.trim(), theme, showDays })) onClose();
    }}>保存空间设置</Button>
    <h3 style={{ marginTop: 16 }}>哪些内容不支持自定义</h3>
    <p className="muted">为保证公平与证据可信，以下内容不随空间外观变化：履约分与计分规则、存证条款与证据、对方的资料与授权、双方已确认的日记与承诺历史。</p>
  </Modal>;
}

export async function exportEvidence(recordId: string, user: string): Promise<void> {
  try {
    const data = await getV2<unknown>(`export?recordId=${recordId}&viewer=${user}`);
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url; link.download = `heartbell-evidence-${recordId}.json`;
    link.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    alert(e instanceof Error ? e.message : "导出失败");
  }
}
export async function retryAnchorTask(recordId: string, user: string): Promise<boolean> {
  try { await postV2("anchors/retry", { viewer: user, recordId }); return true; }
  catch { return false; }
}
