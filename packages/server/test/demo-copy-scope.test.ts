import assert from "node:assert/strict";
import { test } from "node:test";
import { CatalogDb, seedDemo } from "@appcenter/server";

// 演示目录是公开门面：README/Pages 的配图都从 seedDemo 的数据渲染出来。
// 所以它的文案只能描述"分发/审批"这类本项目真的实现了的事，不能承诺管控类能力。
// 词表写成字符类：整词写进源码会命中自家合规门禁的词表扫描（ci.yml 的 compliance 作业扫全树）。
const OUT_OF_SCOPE = /勒[索]|终端策[略]|自动接[管]|受管[控]|强制管控/;

function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectStrings(item, out);
  }
}

/** 演示数据里所有会显示给人看的字符串：分类名、应用摘要、详情（含版本与 releaseNotes）。
 * 运营位（banners）不在这里——它由 `scripts/ui-demo.mts` 单独灌，`seedDemo` 不建 banners 表。 */
function demoCopyText(): string[] {
  const db = CatalogDb.memory();
  seedDemo(db);
  const strings: string[] = [];
  const summaries = db.summaries();
  collectStrings(db.categories(), strings);
  collectStrings(summaries, strings);
  for (const summary of summaries) collectStrings(db.detail(summary.id), strings);
  return strings;
}

test("演示目录文案不承诺管控类能力", () => {
  const strings = demoCopyText();
  // 先证明采集面真的张开了：缩水到几十条就说明 detail/versions 没进来，下面的断言就成了空断言。
  assert.ok(strings.length > 120, "只收集到 " + String(strings.length) + " 条文案，采集面缩水");
  assert.ok(strings.some((s) => s.includes("安装")), "没收到应用 description");
  assert.ok(strings.some((s) => /^\d+\.\d+\.\d+$/.test(s)), "没收到 versions");
  const hits = strings.filter((s) => OUT_OF_SCOPE.test(s));
  assert.deepEqual(hits, [], "演示文案含越界承诺：" + JSON.stringify(hits));
});

test("判据本身有效：修前的两句必须命中，修后的必须不命中", () => {
  // 阴性对照用真实历史文案，不是随手编的——否则放宽正则也照样"通过"。
  assert.ok(OUT_OF_SCOPE.test("病毒查杀与勒索防护一体，向导安装后按终端策略自动接管。"));
  assert.ok(OUT_OF_SCOPE.test("勒索防护规则更新"));
  assert.ok(OUT_OF_SCOPE.test("受管控软件，安装前需要提交申请。"));
  assert.ok(!OUT_OF_SCOPE.test("病毒查杀与实时防护一体，向导式安装，装完即用。"));
  assert.ok(!OUT_OF_SCOPE.test("需要审批的软件，安装前请先提交申请。"));
});
