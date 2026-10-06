"use client";
// 我的（计划书 UI-16 / v2.1 / v2.2）：完整资料编辑（称呼/头像/性取向（可自由填写其他）/出生年代/介绍/爱好标签/MBTI）、
// 成年声明（一次性，在资料内勾选）、联系方式多栏（微信/手机号默认 + 可添加）、授权管理、钱包、账本。
// v2.2 修复：编辑草稿不再被 1.2s 轮询刷新覆盖（此前输入内容会被清空）。
import { useEffect, useState } from "react";
import { Avatar, Button, Chip } from "../ui";
import { Modal } from "../modal";
import { AvatarZoom } from "../avatar-zoom";
import { WalletPanel } from "../wallet-panel";
import type { V2StateView } from "../../lib/domain/view-dtos";
import { ageCohorts, intentionLabels, mbtiOptions, orientationDisplay, orientationLabels, type ContactEntry, type Intention, type Orientation } from "../../lib/domain/v2-types";
import { officialAvatars } from "../../lib/domain/avatars";
import { SafetyCenter } from "../privacy/safety-center";
import { exportEvidence } from "./us-tab";

type ProfileDraft = {
  nickname: string; ageWindow: string; orientation: Orientation | ""; orientationCustom: string;
  mbti: string; bio: string; intention: Intention; interests: string[]; contacts: ContactEntry[]; avatar: string;
};

const emptyDraft = (v: V2StateView): ProfileDraft => ({
  nickname: v.me.profile.nickname,
  ageWindow: v.me.profile.ageWindow,
  orientation: v.me.profile.orientation ?? "",
  orientationCustom: v.me.profile.orientationCustom ?? "",
  mbti: v.me.profile.mbti ?? "",
  bio: v.me.profile.bio,
  intention: v.me.profile.intention,
  interests: [...v.me.profile.interests],
  contacts: v.me.profile.contacts.length
    ? v.me.profile.contacts.map(c => ({ ...c }))
    : [{ id: "c-wechat", label: "微信", value: "" }, { id: "c-phone", label: "手机号", value: "" }],
  avatar: v.me.profile.avatar,
});

// 上传头像：本地压缩到 256×256 JPEG（≤220KB），演示仓库内保存 base64，不上传任何服务器。
async function readAvatarFile(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) throw new Error("请选择图片文件");
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("读取图片失败"));
    reader.readAsDataURL(file);
  });
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("图片解码失败"));
    image.src = dataUrl;
  });
  const canvas = document.createElement("canvas");
  const scale = Math.min(1, 256 / Math.max(img.width, img.height));
  canvas.width = Math.max(1, Math.round(img.width * scale));
  canvas.height = Math.max(1, Math.round(img.height * scale));
  canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.85);
}

export function MeDrawer({ open, onClose, view, busy, act }: {
  open: boolean; onClose: () => void; view: V2StateView | null; busy: boolean;
  act(path: string, body?: Record<string, unknown>): Promise<boolean>;
}) {
  const [walletOpen, setWalletOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [safetyOpen, setSafetyOpen] = useState(false); // v2.6：安全与隐私中心
  const [logoutBusy, setLogoutBusy] = useState(false);
  const [draft, setDraft] = useState<ProfileDraft | null>(null);
  const [interestInput, setInterestInput] = useState("");
  const [avatarError, setAvatarError] = useState("");
  const [grantOpen, setGrantOpen] = useState(false); // v2.8：按对象发授权
  const [grantConn, setGrantConn] = useState<string>("");
  const [grantScope, setGrantScope] = useState<"profile_contact" | "trust_summary">("profile_contact");
  // 仅在打开编辑时取一次当前资料做草稿；轮询刷新 view 不再重置草稿（v2.2 修复）。
  useEffect(() => {
    if (editOpen && view && draft === null) setDraft(emptyDraft(view));
  }, [editOpen, view, draft]);
  if (!open || !view) return null;
  const me = view.me;
  const p = me.profile;

  function closeEdit() {
    setEditOpen(false);
    setDraft(null);
    setInterestInput("");
    setAvatarError("");
  }

  function saveProfile() {
    if (!draft) return;
    act("profile", {
      nickname: draft.nickname.trim() || p.nickname,
      avatar: draft.avatar,
      ageWindow: draft.ageWindow,
      orientation: draft.orientation || null,
      orientationCustom: draft.orientation === "other" ? draft.orientationCustom.trim() : "",
      mbti: draft.mbti || null,
      bio: draft.bio.trim(),
      intention: draft.intention,
      interests: draft.interests,
      contacts: draft.contacts.filter(c => c.label.trim() && c.value.trim()),
    }).then(ok => { if (ok) closeEdit(); });
  }

  return <>
    <Modal title="我的" onClose={onClose}>
      <div className="profile-head">
        <AvatarZoom value={p.avatar} size={64} className="reveal-avatar" />
        <div>
          <h3 style={{ margin: 0 }}>{p.nickname}</h3>
          <span className="intent-badge">意向：{intentionLabels[p.intention]}</span>
        </div>
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
        <Button className="secondary small" onClick={() => setEditOpen(true)}>编辑个人资料</Button>
        <Button className="secondary small" onClick={() => setSafetyOpen(true)}>安全与隐私</Button>
      </div>
      <div className="me-row" style={{ marginTop: 10 }}><b>登录账号</b><span>Demo {me.id.toUpperCase()}（{me.id}）</span></div>
      <button className="text-button" style={{ padding: 0 }} disabled={logoutBusy}
        onClick={async () => {
          setLogoutBusy(true);
          try {
            await fetch("/api/demo-auth/logout", {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ viewer: me.id }),
            });
          } catch { /* 重复退出也成功 */ }
          window.location.replace(`/login?account=${me.id}`);
        }}>{logoutBusy ? "退出中…" : "退出登录"}</button>

      <h3 style={{ marginTop: 16 }}>我的资料</h3>
      <div className="me-row"><b>出生年代</b><span>{p.ageWindow || "未填写"}</span></div>
      <div className="me-row"><b>性取向</b><span>{p.orientation ? orientationDisplay(p.orientation, p.orientationCustom) : "未填写"}</span></div>
      <div className="me-row"><b>MBTI</b><span>{p.mbti ?? "未填写"}</span></div>
      <div className="me-row"><b>一句话介绍</b><span style={{ textAlign: "right" }}>{p.bio || "未填写"}</span></div>
      <div className="me-row" style={{ alignItems: "flex-start" }}><b>爱好标签</b>
        <span className="interest-tags" style={{ justifyContent: "flex-end" }}>
          {p.interests.length ? p.interests.map(i => <span key={i}>{i}</span>) : "未填写"}
        </span>
      </div>

      <div className="me-row"><b>成年声明</b>
        {me.adultDeclared
          ? <Chip tone="success">已声明（演示声明，非真人核验）</Chip>
          : <label className="checkbox" style={{ margin: 0 }}>
              <input type="checkbox" disabled={busy} onChange={e => { if (e.target.checked) act("declare-adult"); }} />
              我已年满 18 岁（勾选一次即可，无需每次重复）
            </label>}
      </div>
      <p className="muted">成年声明与真实年龄核验是两回事；未接入真人服务时不显示“真人认证”。</p>

      <h3 style={{ marginTop: 16 }}>平台已验证事项</h3>
      {me.verificationLevels.map(v => <div className="me-row" key={v.label}><b>{v.label}</b>{v.verified ? <Chip tone="success">已验证</Chip> : <Chip tone="outline">未接入</Chip>}</div>)}

      <h3 style={{ marginTop: 16 }}>演示资产（与履约分完全独立）</h3>
      <div className="me-row"><b>演示点数</b><span className="points">{me.balance} 点（不可购买/转让/提现）</span></div>
      <div className="me-row"><b>玫瑰演示券</b><span className="points">{me.roseTickets} 张（不可实际核销）</span></div>
      <p className="muted">履约分是 0–100 的参考值：不能充值、消费或换礼物；投入或领取多少点数不影响履约分。</p>

      <h3 style={{ marginTop: 16 }}>我发出的授权</h3>
      {me.grantsIssued.length === 0 && <p className="muted">还没有向任何人授权。授权按对象和范围（联系方式 / 履约摘要）分别授予，默认 72 小时有效，可随时撤销。</p>}
      <div className="grant-list">
        {me.grantsIssued.map(g => (
          <div className={`grant-item ${g.active ? "" : "expired"}`} key={g.id}>
            <span>{g.audienceLabel} · {g.scopeLabel}</span>
            {g.active ? <Chip tone="success">生效中</Chip> : g.revokedAt ? <Chip tone="outline">已撤销</Chip> : <Chip tone="outline">已过期</Chip>}
            {g.active && <button className="text-button" disabled={busy} onClick={() => act("share-grants/revoke", { grantId: g.id })}>撤销</button>}
          </div>
        ))}
      </div>
      {/* v2.8（MD-11）：抽屉授权入口必须选择接收对象 —— 单独取第一个连接不再被后端接受。 */}
      <Button className="secondary small" disabled={busy} onClick={() => setGrantOpen(true)}>发起新授权</Button>

      <h3 style={{ marginTop: 16 }}>钱包</h3>
      <p className="muted">钱包仅用于真实存证签名（当前 preview 模式无需钱包，存证不会报“需要钱包”的错误）。钱包断开只影响签名，不影响已保存日记。</p>
      <WalletPanel open={walletOpen} onOpenChange={setWalletOpen} />

      <h3 style={{ marginTop: 16 }}>最近账本</h3>
      <div className="ledger-mini">
        {me.ledger.slice(0, 8).map(e => (
          <div key={e.id}>
            <span className="muted">{e.note || e.type}</span>
            <span className={e.to.startsWith("user:") ? "plus" : "minus"}>{e.to.startsWith("user:") ? "+" : "−"}{e.amount}{e.unit === "rose-ticket" ? " 券" : " 点"}</span>
          </div>
        ))}
      </div>

      {view.modes.chainMode === "preview" && <p className="muted" style={{ marginTop: 12 }}>存证模式：preview（未连接真实链，无需钱包）。已生成的承诺指纹可在各记录的“查看证据”中导出证据包核验。</p>}
      <details className="demo-details"><summary>运行模式</summary>
        <p>APP_MODE={view.modes.appMode} · CHAIN_MODE={view.modes.chainMode} · REWARD_MODE={view.modes.rewardMode} · CLAIM_VERIFIER_MODE={view.modes.claimVerifierMode}</p>
        <p>虚拟业务时间：{new Date(view.modes.virtualNow).toLocaleString("zh-CN")}（演示台可推进，不修改系统或链上时间）</p>
      </details>
    </Modal>

    {/* v2.8（MD-11）：按对象发授权 —— 选择开放连接与范围；只有一个连接时预选但仍显示接收对象。 */}
    {grantOpen && view && <Modal title="发起新授权" onClose={() => setGrantOpen(false)}>
      {(() => {
        const openConns = view.know.connections.filter(c => !c.closed);
        if (!openConns.length) return <>
          <p className="muted">还没有已回响的连接。先在「相遇」摇铃并获得回响，才能向对方授权。</p>
          <Button className="ghost" onClick={() => setGrantOpen(false)}>知道了</Button>
        </>;
        const selected = openConns.find(c => c.id === grantConn) ?? openConns[0];
        return <>
          <label className="field-label">接收对象（已回响的连接）</label>
          <div className="choice-list">
            {openConns.map(c => (
              <button key={c.id} className={selected.id === c.id ? "chosen" : ""}
                onClick={() => setGrantConn(c.id)}>{c.profile?.nickname ?? "匿名连接"}</button>
            ))}
          </div>
          <label className="field-label">授权范围</label>
          <div className="choice-list">
            <button className={grantScope === "profile_contact" ? "chosen" : ""} onClick={() => setGrantScope("profile_contact")}>查看我的联系方式</button>
            <button className={grantScope === "trust_summary" ? "chosen" : ""} onClick={() => setGrantScope("trust_summary")}>查看我的履约摘要</button>
          </div>
          <p className="muted">授权有效期 72 小时，可随时撤销；重复授权同一对象同一范围会复用现有授权，不会悄悄延长。</p>
          <Button disabled={busy} onClick={async () => {
            if (await act("share-grants", { scope: grantScope, connectionId: selected.id })) setGrantOpen(false);
          }}>确认授权给 {selected.profile?.nickname ?? "对方"}</Button>
        </>;
      })()}
    </Modal>}

    {editOpen && draft && <Modal title="编辑个人资料" onClose={closeEdit}>
      <label className="field-label" htmlFor="pf-nickname">称呼</label>
      <input id="pf-nickname" maxLength={16} value={draft.nickname} onChange={e => setDraft({ ...draft, nickname: e.target.value })} />

      <label className="field-label">头像（6 个官方头像，或自由上传）</label>
      <div className="avatar-grid">
        {officialAvatars.map(a => (
          <button key={a.id} type="button" className={`avatar-option ${draft.avatar === `def:${a.id}` ? "chosen" : ""}`}
            aria-pressed={draft.avatar === `def:${a.id}`} title={a.label}
            onClick={() => { setDraft({ ...draft, avatar: `def:${a.id}` }); setAvatarError(""); }}>
            <Avatar value={`def:${a.id}`} size={44} />
            <small>{a.label}</small>
          </button>
        ))}
      </div>
      <div className="avatar-upload-row">
        <label className="text-button" style={{ cursor: "pointer" }}>
          + 上传自定义头像
          <input type="file" accept="image/*" style={{ display: "none" }}
            onChange={async e => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (!file) return;
              try {
                const dataUrl = await readAvatarFile(file);
                setDraft(d => (d ? { ...d, avatar: dataUrl } : d));
                setAvatarError("");
              } catch (err) {
                setAvatarError(err instanceof Error ? err.message : "头像处理失败");
              }
            }} />
        </label>
        <Avatar value={draft.avatar} size={40} />
      </div>
      {avatarError && <p className="muted" style={{ color: "var(--danger)" }}>{avatarError}</p>}
      <p className="muted">上传的图片仅保存在本地演示环境，压缩到 256×256 后使用。</p>

      <label className="field-label" htmlFor="pf-age">出生年代</label>
      <select id="pf-age" value={draft.ageWindow} aria-label="出生年代" onChange={e => setDraft({ ...draft, ageWindow: e.target.value })}>
        <option value="">未填写</option>
        {ageCohorts.map(c => <option key={c} value={c}>{c}</option>)}
      </select>

      <label className="field-label">性取向</label>
      <select value={draft.orientation} aria-label="性取向" onChange={e => setDraft({ ...draft, orientation: e.target.value as Orientation | "" })}>
        <option value="">未填写</option>
        {(Object.keys(orientationLabels) as Orientation[]).map(o => <option key={o} value={o}>{orientationLabels[o]}</option>)}
      </select>
      {draft.orientation === "other" && <>
        <label className="field-label" htmlFor="pf-orientation-custom">自由填写（12 字内，仅本人主动公开）</label>
        <input id="pf-orientation-custom" maxLength={12} placeholder="例如：泛性恋 / 待探索" value={draft.orientationCustom}
          onChange={e => setDraft({ ...draft, orientationCustom: e.target.value })} />
      </>}

      <label className="field-label">MBTI</label>
      <select value={draft.mbti} aria-label="MBTI" onChange={e => setDraft({ ...draft, mbti: e.target.value })}>
        <option value="">未填写</option>
        {mbtiOptions.map(m => <option key={m} value={m}>{m}</option>)}
      </select>
      <label className="field-label" htmlFor="pf-bio">一句话介绍（响铃阶段对方可见的最小资料）</label>
      <input id="pf-bio" maxLength={120} value={draft.bio} onChange={e => setDraft({ ...draft, bio: e.target.value })} />
      <label className="field-label">爱好标签（最多 8 个）</label>
      <div className="interest-tags">
        {draft.interests.map((tag, i) => (
          <span key={tag} style={{ cursor: "pointer" }} title="点击移除"
            onClick={() => setDraft({ ...draft, interests: draft.interests.filter((_, j) => j !== i) })}>
            {tag} ×
          </span>
        ))}
      </div>
      <div className="trait-row" style={{ marginTop: 6 }}>
        <input aria-label="新标签" maxLength={10} placeholder="输入后回车添加" value={interestInput}
          onChange={e => setInterestInput(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter" && interestInput.trim() && draft.interests.length < 8 && !draft.interests.includes(interestInput.trim())) {
              setDraft({ ...draft, interests: [...draft.interests, interestInput.trim()] });
              setInterestInput("");
            }
          }} />
        <Button className="secondary small" style={{ marginTop: 0 }}
          onClick={() => {
            if (interestInput.trim() && draft.interests.length < 8 && !draft.interests.includes(interestInput.trim())) {
              setDraft({ ...draft, interests: [...draft.interests, interestInput.trim()] });
              setInterestInput("");
            }
          }}>添加</Button>
      </div>
      <label className="field-label">联系方式（1–5 栏，授权后对方可见）</label>
      <div style={{ display: "grid", gap: 8 }}>
        {draft.contacts.map((c, i) => (
          <div className="trait-row" key={i}>
            <input aria-label={`联系方式 ${i + 1} 名称`} maxLength={12} value={c.label} placeholder="微信 / 手机号 / 自定义"
              onChange={e => setDraft({ ...draft, contacts: draft.contacts.map((x, j) => j === i ? { ...x, label: e.target.value } : x) })} />
            <div style={{ display: "flex", gap: 6 }}>
              <input aria-label={`联系方式 ${i + 1} 内容`} maxLength={40} value={c.value} placeholder="号码 / ID"
                onChange={e => setDraft({ ...draft, contacts: draft.contacts.map((x, j) => j === i ? { ...x, value: e.target.value } : x) })} />
              <button className="text-button" aria-label="删除此栏" onClick={() => setDraft({ ...draft, contacts: draft.contacts.filter((_, j) => j !== i) })}>×</button>
            </div>
          </div>
        ))}
      </div>
      {draft.contacts.length < 5 && <button className="text-button" onClick={() => setDraft({ ...draft, contacts: [...draft.contacts, { id: `c-new-${draft.contacts.length}`, label: "", value: "" }] })}>+ 添加联系方式</button>}
      <label className="field-label">交往意向</label>
      <div className="choice-list">
        {(Object.keys(intentionLabels) as Intention[]).map(key => (
          <button key={key} className={draft.intention === key ? "chosen" : ""} onClick={() => setDraft({ ...draft, intention: key })}>{intentionLabels[key]}</button>
        ))}
      </div>
      <p className="muted">性取向与出生年代由你本人填写并主动公开；双方知情同意的交往选择本身不构成失信，也不进入履约分。</p>
      <Button disabled={busy || !draft.nickname.trim() || !draft.bio.trim() || draft.contacts.some(c => (c.label.trim() ? 1 : 0) !== (c.value.trim() ? 1 : 0))}
        onClick={saveProfile}>保存资料</Button>
    </Modal>}

    <SafetyCenter open={safetyOpen} onClose={() => setSafetyOpen(false)} viewer={me.id} />
  </>;
}
