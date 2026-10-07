"use client";
// V2 客户端 API 封装：统一响应/错误结构（计划书 10.3 节）。
import type { V2StateView } from "../domain/view-dtos";

export class V2ApiError extends Error {
  constructor(public code: string, message: string, public status: number) { super(message); }
}

export async function fetchState(viewer: string): Promise<V2StateView> {
  const response = await fetch(`/api/v2/state?viewer=${viewer}`, { cache: "no-store" });
  const json = await response.json();
  if (!response.ok) throw new V2ApiError(json.error?.code ?? "UNKNOWN", json.error?.message ?? "服务暂时不可用", response.status);
  return json.data as V2StateView;
}

export async function postV2<T = { ok: boolean }>(path: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(`/api/v2/${path}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ viewer: body.viewer, ...body }),
  });
  const json = await response.json();
  if (!response.ok) throw new V2ApiError(json.error?.code ?? "UNKNOWN", json.error?.message ?? "操作失败", response.status);
  return json.data as T;
}

export async function getV2<T>(path: string): Promise<T> {
  const response = await fetch(`/api/v2/${path}`, { cache: "no-store" });
  const json = await response.json();
  if (!response.ok) throw new V2ApiError(json.error?.code ?? "UNKNOWN", json.error?.message ?? "查询失败", response.status);
  return json.data as T;
}

// 失败提示写明可采取的动作（计划书 7.5）。
export function friendlyError(error: unknown): string {
  if (error instanceof V2ApiError) {
    if (error.status >= 500) return `${error.message}（稍后可以重试，你的内容没有丢失）`;
    return error.message;
  }
  if (error instanceof Error) {
    if (error.message.includes("fetch")) return "暂时无法连接服务，请稍后重试；已填写的草稿仍在页面上。";
    return error.message;
  }
  return "操作失败，请重试。";
}
