"use client";
// 相遇（v2.8 M03 重写）：活动码入场 → 主动开启 10 分钟雷达 → 多张匿名候选卡 →
// 指定对象摇铃（弹窗固定对象，列表刷新不换人）→ 来铃区逐条决定。
// “稍后决定”修复（v2.8 修改单问题 1）：延后只是关闭弹窗，来铃仍保留在来铃区，
// 随时可重新打开决定；窗口不再直接丢失。页面明确显示“同一活动 · 演示账号”，
// 不虚构米数、方位、真人核验或现实单身证明。
import { useEffect, useRef, useState } from "react";
import { Button, Card, Chip, EmptyState, RingIcon, StageArt } from "../ui";
import { Modal } from "../modal";
import { ReportBlockDialog } from "../privacy/safety-center";
import type { V2StateView } from "../../lib/domain/view-dtos";
import type { TabId } from "./app-shell";

const categories = ["穿着", "配饰", "手持物", "当前状态", "其他"] as const;
const phrases = ["想认识你。", "想和你聊一聊。", "想一起喝杯咖啡。"];

type Candidate = V2StateView["meet"]["candidates"][number];
type IncomingBell = V2StateView["meet"]["bells"][number];

function radarCountdown(msLeft: number): string {
  if (msLeft <= 0) return "本轮已结束";
  const minutes = Math.max(1, Math.ceil(msLeft / 60_000)); // 向上取整：不显示 0 分钟
  return `剩余约 ${minutes} 分钟`;
}

export function MeetTab({ view, user, busy, act, switchTab, onNeedAdult }: {
  view: V2StateView; user: string; busy: boolean;
  act(path: string, body?: Record<string, unknown>, extraHeaders?: Record<string, string>): Promise<boolean>;
  switchTab(tab: TabId): void;
  onNeedAdult(): void;
}) {
  const meet = view.meet;
  const [code, setCode] = useState("");
  const [traits, setTraits] = useState<{ category: string; value: string }[]>(
    user === "a"
      ? [{ category: "穿着", value: "黑色外套" }, { category: "手持物", value: "拿着咖啡" }]
      : [{ category: "穿着", value: "白色上衣" }, { category: "配饰", value: "戴眼镜" }],
  );
  const [note, setNote] = useState("");
  // 摇铃弹窗固定对象（MD-08/AT-21）：打开时快照引用与展示内容，轮询刷新不替换目标。
  const [ringTarget, setRingTarget] = useState<{ ref: string; alias: string; traits: { category: string; value: string }[]; note: string } | null>(null);
  const [message, setMessage] = useState(phrases[0]);
  const [ringKey, setRingKey] = useState("");
  const [confirmSwitch, setConfirmSwitch] = useState<string | null>(null); // 待确认的换活动码
  const [bellOpen, setBellOpen] = useState<string | null>(null);           // 当前打开的来铃
  const [reportTarget, setReportTarget] = useState<{ ref?: string; bellId?: string } | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => { const t = setInterval(() => setTick(v => v + 1), 1000); return () => clearInterval(t); }, []);
  useEffect(() => {
    if (meet.radarActive && meet.myTraits.length) setTraits(meet.myTraits);
  }, [meet.radarActive, meet.myTraits]);

  // 倒计时：每次收到新的虚拟时钟就重置本地计时基准；两次轮询之间用真实时钟平滑推进。
  const syncRef = useRef({ virtualNow: view.modes.virtualNow, at: Date.now() });
  if (syncRef.current.virtualNow !== view.modes.virtualNow) {
    syncRef.current = { virtualNow: view.modes.virtualNow, at: Date.now() };
  }
  void tick;
  const remaining = meet.radarExpiresAt
    ? Math.max(0, meet.radarExpiresAt - view.modes.virtualNow - (Date.now() - syncRef.current.at))
    : 0;

  const incomingPending = meet.bells.filter(b => b.direction === "incoming" && b.status === "pending");
  const openBell = incomingPending.find(b => b.id === bellOpen) ?? null;

  function openRingModal(candidate: Candidate) {
    setRingTarget({
      ref: candidate.candidateRef, alias: candidate.alias,
      traits: candidate.traits.map(t => ({ ...t })), note: candidate.discoveryNote,
    });
    setMessage(phrases[0]);
    setRingKey(typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `ring-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  }

  async function submitRing() {
    if (!ringTarget) return;
    // 网络重试保持原请求和原键；用户另选对象或表达时生成新键（打开弹窗时已生成）。
    const ok = await act("ring", { candidateRef: ringTarget.ref, message, idempotencyKey: ringKey }, { "Idempotency-Key": ringKey });
    if (ok) setRingTarget(null);
  }

  // ---------- 已有关系：雷达停止 ----------
  if (meet.blockedByRelationship) {
    return <>
      <p className="eyebrow">听见心动</p>
      <h1>你们的故事<br />正在继续</h1>
      <p className="muted">已有有效关系时，陌生人恋爱雷达已停止。发现新的人之前，先把眼前的关系好好走完。</p>
      <StageArt stage="us" />
      <Card><EmptyState title="雷达已安静" hint="服务端已拦截摇铃与开启请求，不只是隐藏按钮。" />
        <Button onClick={() => switchTab("us")}>去我们的空间</Button>
      </Card>
    </>;
  }

  // ---------- 未加入活动：活动码入场（MD-02） ----------
  if (!meet.event.joined) {
    return <>
      <p className="eyebrow">听见心动</p>
      <h1>从一个活动开始</h1>
      <p className="muted">输入现场活动码加入同一活动，再开启 10 分钟心动雷达。活动码只代表加入同一活动，不证明两人实际相邻，也不构成现实单身或真人核验。</p>
      <StageArt stage="meet" />
      <Card>
        <h3>加入活动</h3>
        <label className="field-label" htmlFor="event-code">活动码（8 位）</label>
        <input id="event-code" maxLength={16} value={code} placeholder="例如 HEARTS26" style={{ textTransform: "uppercase" }}
          onChange={e => { setCode(e.target.value); setConfirmSwitch(null); }} />
        {meet.joinCooldownSeconds > 0
          ? <Button disabled title="连续失败后冷却">尝试过于频繁（约 {meet.joinCooldownSeconds} 秒后再试）</Button>
          : <Button disabled={busy || !code.trim()}
              onClick={() => act("meet/events/join", { code: code.trim() })}>加入活动</Button>}
        {confirmSwitch && <p className="muted" style={{ color: "var(--danger)" }}>
          你已在另一个活动中。换活动会关闭当前雷达和未处理的铃声。
          <button className="text-button" disabled={busy}
            onClick={async () => { if (await act("meet/events/join", { code: confirmSwitch, replaceCurrent: true })) setConfirmSwitch(null); }}>
            确认换到这个活动
          </button>
        </p>}
        <p className="muted center">同一时间只能参加一个活动；换活动需要确认。活动列表不对外公开。</p>
      </Card>
      <BellHistory view={view} />
    </>;
  }

  // ---------- 已入场、雷达未开：特征 + 相遇留言 ----------
  if (!meet.radarActive) {
    const declared = view.me.adultDeclared;
    const reason = meet.ineligibleReason;
    return <>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
        <div><p className="eyebrow">同一活动</p><h1>{meet.event.eventName}</h1></div>
        <button className="text-button" disabled={busy} onClick={() => { if (confirm("退出后本轮雷达与未处理铃声将结束；已建立的连接保留。确定退出活动？")) void act("meet/events/leave", {}); }}>退出活动</button>
      </div>
      <p className="muted">{meet.event.status === "open" ? "活动进行中 · 演示账号" : "活动已暂停或结束"} · 同一活动不代表实际相邻</p>
      {reason === "event_not_open" ? <EmptyState title="活动当前不可用" hint="活动可能被暂停、到期或关闭；恢复开放后可以重新开启雷达。" />
        : reason === "restriction" ? <EmptyState title="暂时无法开启雷达" hint="账号处于限时发现限制期；救济操作不受影响。" />
        : <Card>
        <h3>今天的你</h3>
        <div className="traits" style={{ display: "grid", gap: 8, marginTop: 8 }}>
          {traits.map((trait, i) => (
            <div className="trait-row" key={i}>
              <select aria-label={`特征 ${i + 1} 类别`} value={trait.category}
                onChange={e => setTraits(traits.map((t, j) => j === i ? { ...t, category: e.target.value } : t))}>
                {categories.map(c => <option key={c}>{c}</option>)}
              </select>
              <input aria-label={`特征 ${i + 1} 内容`} maxLength={20} value={trait.value} placeholder="此刻的样子"
                onChange={e => setTraits(traits.map((t, j) => j === i ? { ...t, value: e.target.value } : t))} />
            </div>
          ))}
        </div>
        <button className="text-button" onClick={() => setTraits(traits.length === 2 ? [...traits, { category: "其他", value: "" }] : traits.slice(0, 2))}>
          {traits.length === 2 ? "+ 添加一项" : "移除第三项"}
        </button>
        <label className="field-label" htmlFor="discovery-note" style={{ marginTop: 8 }}>相遇留言（可选，60 字内，会展示给同活动候选）</label>
        <input id="discovery-note" maxLength={60} value={note} placeholder="例如：在吧台附近，穿黑色外套的就是我"
          onChange={e => setNote(e.target.value)} />
        {declared
          ? (view.publicMaintenance.radarNewEnabled
              ? <Button disabled={busy || traits.some(t => !t.value.trim())}
                  onClick={() => act("radar", { active: true, traits: traits.map(t => ({ ...t, value: t.value.trim() })), discoveryNote: note.trim() })}>
                  {busy ? "准备中…" : "开启 10 分钟心动雷达"}
                </Button>
              : <Button disabled title="维护公告期内暂停新开启">雷达暂停新开启（维护中）</Button>)
          : <Button className="secondary" onClick={onNeedAdult}>先完成成年声明（在我的资料中，仅一次）</Button>}
        <p className="muted center">{meet.zoneLabel} · 开启才会被发现，可随时关闭。留言与特征只在本轮展示，不复制你的长期资料。</p>
      </Card>}
      <IncomingBells bells={incomingPending} onOpen={setBellOpen} />
      <BellHistory view={view} />
    </>;
  }

  // ---------- 雷达已开：多候选卡（MD-05/06/08） ----------
  return <>
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
      <div><p className="eyebrow">{meet.event.eventName}</p><h1>心动雷达</h1></div>
      <button className="text-button" disabled={busy} onClick={() => act("radar", { active: false })}>关闭雷达</button>
    </div>
    <p className="muted">{meet.zoneLabel} · 本轮最长 10 分钟 · 更新特征不延长时长</p>
    <div className="radar" role="img" aria-label="心动雷达示意，不代表方向或距离">
      <div className="radar-core" aria-hidden="true"><span className="hb-ring" style={{ display: "inline-flex", width: 40, height: 40, color: "var(--brand)" }}><RingIcon /></span></div>
      {meet.candidates.length > 0 && <span className="radar-dot">♡</span>}
    </div>
    <div className="countdown">{radarCountdown(remaining)}</div>

    {meet.candidates.length === 0
      ? <EmptyState title="活动里暂时没有可见候选" hint="候选需要双方都在本活动并开启雷达；已认识或已关闭连接的人不会重复出现。" />
      : meet.candidates.map(candidate => <Card key={candidate.candidateRef}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <Chip tone="brand">{candidate.alias}</Chip>
          {candidate.ringState === "pending" && <Chip tone="warning">等待回响</Chip>}
        </div>
        <h3 style={{ marginTop: 8 }}>{candidate.traits.map(t => t.value).join(" · ")}</h3>
        {candidate.discoveryNote && <p className="quote-sm" style={{ margin: "6px 0" }}>“{candidate.discoveryNote}”</p>}
        <p className="muted">同一活动的匿名候选：只显示本轮临时特征和留言，不显示昵称、头像、分数和历史关系。</p>
        {candidate.canRing
          ? <Button disabled={busy} onClick={() => openRingModal(candidate)}>轻轻摇一下</Button>
          : candidate.ringState === "pending"
            ? <Button disabled>铃声已送出，等待回响</Button>
            : <Button disabled title="冷却中">{candidate.retryAfterSeconds ? `稍后可再摇（约 ${Math.ceil(candidate.retryAfterSeconds / 60)} 分钟）` : "本轮已摇过"}</Button>}
        <button className="text-button" style={{ color: "var(--danger)" }} onClick={() => setReportTarget({ ref: candidate.candidateRef })}>举报 / 屏蔽此候选</button>
      </Card>)}

    <IncomingBells bells={incomingPending} onOpen={setBellOpen} />
    <BellHistory view={view} />

    {/* 摇铃弹窗：对象固定（MD-08）—— 列表刷新/重排不切换目标；引用失效提示重新选择，不自动改发 */}
    {ringTarget && <Modal title="轻轻摇一下" onClose={() => setRingTarget(null)}>
      <div className="ring-bell-hero" aria-hidden="true"><span className="hb-ring" style={{ display: "inline-flex", width: 46, height: 46, color: "var(--brand)" }}><RingIcon /></span></div>
      <p><b>{ringTarget.alias}</b> · {ringTarget.traits.map(t => t.value).join(" · ")}</p>
      {ringTarget.note && <p className="quote-sm">“{ringTarget.note}”</p>}
      <p className="muted">选择一句你想对 TA 说的话。铃声只会发给这一张卡对应的对象；10 分钟内对同一人只能摇一次。</p>
      <div className="phrase-options">
        {phrases.map(phrase => (
          <button key={phrase} className={message === phrase ? "chosen" : ""} aria-pressed={message === phrase} onClick={() => setMessage(phrase)}>{phrase}</button>
        ))}
      </div>
      <Button disabled={busy} onClick={submitRing}>送出这次心动</Button>
    </Modal>}

    {/* 来铃决定弹窗：稍后决定 = 只关弹窗，来铃留在来铃区（v2.8 修复） */}
    {openBell && <Modal title="叮——有人想认识你" onClose={() => setBellOpen(null)}>
      <div className="reveal-avatar" aria-hidden="true"><span className="hb-ring" style={{ display: "inline-flex", width: 34, height: 34, color: "var(--brand)" }}><RingIcon /></span></div>
      <p className="center" style={{ fontSize: 18, color: "var(--brand)" }}>“{openBell.message}”</p>
      <p className="muted center">来自 <b>{openBell.counterpartyAlias}</b>{openBell.counterpartyTraits.length ? ` · ${openBell.counterpartyTraits.map(t => t.value).join(" · ")}` : ""}</p>
      {openBell.counterpartyNote && <p className="quote-sm center">“{openBell.counterpartyNote}”</p>}
      <p className="muted center">回响后，双方才会看到昵称、头像和兴趣。回响只代表愿意认识，不代表更多。</p>
      <Button disabled={busy} onClick={() => { void act("respond", { bellId: openBell.id, status: "accepted" }).then(ok => { if (ok) setBellOpen(null); }); }}>我也想认识 TA</Button>
      <Button className="secondary" disabled={busy} onClick={() => { void act("respond", { bellId: openBell.id, status: "dismissed" }).then(ok => { if (ok) setBellOpen(null); }); }}>让铃声消散</Button>
      <button className="text-button" onClick={() => setBellOpen(null)}>稍后决定（保留在来铃区）</button>
      <button className="text-button" style={{ color: "var(--danger)" }} onClick={() => setReportTarget({ bellId: openBell.id })}>举报此铃声</button>
    </Modal>}

    {reportTarget && (reportTarget.ref
      ? <ReportBlockDialog open onClose={() => setReportTarget(null)} viewer={view.me.id}
          sourceType="candidate" sourceId={reportTarget.ref} candidateRef={reportTarget.ref} hasBinding={false} />
      : <ReportBlockDialog open onClose={() => setReportTarget(null)} viewer={view.me.id}
          sourceType="bell" sourceId={reportTarget.bellId!} hasBinding={false} />)}
  </>;
}

// 来铃区：所有自己的待处理来铃逐条展示（MD-09/AT-36：多人来铃不覆盖）。
function IncomingBells({ bells, onOpen }: {
  bells: IncomingBell[];
  onOpen(id: string): void;
}) {
  if (!bells.length) return null;
  return <Card className="tight">
    <h3>来铃（{bells.length}）<span className="muted" style={{ fontSize: 11, fontWeight: 400 }}> · 稍后决定的会一直保留在这里</span></h3>
    {bells.map(b => <div className="me-row" key={b.id} style={{ alignItems: "center" }}>
      <span>“{b.message}” · {b.counterpartyAlias}</span>
      <span style={{ display: "flex", gap: 8 }}>
        <button className="text-button" onClick={() => onOpen(b.id)}>现在决定</button>
      </span>
    </div>)}
    <p className="muted">接受后会进入对应的「了解」连接；忽略无需对方同意。</p>
  </Card>;
}

function BellHistory({ view }: { view: V2StateView }) {
  const mine = view.meet.bells.filter(b => b.direction === "outgoing");
  if (!mine.length) return null;
  return <Card className="tight">
    <h3>我送出的铃声</h3>
    {mine.map(b => <div className="me-row" key={b.id}>
      <span>“{b.message}” · {b.counterpartyAlias}</span>
      <span>{b.status === "pending" ? <Chip tone="warning">等待回响</Chip>
        : b.status === "accepted" ? <Chip tone="success">已有回响</Chip>
        : b.status === "superseded" ? <Chip tone="success">已通过另一条铃声连接</Chip>
        : <Chip>铃声已消散</Chip>}</span>
    </div>)}
  </Card>;
}
