"use client";
// 相遇（计划书第 3 节 / UI-02/03）：特征、雷达、铃声列表与关系中停止雷达。
// v2.2 修复：倒计时只按服务端返回的到期时间推算，轮询刷新不再叠加本地秒数，
// 也不会在重进页面时“跳回”更长的剩余时间。
// v2.5（反馈 3）：秒级刷新在小屏上偶有跳变观感，取消秒数，只显示分钟。
import { useEffect, useRef, useState } from "react";
import { Button, Card, Chip, EmptyState, RingIcon, StageArt } from "../ui";
import type { V2StateView } from "../../lib/domain/view-dtos";
import type { TabId } from "./app-shell";

const categories = ["穿着", "配饰", "手持物", "当前状态", "其他"] as const;

function radarCountdown(msLeft: number): string {
  if (msLeft <= 0) return "本轮已结束";
  const minutes = Math.max(1, Math.ceil(msLeft / 60_000)); // 向上取整：不显示 0 分钟
  return `剩余约 ${minutes} 分钟`;
}

export function MeetTab({ view, user, busy, act, switchTab, onRing, onNeedAdult }: {
  view: V2StateView; user: string; busy: boolean;
  act(path: string, body?: Record<string, unknown>): Promise<boolean>;
  switchTab(tab: TabId): void;
  onRing(): void;
  onNeedAdult(): void;
}) {
  const [traits, setTraits] = useState<{ category: string; value: string }[]>(
    user === "a"
      ? [{ category: "穿着", value: "黑色外套" }, { category: "手持物", value: "拿着咖啡" }]
      : [{ category: "穿着", value: "白色上衣" }, { category: "配饰", value: "戴眼镜" }],
  );
  const [tick, setTick] = useState(0);
  useEffect(() => { const t = setInterval(() => setTick(v => v + 1), 1000); return () => clearInterval(t); }, []);
  useEffect(() => {
    if (view.meet.radarActive && view.meet.myTraits.length) setTraits(view.meet.myTraits);
  }, [view.meet.radarActive, view.meet.myTraits]);

  // 每次收到新的虚拟时钟就重置本地计时基准；两次轮询之间用真实时钟平滑推进。
  const syncRef = useRef({ virtualNow: view.modes.virtualNow, at: Date.now() });
  if (syncRef.current.virtualNow !== view.modes.virtualNow) {
    syncRef.current = { virtualNow: view.modes.virtualNow, at: Date.now() };
  }
  void tick; // tick 仅用于触发每秒重绘
  const remaining = view.meet.radarExpiresAt
    ? Math.max(0, view.meet.radarExpiresAt - view.modes.virtualNow - (Date.now() - syncRef.current.at))
    : 0;
  const target = view.meet.nearby[0] ?? null;

  if (view.meet.blockedByRelationship) {
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

  if (!view.meet.radarActive) {
    const declared = view.me.adultDeclared;
    return <>
      <p className="eyebrow">听见心动</p>
      <h1>听见一次心动</h1>
      <p className="muted">给刚刚注意到的人，一次回应的机会。留下两三个短暂特征，让心动的人认出你。</p>
      <StageArt stage="meet" />
      <Card>
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
        {declared
          ? (view.publicMaintenance.radarNewEnabled
              ? <Button disabled={busy || traits.some(t => !t.value.trim())}
                  onClick={() => act("radar", { active: true, traits: traits.map(t => ({ ...t, value: t.value.trim() })) })}>
                  {busy ? "准备中…" : "开启 10 分钟心动雷达"}
                </Button>
              : <Button disabled title="维护公告期内暂停新开启">雷达暂停新开启（维护中）</Button>)
          : <Button className="secondary" onClick={onNeedAdult}>先完成成年声明（在我的资料中，仅一次）</Button>}
        <p className="muted center">{view.meet.zoneLabel} · 开启才会被发现，可随时关闭。</p>
      </Card>
      <BellHistory view={view} />
    </>;
  }

  return <>
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
      <div><p className="eyebrow">或许，心动就在附近</p><h1>心动雷达</h1></div>
      <button className="text-button" disabled={busy} onClick={() => act("radar", { active: false, traits })}>关闭雷达</button>
    </div>
    <p className="muted">{view.meet.zoneLabel} · 本轮最长 10 分钟</p>
    <div className="radar" role="img" aria-label="心动雷达示意，不代表方向或距离">
      <div className="radar-core" aria-hidden="true"><span className="hb-ring" style={{ display: "inline-flex", width: 40, height: 40, color: "var(--brand)" }}><RingIcon /></span></div>
      {target && <span className="radar-dot">♡</span>}
    </div>
    <div className="countdown">{radarCountdown(remaining)}</div>
    {target ? <Card>
      <Chip tone="brand">发现一枚铃铛</Chip>
      <h3 style={{ marginTop: 8 }}>{target.traits.map(t => t.value).join(" · ")}</h3>
      {target.bio && <p className="quote-sm" style={{ margin: "6px 0" }}>“{target.bio}”</p>}
      <p className="muted">是你刚刚注意到的人吗？雷达只显示临时特征和这句话，不显示昵称、头像、分数和历史关系。</p>
      {view.meet.ringRoundUsed
        ? <Button disabled>{view.meet.waitingEcho ? "铃声已送出，等待回响" : "本轮已经摇过铃"}</Button>
        : <Button disabled={busy} onClick={onRing}>轻轻摇一下</Button>}
    </Card> : <EmptyState title="还没有发现附近的铃铛" hint="让另一位演示用户也开启雷达吧。" />}
    <BellHistory view={view} />
  </>;
}

function BellHistory({ view }: { view: V2StateView }) {
  const mine = view.meet.bells.filter(b => b.from === view.me.id);
  if (!mine.length) return null;
  return <Card className="tight">
    <h3>我送出的铃声</h3>
    {mine.map(b => <div className="me-row" key={b.id}>
      <span>“{b.message}”</span>
      <span>{b.status === "pending" ? <Chip tone="warning">等待回响</Chip> : b.status === "accepted" ? <Chip tone="success">已有回响</Chip> : <Chip>铃声已消散</Chip>}</span>
    </div>)}
  </Card>;
}
