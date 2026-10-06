import { test } from "node:test";
import assert from "node:assert/strict";
import { ApprovalWorkflow, type Grant } from "@appcenter/core";

const context = { appId: "vpn", userId: "me", appVersion: "5.0.0" };

function issued(secret = "secret"): { wf: ApprovalWorkflow; grant: Grant } {
  const wf = new ApprovalWorkflow(secret);
  const request = wf.submit({ appId: "vpn", appVersion: "5.0.0", applicant: "me", reason: "需要远程接入" });
  wf.decide(request.id, "approved", "admin");
  return { wf, grant: wf.issueGrant(request.id) };
}

test("回归：签名有效但有效期解析不了的凭证必须失效（服务端可注入这种请求）", () => {
  const wf = new ApprovalWorkflow("secret");
  // track() 是 facade 用来登记服务端下发的既有请求的入口：那条请求的 expiresAt 是不可控字符串。
  // 走 issueGrant 之后签名是**正确**的，所以只有时间校验能挡住这张永久凭证。
  const requestId = "req_from_server";
  wf.track({
    id: requestId,
    appId: "vpn",
    appVersion: "5.0.0",
    applicant: "me",
    reason: "服务端历史数据",
    status: "approved",
    createdAt: new Date().toISOString(),
    expiresAt: "not-a-date",
  });
  const grant = wf.issueGrant(requestId);
  const verdict = wf.verifyGrant(grant, context);
  assert.equal(verdict.reason, "timestamp-unparseable", "旧写法 NaN 比较恒 false，这张凭证会被永久接受");

  // 客户端模式下随手拼的坏时间戳同样要挡住。
  const client = new ApprovalWorkflow("");
  const forged: Grant = { ...grant, expiresAt: "" };
  assert.equal(client.verifyGrant(forged, context).reason, "timestamp-unparseable");
});

test("回归：过期时间不晚于签发时间的自相矛盾凭证不得放行", () => {
  const client = new ApprovalWorkflow("");
  const far = "2999-01-01T00:00:00.000Z";
  // 两个时间戳都可解析、都在未来，旧实现只看 `expiresAt <= now` 于是判为「未过期」直接放行。
  assert.equal(client.verifyGrant({ token: "t", appId: "vpn", userId: "me", issuedAt: far, expiresAt: far, signature: "" }, context).reason, "expiry-not-after-issue");
  assert.equal(
    client.verifyGrant({ token: "t", appId: "vpn", userId: "me", issuedAt: far, expiresAt: "2998-01-01T00:00:00.000Z", signature: "" }, context).reason,
    "expiry-not-after-issue",
  );
});

test("回归：同一应用/用户存在其它请求时，吊销必须能落到被吊销那张凭证", () => {
  const wf = new ApprovalWorkflow("secret");
  const first = wf.submit({ appId: "vpn", appVersion: "5.0.0", applicant: "me", reason: "第一次申请" });
  const second = wf.submit({ appId: "vpn", appVersion: "5.0.0", applicant: "me", reason: "第二次申请" });
  wf.decide(first.id, "approved", "admin");
  wf.decide(second.id, "approved", "admin");
  const grantFirst = wf.issueGrant(first.id);
  const grantSecond = wf.issueGrant(second.id);

  // 只吊销 first：旧实现的条件是「该应用+用户的**所有**请求都被吊销才拒绝」，
  // 此时 second 还是 granted，于是被吊销的 first 那张凭证照样通过。
  wf.revoke(first.id);
  assert.equal(wf.verifyGrant(grantFirst, context).reason, "revoked", "吊销必须作废它自己签发的那张凭证");
  assert.equal(wf.verifyGrant(grantSecond, context).ok, true, "吊销别的请求不该连累这张凭证");

  // 两张都吊销后，第二张也必须作废。
  wf.revoke(second.id);
  assert.equal(wf.verifyGrant(grantSecond, context).reason, "revoked");
});

test("revokeFor 作废该用户对该应用的全部凭证", () => {
  const { wf, grant } = issued();
  assert.equal(wf.revokeFor(context), 1);
  assert.equal(wf.verifyGrant(grant, context).reason, "revoked");
});

test("限定当前设计：不带密钥的客户端模式不做 HMAC 校验（已知残余风险）", () => {
  const wf = new ApprovalWorkflow("");
  assert.equal(wf.issuerTrusted, true);
  const { grant } = issued();
  // 客户端拿不到签发密钥，所以这里既不验签、也不因为「带着一张别人家签的合法形状签名」而拒绝。
  // 本用例是特征测试（characterization test）：把这条残余风险钉住，将来改成必须服务端核验时它会先跑红。
  assert.equal(wf.verifyGrant({ ...grant, appId: "vpn", userId: "me" }, context).ok, true);
  assert.equal(wf.verifyGrant({ ...grant, signature: "0".repeat(64) }, context).ok, true);
  // 但签名格式明显不合法时仍然拒绝，避免把随手拼的东西当凭证。
  assert.equal(wf.verifyGrant({ ...grant, signature: "zz-not-hex" }, context).reason, "signature-malformed");
});
