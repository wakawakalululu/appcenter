import { test } from "node:test";
import assert from "node:assert/strict";
import { ApprovalWorkflow } from "@appcenter/core";

function approvedGrant(appVersion = "1.0.0"): { wf: ApprovalWorkflow; grant: ReturnType<ApprovalWorkflow["issueGrant"]> } {
  const wf = new ApprovalWorkflow("secret");
  const request = wf.submit({ appId: "vpn-client", appVersion, applicant: "me", reason: "需要远程接入" });
  wf.decide(request.id, "approved", "admin");
  return { wf, grant: wf.issueGrant(request.id) };
}

test("凭证只能用于被批准的那个版本，不能换版本照用", () => {
  const { wf, grant } = approvedGrant("1.0.0");
  const same = wf.verifyGrant(grant, { appId: "vpn-client", userId: "me", appVersion: "1.0.0" });
  assert.equal(same.ok, true, "基准：同版本必须通过");

  const upgraded = wf.verifyGrant(grant, { appId: "vpn-client", userId: "me", appVersion: "9.9.9" });
  assert.equal(upgraded.ok, false, "批了 1.0.0 就能装 9.9.9 —— 审批的版本作用域形同虚设");
  assert.equal(upgraded.reason, "version-mismatch");
});

test("版本要进签名载荷：篡改版本必须让签名失效", () => {
  const { wf, grant } = approvedGrant("1.0.0");
  const tampered = { ...grant, appVersion: "9.9.9" };
  const verdict = wf.verifyGrant(tampered as typeof grant, { appId: "vpn-client", userId: "me", appVersion: "9.9.9" });
  assert.equal(verdict.ok, false, "把 appVersion 改大还能通过，说明它没进 HMAC 载荷");
  assert.equal(verdict.reason, "signature-invalid");
});

test("缺 appVersion 的旧凭证要 fail-closed，不能被当成「不限版本」", () => {
  const { wf, grant } = approvedGrant("1.0.0");
  const legacy = { ...grant } as Record<string, unknown>;
  delete legacy.appVersion;
  const verdict = wf.verifyGrant(legacy as unknown as typeof grant, { appId: "vpn-client", userId: "me", appVersion: "1.0.0" });
  assert.equal(verdict.ok, false, "没有版本字段的凭证等于授权任意版本，必须拒");
});
