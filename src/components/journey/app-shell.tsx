"use client";
// V2 应用壳：四栏（相遇/了解/我们/相守）+ 头像进入“我的”（计划书 7.2/7.3）。
// A/B 双窗口状态独立；?tab= 保存当前栏目，返回和刷新恢复位置。
// v2.5：站内通知铃铛（反馈 4）、「我们」栏红色数字角标、维护公告横幅（后台发布）。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PhoneFrame, Button, ErrorBanner, Avatar, BellIcon, BookIcon, ChatIcon, GiftIcon, HeartbellLogo } from "../ui";
import { Modal } from "../modal";
import { fetchState, friendlyError, postV2, V2ApiError } from "../../lib/client/v2-api";
import type { NotificationDto, V2StateView } from "../../lib/domain/view-dtos";
import { MeetTab } from "./meet-tab";
import { KnowTab } from "./know-tab";
import { UsTab } from "./us-tab";
import { FutureTab } from "./future-tab";
import { MeDrawer } from "./me-drawer";
import { ReportBlockDialog } from "../privacy/safety-center";

export type TabId = "meet" | "know" | "us" | "future";
const tabs: { id: TabId; text: string; Icon: () => React.JSX.Element }[] = [
  { id: "meet", text: "相遇", Icon: BellIcon },
  { id: "know", text: "了解", Icon: ChatIcon },
  { id: "us", text: "我们", Icon: BookIcon },
  { id: "future", text: "相守", Icon: GiftIcon },
];
const phrases = ["想认识你。", "想和你聊一聊。", "想一起喝杯咖啡。"];

export function JourneyShell({ user }: { user: "a" | "b" | "c" }) {
  const [view, setView] = useState<V2StateView | null>(null);
  const [tab, setTab] = useState<TabId>("meet");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [meOpen, setMeOpen] = useState(false);
  const [ringOpen, setRingOpen] = useState(false);
  const [noticeOpen, setNoticeOpen] = useState(false);
  const [reportBellOpen, setReportBellOpen] = useState(false); // v2.6：举报匿名铃声来源
  const [message, setMessage] = useState(phrases[0]);
  const [postponed, setPostponed] = useState<string[]>([]);
  const [sessionLost, setSessionLost] = useState(false); // v2.6：会话失效后停止轮询并回登录页
  const seenEcho = useRef(false);
  const scroll = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const urlTab = new URLSearchParams(window.location.search).get("tab");
    if (urlTab && ["meet", "know", "us", "future"].includes(urlTab)) setTab(urlTab as TabId);
  }, []);
  const switchTab = useCallback((next: TabId) => {
    setTab(next);
    const url = new URL(window.location.href);
    url.searchParams.set("tab", next);
    window.history.replaceState(null, "", url);
  }, []);

  const refresh = useCallback(async () => {
    // v2.6：401 = 会话失效（未登录/过期/退出）——停止轮询、清空业务视图并回登录页；
    // 403 业务拒绝仍按原错误处理，不误当退出。
    try {
      setView(await fetchState(user));
    } catch (e) {
      if (e instanceof V2ApiError && e.status === 401) {
        setSessionLost(true);
        setView(null);
        return;
      }
      throw e;
    }
  }, [user]);
  useEffect(() => {
    if (sessionLost) return; // 已失效不再轮询
    const poll = () => refresh().catch(e => setError(friendlyError(e)));
    poll();
    const timer = setInterval(poll, 1200);
    return () => clearInterval(timer);
  }, [refresh, sessionLost]);
  // 会话失效后 1.2 秒自动回对应登录页（保留当前栏目），期间显示明确提示。
  useEffect(() => {
    if (!sessionLost) return;
    const timer = setTimeout(() => {
      window.location.replace(`/login?account=${user}&tab=${tab}`);
    }, 1200);
    return () => clearTimeout(timer);
  }, [sessionLost, user, tab]);
  // 回响成功后引导到“了解”
  useEffect(() => {
    if (view?.know.hasAnyEcho && !seenEcho.current) {
      const anyAccepted = view.meet.bells.some(b => b.status === "accepted");
      if (anyAccepted) { seenEcho.current = true; switchTab("know"); }
    }
  }, [view?.know.hasAnyEcho, view?.meet.bells, switchTab]);
  useEffect(() => { scroll.current?.scrollTo({ top: 0 }); }, [tab]);

  const act = useCallback(async (path: string, body: Record<string, unknown> = {}): Promise<boolean> => {
    setBusy(true); setError("");
    try {
      await postV2(path, { ...body, viewer: user });
      await refresh();
      return true;
    } catch (e) {
      setError(friendlyError(e));
      return false;
    } finally { setBusy(false); }
  }, [user, refresh]);

  const incoming = useMemo(() =>
    view?.meet.bells.find(b => b.status === "pending" && b.to === user && !postponed.includes(b.id)) ?? null,
    [view?.meet.bells, user, postponed]);

  // v2.5（反馈 4）：待确认数量（日记确认/承诺确认/履约证据确认 + 关系邀请），驱动「我们」角标与提醒横幅。
  const usPendingCount = useMemo(() =>
    (view?.us.timeline.filter(t => t.needsMyAction).length ?? 0) + (view?.us.incomingInvite ? 1 : 0),
    [view?.us.timeline, view?.us.incomingInvite]);
  const unread = view?.notifications ?? [];

  const badges: Record<TabId, boolean> = {
    meet: view?.meet.bells.some(b => b.status === "pending" && b.to === user) ?? false,
    know: false,
    us: usPendingCount > 0,
    future: false,
  };

  const markAllRead = useCallback(async () => {
    try { await postV2("notifications/read", { viewer: user, all: true }); await refresh(); }
    catch { /* 下次轮询再同步 */ }
  }, [user, refresh]);

  const needsAdult = view && !view.me.adultDeclared;
  void needsAdult;

  return <PhoneFrame>
    <header className="app-header">
      <div className="brand"><HeartbellLogo size={32} /><span>心动铃铛<small>{view?.me.profile.nickname ?? "…"} · 演示窗口 {user.toUpperCase()}</small></span></div>
      <div className="header-actions">
        <button className="bell-button" aria-label={`站内提醒（${unread.length} 条未读）`} onClick={() => setNoticeOpen(true)}>
          <BellIcon />
          {unread.length > 0 && <i className="badge-num">{unread.length > 99 ? "99+" : unread.length}</i>}
        </button>
        <button className="avatar-button" aria-label="打开我的" onClick={() => setMeOpen(true)}>
          <Avatar value={view?.me.profile.avatar} size={38} className="avatar-in-button" />
        </button>
      </div>
    </header>
    <div className="phone-scroll" ref={scroll}>
      {error && <ErrorBanner message={error} onDismiss={() => setError("")} />}
      {/* v2.5：维护公告（后台「运行与审计 → 功能与公告」发布，服务端同步执行限制） */}
      {view?.publicMaintenance?.notice && <div className="maintenance-banner" role="status">📢 {view.publicMaintenance.notice}</div>}
      {/* v2.5（反馈 4）：有待确认事项时的提醒横幅 */}
      {view && usPendingCount > 0 && tab !== "us" && <div className="pending-banner" role="status">
        <span>🔔 你有 <b>{usPendingCount}</b> 项待确认的内容（{view.us.incomingInvite ? "关系邀请 · " : ""}日记或承诺）</span>
        <button className="text-button" onClick={() => switchTab("us")}>去处理</button>
      </div>}
      {sessionLost ? <div className="empty-state" role="status">
        <p>登录已失效，正在返回登录页……</p>
        <button className="text-button" onClick={() => window.location.replace(`/login?account=${user}&tab=${tab}`)}>立即重新登录</button>
      </div> : !view ? <div className="empty-state">正在连接演示服务……</div> : <>
        {tab === "meet" && <MeetTab view={view} user={user} busy={busy} act={act} switchTab={switchTab} onRing={() => setRingOpen(true)} onNeedAdult={() => setMeOpen(true)} />}
        {tab === "know" && <KnowTab view={view} user={user} busy={busy} act={act} switchTab={switchTab} />}
        {tab === "us" && <UsTab view={view} user={user} busy={busy} act={act} switchTab={switchTab} />}
        {tab === "future" && <FutureTab view={view} user={user} busy={busy} act={act} switchTab={switchTab} />}
      </>}
      <details className="demo-details">
        <summary>演示说明与边界</summary>
        <p>位置、用户与演示前史均为模拟数据，不显示真实距离。履约分仅反映应用内已记录事项，不代表人格、现实单身或未来表现。相守计划为“恋爱保险概念演示 · 使用演示点数”，点数不可购买、转让或提现。默认 preview 存证模式未连接真实链：只保留本地承诺指纹，不生成模拟交易链接。</p>
        <a href="/">返回演示入口</a> · <a href="/demo/admin" target="_blank" rel="noopener noreferrer">演示审核台</a> · <a href="/admin" target="_blank" rel="noopener noreferrer">维护后台</a>
      </details>
    </div>
    <nav className="bottom-nav" aria-label="主要导航">
      {tabs.map(({ id, text, Icon }) => (
        <button key={id} aria-current={tab === id ? "page" : undefined} className={tab === id ? "active" : ""}
          onClick={() => switchTab(id)}>
          <span>
            <Icon />
            {/* v2.5（反馈 4）：「我们」栏右上角红色数字角标（其余栏保持小圆点） */}
            {id === "us" && usPendingCount > 0
              ? <i className="notification-count">{usPendingCount > 99 ? "99+" : usPendingCount}</i>
              : badges[id] && <i className="notification-dot" />}
          </span>{text}
        </button>
      ))}
    </nav>

    <MeDrawer open={meOpen} onClose={() => setMeOpen(false)} view={view} busy={busy} act={act} />

    {noticeOpen && <Modal title="站内提醒" onClose={() => setNoticeOpen(false)}>
      {unread.length === 0 ? <>
        <p className="muted center" style={{ padding: "14px 0" }}>暂时没有新的提醒。</p>
        <p className="muted center">日记/承诺等待确认、履约证据待确认、核验结论等都会出现在这里。</p>
      </> : <>
        <div className="notice-list">
          {unread.map((n: NotificationDto) => <div className="notice-item" key={n.id}>
            <b>{n.title}</b>
            <small>{n.body}</small>
            <small className="muted">{new Date(n.createdAt).toLocaleString("zh-CN")}</small>
          </div>)}
        </div>
        <Button disabled={busy} onClick={markAllRead}>全部标为已读</Button>
      </>}
    </Modal>}

    {ringOpen && view && <Modal title="轻轻摇一下" onClose={() => setRingOpen(false)}>
      <div className="ring-bell-hero" aria-hidden="true"><span className="hb-ring" style={{ display: "inline-flex", width: 46, height: 46, color: "var(--brand)" }}><BellIcon /></span></div>
      <p>{view.meet.nearby[0]?.traits.map(t => t.value).join(" · ")}</p>
      {view.meet.nearby[0]?.bio && <p className="quote-sm">“{view.meet.nearby[0].bio}”</p>}
      <p className="muted">选择一句你想对 TA 说的话。同轮次对同一个人只能摇一次。</p>
      <div className="phrase-options">
        {phrases.map(phrase => (
          <button key={phrase} className={message === phrase ? "chosen" : ""} aria-pressed={message === phrase} onClick={() => setMessage(phrase)}>{phrase}</button>
        ))}
      </div>
      <Button disabled={busy} onClick={async () => { if (await act("ring", { message })) setRingOpen(false); }}>送出这次心动</Button>
    </Modal>}

    {incoming && <Modal title="叮——有人想认识你" onClose={() => setPostponed(p => [...p, incoming.id])}>
      <div className="reveal-avatar" aria-hidden="true"><span className="hb-ring" style={{ display: "inline-flex", width: 34, height: 34, color: "var(--brand)" }}><BellIcon /></span></div>
      <p className="center" style={{ fontSize: 18, color: "var(--brand)" }}>“{incoming.message}”</p>
      <p className="muted center">回响后，双方才会看到昵称、头像和兴趣。回响只代表愿意认识，不代表更多。</p>
      <Button disabled={busy} onClick={() => act("respond", { bellId: incoming.id, status: "accepted" })}>我也想认识 TA</Button>
      <Button className="secondary" disabled={busy} onClick={() => act("respond", { bellId: incoming.id, status: "dismissed" })}>让铃声消散</Button>
      <button className="text-button" onClick={() => setPostponed(p => [...p, incoming.id])}>稍后决定</button>
      {/* v2.6：未揭晓对象举报入口 —— 举报前不显示对方昵称/头像 */}
      <button className="text-button" style={{ color: "var(--danger)" }} onClick={() => setReportBellOpen(true)}>举报此铃声</button>
    </Modal>}

    {incoming && reportBellOpen && <ReportBlockDialog open onClose={() => setReportBellOpen(false)} viewer={user}
      sourceType="bell" sourceId={incoming.id} hasBinding={false} />}
  </PhoneFrame>;
}
