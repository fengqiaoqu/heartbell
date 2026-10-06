import assert from "node:assert/strict";
// 说明：脚本中的钱包地址与交易哈希都是格式合法的测试样例，仅用于校验接口行为，
// 不代表真实链上交易；产品界面在合约未部署时不会生成任何模拟哈希。
const base = process.env.DEMO_URL ?? "http://127.0.0.1:3000";
const walletA = "0x1111111111111111111111111111111111111111";
const walletB = "0x2222222222222222222222222222222222222222";
const txHashA = "0x" + "ab".repeat(32);
const txHashB = "0x" + "cd".repeat(32);
// v2.6：旧 /api/demo 用户接口同样需要 Demo 会话——登录 a/b 携带双槽位 Cookie。
async function demoLogin(viewer) {
  const password = { a: "HeartbellA2026!", b: "HeartbellB2026!" }[viewer];
  const res = await fetch(`${base}/api/demo-auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: base },
    body: JSON.stringify({ username: viewer, password }),
  });
  if (!res.ok) throw new Error(`登录 ${viewer} 失败：${res.status}`);
  return (res.headers.get("set-cookie") ?? "").split(";")[0];
}
const CK = `${await demoLogin("a")}; ${await demoLogin("b")}`;
async function call(viewer, action, expected = 200) {
  const response = await fetch(`${base}/api/demo${action ? "" : `?viewer=${viewer}`}`, action ? { method: "POST", headers: { "Content-Type": "application/json", Cookie: CK, Origin: base }, body: JSON.stringify({ viewer, ...action }) } : { headers: { Cookie: CK } });
  const data = await response.json();
  assert.equal(response.status, expected, JSON.stringify(data));
  return data.data;
}
for (const path of ["/", "/demo/a", "/demo/b"]) assert.equal((await fetch(base + path)).status, 200);
const initial = await call("a");
assert.equal(initial.profile, null, "Restart server before verification: expected fresh state.");
assert.deepEqual(initial.diaries, []);
assert.deepEqual(initial.wallets, { a: null, b: null });
await call("a", { action: "diary-create", kind: "trip", date: "2026-10-01", title: "第一次旅行", message: "海边的风。" }, 403);
await call("a", { action: "radar", active: true, traits: [{ category: "invalid", value: "test" }, { category: "其他", value: "test" }] }, 400);
for (const viewer of ["a", "b"]) await call(viewer, { action: "radar", active: true, traits: [{ category: "穿着", value: "绿色卫衣" }, { category: "手持物", value: "篮球" }] });
await call("a", { action: "ring", message: "想认识你。" }, 403);
for (const viewer of ["a", "b"]) await call(viewer, { action: "declare", single: true });
await call("a", { action: "ring", message: "想认识你。" });
await call("a", { action: "ring", message: "想认识你。" }, 409);
const received = await call("b");
assert.equal(received.profile, null);
assert.equal(received.eligibility.zkVerified, false);
await call("b", { action: "respond", bellId: received.bells[0].id, status: "accepted" });
for (const viewer of ["a", "b"]) assert.ok((await call(viewer)).profile);
// 日记校验：类型、未来日期、超长标题都会被拒绝。
await call("a", { action: "diary-create", kind: "wedding", date: "2026-10-01", title: "求婚", message: "愿意。" }, 400);
await call("a", { action: "diary-create", kind: "trip", date: "2099-01-01", title: "未来", message: "不可能。" }, 400);
await call("a", { action: "diary-create", kind: "trip", date: "2026-10-01", title: "二".repeat(21), message: "超长标题。" }, 400);
await call("a", { action: "diary-create", kind: "trip", date: "2026-10-01", title: "一起去看海", message: "那天风很大，我们笑得很小声。" });
const withDiary = await call("b");
assert.equal(withDiary.diaries.length, 1);
const diary = withDiary.diaries[0];
assert.equal(diary.status, "awaiting-consent");
assert.equal(diary.consent.a, true);
assert.equal(diary.consent.b, false);
assert.match(diary.contentHash, /^0x[0-9a-f]{64}$/);
// 单方确认不能上链；作者不能重复确认。
await call("a", { action: "diary-consent", diaryId: diary.id }, 409);
await call("a", { action: "diary-onchain", diaryId: diary.id, txHash: txHashA }, 409);
await call("b", { action: "diary-consent", diaryId: diary.id });
assert.equal((await call("a")).diaries[0].status, "ready");
// 第二页走婉拒分支：婉拒后不能再确认或上链。
await call("b", { action: "diary-create", kind: "ordinary-day", date: "2026-09-20", title: "雨天", message: "一把伞。" });
const second = (await call("a")).diaries.find(d => d.title === "雨天");
await call("a", { action: "diary-reject", diaryId: second.id });
await call("a", { action: "diary-consent", diaryId: second.id }, 409);
await call("a", { action: "diary-onchain", diaryId: second.id, txHash: txHashA }, 409);
assert.equal((await call("b")).diaries.find(d => d.id === second.id).status, "rejected");
// 钱包绑定与上链回报。
await call("a", { action: "wallet-bind", address: "0x1234" }, 400);
await call("a", { action: "wallet-bind", address: walletA });
await call("b", { action: "wallet-bind", address: walletA }, 200);
assert.deepEqual((await call("a")).wallets, { a: walletA, b: walletA }, "绑定应覆盖旧地址");
await call("b", { action: "wallet-bind", address: walletB });
await call("a", { action: "diary-onchain", diaryId: diary.id, txHash: "0x1234" }, 400);
await call("a", { action: "diary-onchain", diaryId: diary.id, txHash: txHashA });
await call("a", { action: "diary-onchain", diaryId: diary.id, txHash: txHashA }, 409);
const half = (await call("b")).diaries.find(d => d.id === diary.id);
assert.equal(half.chain.txs.length, 1);
assert.equal(half.chain.confirmedAt, null);
await call("b", { action: "diary-onchain", diaryId: diary.id, txHash: txHashB });
const final = await call("b");
const done = final.diaries.find(d => d.id === diary.id);
assert.equal(done.chain.txs.length, 2);
assert.ok(done.chain.confirmedAt > 0);
console.log("PASS: pages, custom traits, eligibility gate, privacy, duplicate prevention, mutual reveal, diary validation, mutual consent, rejection, wallet binding and two-party on-chain reporting. Wallet addresses and tx hashes above are format fixtures; no real chain transaction was sent.");
