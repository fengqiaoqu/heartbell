import { NextResponse } from "next/server";
import { getState, getRevealedProfile, isUserId } from "../../../lib/mock/store";
import type { DiaryKind, UserId } from "../../../lib/types";
import { createHash } from "node:crypto";
import { requireDemoSession } from "../../../lib/server/demo-auth";
export const dynamic = "force-dynamic";
// LEGACY（V1 演示接口）：仅供迁移期 verify:demo 使用；live 模式禁写。
// v2.6：用户读写入口同样先校验 Demo 会话（hb_demo_a / hb_demo_b），无免登录兼容通道。
function liveModeBlocked(): boolean { return process.env.APP_MODE === "live"; }
const messages = ["想认识你。", "想和你聊一聊。", "想一起喝杯咖啡。"];
const diaryKinds: DiaryKind[] = ["first-echo", "anniversary", "trip", "ordinary-day", "promise"];
const isAddressLike = (value: unknown): value is string => typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
const isTxHashLike = (value: unknown): value is string => typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
function parseDiaryDate(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const time = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(time)) return null;
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  return time > today.getTime() ? null : value;
}
function diaryContentHash(diary: { id: string; kind: DiaryKind; date: string; title: string; message: string }): string {
  return "0x" + createHash("sha256").update(JSON.stringify({ v: 1, ...diary })).digest("hex");
}
export async function GET(request: Request) {
  const viewer = new URL(request.url).searchParams.get("viewer");
  if (!isUserId(viewer)) return NextResponse.json({ error: "无效演示身份" }, { status: 400 });
  try { requireDemoSession(request.headers.get("cookie"), viewer); }
  catch { return NextResponse.json({ error: "请先登录演示账号（/login）" }, { status: 401, headers: { "Cache-Control": "no-store" } }); }
  const state = getState();
  const other = viewer === "a" ? "b" : "a";
  const revealed = getRevealedProfile(viewer, other);
  return NextResponse.json({ mode: "mock", data: {
    self: state.users[viewer],
    nearby: state.users[viewer].radar.active && state.users[other].radar.active ? [state.users[other]] : [],
    bells: state.bells.filter(b => b.from === viewer || b.to === viewer),
    profile: revealed,
    eligibility: { declared: state.eligibility[viewer], mode: "simulation", zkVerified: false },
    diaries: revealed ? state.diaries : [],
    wallets: revealed ? state.wallets : { a: null, b: null },
  } }, { headers: { "Cache-Control": "no-store" } });
}
export async function POST(request: Request) {
  let body;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "无效 JSON" }, { status: 400 }); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "请求必须为对象" }, { status: 400 });
  if (!isUserId(body.viewer)) return NextResponse.json({ error: "无效演示身份" }, { status: 400 });
  try { requireDemoSession(request.headers.get("cookie"), body.viewer); }
  catch { return NextResponse.json({ error: "请先登录演示账号（/login）" }, { status: 401, headers: { "Cache-Control": "no-store" } }); }
  if (liveModeBlocked()) return NextResponse.json({ error: "旧演示接口已在 live 模式禁用，请使用 /api/v2" }, { status: 403 });
  const state = getState();
  const viewer: UserId = body.viewer;
  const other = viewer === "a" ? "b" : "a";
  if (body.action === "declare") {
    if (body.single !== true) return NextResponse.json({ error: "需要主动作出单身声明" }, { status: 400 });
    state.eligibility[viewer] = true;
  } else if (body.action === "radar") {
    if (typeof body.active !== "boolean" || !Array.isArray(body.traits) || body.traits.length < 2 || body.traits.length > 3 || !body.traits.every((t: unknown) => {
      if (!t || typeof t !== "object") return false;
      const trait = t as { category?: unknown; value?: unknown };
      return ["穿着", "配饰", "手持物", "当前状态", "其他"].includes(String(trait.category)) && typeof trait.value === "string" && trait.value.trim().length > 0 && trait.value.length <= 20;
    })) {
      return NextResponse.json({ error: "请选择两到三个有效特征" }, { status: 400 });
    }
    state.users[viewer].radar = { active: body.active, traits: body.traits, zone: "wuhan-demo", expiresAt: body.active ? Date.now() + 600_000 : null };
  } else if (body.action === "ring") {
    if (!state.eligibility[viewer]) return NextResponse.json({ error: "请先完成模拟资格声明" }, { status: 403 });
    if (!state.users[viewer].radar.active || !state.users[other].radar.active) return NextResponse.json({ error: "双方需要开启雷达" }, { status: 409 });
    if (!messages.includes(body.message)) return NextResponse.json({ error: "请选择预设铃声" }, { status: 400 });
    if (state.bells.some(b => b.from === viewer && b.to === other && b.createdAt >= (state.users[other].radar.expiresAt! - 600_000))) return NextResponse.json({ error: "本轮已经摇过铃了" }, { status: 409 });
    state.bells.push({ id: crypto.randomUUID(), from: viewer, to: other, message: body.message, status: "pending", createdAt: Date.now() });
  } else if (body.action === "respond") {
    const bell = state.bells.find(b => b.id === body.bellId && b.to === viewer && b.status === "pending");
    if (!bell || !["accepted", "dismissed"].includes(body.status)) return NextResponse.json({ error: "铃声不存在或已经处理" }, { status: 409 });
    bell.status = body.status;
  } else if (body.action === "diary-create" || body.action === "diary-consent" || body.action === "diary-reject" || body.action === "wallet-bind" || body.action === "diary-onchain") {
    if (!getRevealedProfile(viewer, other)) return NextResponse.json({ error: "双方回响后才能共同写日记" }, { status: 403 });
    if (body.action === "diary-create") {
      const kind = diaryKinds.includes(body.kind) ? body.kind : null;
      const date = parseDiaryDate(body.date);
      const title = typeof body.title === "string" ? body.title.trim() : "";
      const message = typeof body.message === "string" ? body.message.trim() : "";
      if (!kind || !date) return NextResponse.json({ error: "请选择节点类型，日期不能晚于今天" }, { status: 400 });
      if (title.length < 1 || title.length > 20 || message.length < 1 || message.length > 60) return NextResponse.json({ error: "标题 1–20 字，一句话 1–60 字" }, { status: 400 });
      const draft = { id: crypto.randomUUID(), kind, date, title, message };
      state.diaries.push({ ...draft, author: viewer, createdAt: Date.now(), contentHash: diaryContentHash(draft), status: "awaiting-consent", consent: { a: viewer === "a", b: viewer === "b" }, chain: null });
    } else if (body.action === "wallet-bind") {
      if (!isAddressLike(body.address)) return NextResponse.json({ error: "请提供 0x 开头的有效钱包地址" }, { status: 400 });
      state.wallets[viewer] = body.address.toLowerCase();
    } else {
      const diary = state.diaries.find(d => d.id === body.diaryId);
      if (!diary) return NextResponse.json({ error: "日记不存在" }, { status: 404 });
      if (body.action === "diary-consent") {
        if (diary.status !== "awaiting-consent" || diary.consent[viewer]) return NextResponse.json({ error: "这一页已经确认或结束" }, { status: 409 });
        diary.consent[viewer] = true;
        if (diary.consent.a && diary.consent.b) diary.status = "ready";
      } else if (body.action === "diary-reject") {
        if (diary.status !== "awaiting-consent") return NextResponse.json({ error: "这一页已经确认或结束" }, { status: 409 });
        diary.status = "rejected";
      } else {
        // 演示服务无法自行核验链上交易；此回报只在前端真实钱包交易成功后由客户端提交。
        if (diary.status !== "ready") return NextResponse.json({ error: "需要双方都确认这一页" }, { status: 409 });
        if (!isTxHashLike(body.txHash)) return NextResponse.json({ error: "交易哈希格式无效" }, { status: 400 });
        diary.chain ??= { txs: [], confirmedAt: null };
        if (diary.chain.txs.some(tx => tx.by === viewer)) return NextResponse.json({ error: "你已经写入过这一页" }, { status: 409 });
        diary.chain.txs.push({ by: viewer, hash: body.txHash.toLowerCase() });
        if (diary.chain.txs.some(tx => tx.by === "a") && diary.chain.txs.some(tx => tx.by === "b")) diary.chain.confirmedAt = Date.now();
      }
    }
  } else return NextResponse.json({ error: "未知操作" }, { status: 400 });
  return NextResponse.json({ mode: "mock", data: { ok: true } });
}
