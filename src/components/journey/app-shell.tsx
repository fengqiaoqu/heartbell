"use client";
// V2 应用壳：四栏（相遇/了解/我们/相守）+ 头像进入“我的”（计划书 7.2/7.3）。
// v2.8（M03）：viewer 扩展为 A–F；摇铃/来铃弹窗移入「相遇」栏（多候选、按对象固定），
// “稍后决定”修复：延后的来铃保留在来铃区，可随时重新打开决定，不再直接丢失窗口。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PhoneFrame, Button, ErrorBanner, Avatar, BellIcon, BookIcon, ChatIcon, GiftIcon, HeartbellLogo } from "../ui";
import { Modal } from "../modal";
import { fetchState, friendlyError, postV2, V2ApiError } from "../../lib/client/v2-api";
import type { NotificationDto, V2StateView } from "../../lib/domain/view-dtos";
import type { DemoViewer } from "../../lib/server/demo-auth";
import { MeetTab } from "./meet-tab";
import { KnowTab } from "./know-tab";
import { UsTab } from "./us-tab";
import { FutureTab } from "./future-tab";
import { MeDrawer } from "./me-drawer";

export type TabId = "meet" | "know" | "us" | "future";
const tabs: { id: TabId; text: string; Icon: () => React.JSX.Element }[] = [
  { id: "meet", text: "相遇", Icon: BellIcon },
  { id: "know", text: "了解", Icon: ChatIcon },
  { id: "us", text: "我们", Icon: BookIcon },
  { id: "future", text: "相守", Icon: GiftIcon },
];

export function JourneyShell({ user }: { user: DemoViewer }) {
  const [view, setView] = useState<V2StateView | null>(null);
  const [tab, setTab] = useState<TabId>("meet");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [meOpen, setMeOpen] = useState(false);
  const [noticeOpen, setNoticeOpen] = useState(false);
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

  const act = useCallback(async (path: string, body: Record<string, unknown> = {}, extraHeaders?: Record<string, string>): Promise<boolean> => {
    setBusy(true); setError("");
    try {
      await postV2(path, { ...body, viewer: user }, extraHeaders);
      await refresh();
      return true;
    } catch (e) {
      setError(friendlyError(e));
      return false;
    } finally { setBusy(false); }
  }, [user, refresh]);

  // v2.5（反馈 4）：待确认数量（日记确认/承诺确认/履约证据确认 + 关系邀请），驱动「我们」角标与提醒横幅。
  const usPendingCount = useMemo(() =>
    (view?.us.timeline.filter(t => t.needsMyAction).length ?? 0) + (view?.us.incomingInvite ? 1 : 0),
    [view?.us.timeline, view?.us.incomingInvite]);
  const unread = view?.notifications ?? [];

  const badges: Record<TabId, boolean> = {
    meet: view?.meet.bells.some(b => b.status === "pending" && b.direction === "incoming") ?? false,
    know: false,
    us: usPendingCount > 0,
    future: false,
  };

  const markAllRead = useCallback(async () => {
    try { await postV2("notifications/read", { viewer: user, all: true }); await refresh(); }
    catch { /* 下次轮询再同步 */ }
  }, [user, refresh]);

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
        {tab === "meet" && <MeetTab view={view} user={user} busy={busy} act={act} switchTab={switchTab} onNeedAdult={() => setMeOpen(true)} />}
        {tab === "know" && <KnowTab view={view} user={user} busy={busy} act={act} switchTab={switchTab} />}
        {tab === "us" && <UsTab view={view} user={user} busy={busy} act={act} switchTab={switchTab} />}
        {tab === "future" && <FutureTab view={view} user={user} busy={busy} act={act} switchTab={switchTab} />}
      </>}
      <details className="demo-details">
        <summary>演示说明与边界</summary>
        <p>位置、用户与演示前史均为模拟数据，不显示真实距离。活动码只代表加入同一活动，不证明两人实际相邻，也不构成现实单身或真人核验。履约分仅反映应用内已记录事项，不代表人格、现实单身或未来表现。相守计划为“恋爱保险概念演示 · 使用演示点数”，点数不可购买、转让或提现。默认 preview 存证模式未连接真实链：只保留本地承诺指纹，不生成模拟交易链接。</p>
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
  </PhoneFrame>;
}
