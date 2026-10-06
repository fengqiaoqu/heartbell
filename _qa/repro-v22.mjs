// v2.2 修改验证脚本：复现雷达、日记、承诺、履约确认链路。
const B = "http://localhost:3100/api/v2";
async function post(path, body) {
  const res = await fetch(`${B}/${path}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ viewer: body.viewer, ...body }),
  });
  const json = await res.json();
  if (json.error) console.log(`POST /${path} -> ${res.status} ${json.error.code}: ${json.error.message}`);
  return json;
}
async function get(path) {
  const res = await fetch(`${B}/${path}`);
  return res.json();
}
const log = (k, v) => console.log(k, JSON.stringify(v).slice(0, 300));

// 1. 雷达
log("radar a:", (await post("radar", { viewer: "a", active: true, traits: [{ category: "穿着", value: "黑色外套" }, { category: "手持物", value: "拿着咖啡" }] })).data ?? "ERR");
log("radar b:", (await post("radar", { viewer: "b", active: true, traits: [{ category: "穿着", value: "白色上衣" }, { category: "配饰", value: "戴眼镜" }] })).data ?? "ERR");
const ring = await post("ring", { viewer: "a", message: "想认识你。" });
log("ring:", ring.data ?? ring.error);
const bells = (await get("state?viewer=b")).data.meet.bells;
const bell = bells.find(x => x.to === "b" && x.status === "pending");
log("respond:", (await post("respond", { viewer: "b", bellId: bell.id, status: "accepted" })).data ?? "ERR");
log("propose:", (await post("relationships/propose", { viewer: "a" })).data?.relationship?.id ?? "ERR");
const stB = (await get("state?viewer=b")).data;
const invite = stB.us.incomingInvite;
log("accept rel:", (await post("relationships/accept", { viewer: "b", relationshipId: invite.id })).data ?? "ERR");

// 2. 日记
const diary = await post("diaries", { viewer: "a", kind: "diary", date: new Date().toISOString().slice(0, 10), title: "一起等了一场雨", body: "心里很安静。", attachmentIds: [], visibility: "shared" });
log("diary create:", diary.data ?? diary.error);
const diaryId = diary.data?.diaryId;
if (diaryId) {
  const detail = await get(`diaries/detail?id=${diaryId}&viewer=b`);
  log("diary detail b:", detail.data?.versions?.map(v => v.status));
  log("diary confirm b:", (await post("diaries/confirm", { viewer: "b", diaryId, expectedVersion: 1 })).data ?? "ERR");
  log("diary anchor:", (await post("diaries/anchor", { viewer: "b", diaryId })).data ?? "ERR");
  // 修改新版本
  log("diary version:", (await post("diaries/version", { viewer: "a", diaryId, expectedVersion: 1, date: new Date().toISOString().slice(0, 10), title: "一起等了一场雨（改）", body: "补一句。", attachmentIds: [], visibility: "shared" })).data ?? "ERR");
}

// 3. 承诺
const p = await post("promises", { viewer: "a", content: "每周留一个共同的晚上", dueAt: Date.now() + 5 * 86400000, criteria: "双方确认本次安排即可", responsible: "both", scoringOptIn: false });
log("promise create:", p.data ?? p.error);
const promiseId = p.data?.promiseId;
if (promiseId) {
  log("promise confirm:", (await post("promises/confirm", { viewer: "b", promiseId, expectedRevision: 1 })).data ?? "ERR");
  log("resolution a:", (await post("promises/resolutions", { viewer: "a", promiseId, result: "fulfilled", note: "10月7日晚一起做了饭" })).data ?? "ERR");
  log("resolution confirm b:", (await post("promises/resolutions/confirm", { viewer: "b", promiseId, subjectUserId: "a", outcome: "fulfilled" })).data ?? "ERR");
  const st = (await get("state?viewer=b")).data;
  const t = st.us.timeline.find(x => x.id === promiseId);
  log("timeline badge after confirm (viewer b):", t?.statusText, "needsMyAction:", t?.needsMyAction);
  log("promise anchor job exists:", t?.anchor?.chainStatus ?? null);
}
