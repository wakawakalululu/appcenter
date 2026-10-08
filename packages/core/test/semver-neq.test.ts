import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRange, satisfies } from "../src/util/semver.ts";

/**
 * 区间里的 `!=` 一度被解析成 `eq`（符号表没有它，落到了默认分支），
 * 于是 `satisfies("1.0.0", "!=1.0.0")` 返回 true —— 语义正好相反，而且不报错。
 * 规格里把符号集写死了，所以这里钉住的是"契约存在且方向正确"。
 */
test("!= 解析成 neq，而不是掉进 eq 的默认分支", () => {
  const clauses = parseRange("!=1.0.0");
  assert.equal(clauses.length, 1);
  assert.equal(clauses[0]?.operator, "neq");
});

test("!= 的求值方向正确（相等为 false，不等为 true）", () => {
  assert.equal(satisfies("1.0.0", "!=1.0.0"), false, "同一版本不该满足 !=");
  assert.equal(satisfies("1.0.1", "!=1.0.0"), true);
  // 四段版本号里 != 也要按数值比，不能被前导零或段数差骗过去。
  assert.equal(satisfies("1.02.3", "!=1.2.3"), false);
  assert.equal(satisfies("1.2.3.4", "!=1.2.3"), true, "多出来的第四段是真实差异");
});

test("多条子句里的 != 与其他符号混用仍逐条生效", () => {
  assert.equal(satisfies("2.0.0", ">=1.0.0,!=2.0.0"), false);
  assert.equal(satisfies("2.0.1", ">=1.0.0,!=2.0.0"), true);
});

test("其余操作符不受影响（防我把默认分支改坏）", () => {
  assert.equal(parseRange("1.0.0")[0]?.operator, "eq", "省略符号仍按 =");
  assert.equal(satisfies("1.0.0", "1.0.0"), true);
  assert.equal(satisfies("1.0.1", ">=1.0.0"), true);
  assert.equal(satisfies("1.0.0", ">1.0.0"), false);
  assert.equal(satisfies("0.9.9", "<=1.0.0"), true);
  assert.equal(satisfies("1.0.0", "<1.0.0"), false);
});
