import { test } from "node:test";
import assert from "node:assert/strict";
import { bayesianAverage, rankByQuality, toDistribution, type RatingInput } from "@appcenter/core";

/**
 * 这批用例钉的是 spec/srs.md 第 4 节里**由第三方读者发现、我后来补写**的那几条判据
 * （非有限 stars 的处置、分母为 0 的处置、"参与排序的集合"到底是谁）。
 * 规格写下数字而不钉进测试，就会在下次改动时静默漂移——本项目已为此建过门禁（用例数下限）同族教训。
 */
const at = (stars: number, userId = "u"): RatingInput => ({
  appId: "app-x", userId, stars, verifiedInstall: false, createdAt: "2026-01-01T00:00:00.000Z",
});

test("非有限的 stars 整条丢弃，且不污染均值（一条坏数据不该毁掉整个应用的分）", () => {
  const d = toDistribution([at(5, "a"), at(4, "b"), at(Number.NaN, "c")]);
  assert.equal(d.count, 2, "NaN 那条既不进桶也不计数");
  assert.ok(Number.isFinite(d.mean), "mean 必须仍是有限数——旧写法这里得到 NaN");
  assert.equal(d.mean, 4.5);
  assert.deepEqual(d.buckets, [0, 0, 0, 1, 1]);
});

test("全是坏数据时是空分布，而不是 mean=NaN", () => {
  const d = toDistribution([at(Number.NaN, "a"), at("3" as unknown as number, "b"), at(Number.NaN, "c")]);
  assert.deepEqual(d.buckets, [0, 0, 0, 0, 0]);
  assert.equal(d.count, 0);
  assert.equal(d.mean, 0);
});

test("Infinity 属极端值而非坏数据：按钳制归入 5/1", () => {
  assert.deepEqual(toDistribution([at(Number.POSITIVE_INFINITY)]).buckets, [0, 0, 0, 0, 1]);
  assert.deepEqual(toDistribution([at(Number.NEGATIVE_INFINITY)]).buckets, [1, 0, 0, 0, 0]);
});

test("分母为 0 可达（priorWeight 可覆盖）：返回先验均值而不是 NaN", () => {
  const empty = toDistribution([]);
  assert.equal(bayesianAverage(empty, 3, 0), 3, "0/0 时按先验均值给分");
  // 排序侧的下游后果才是这条判据存在的理由：NaN 会让比较失去传递性。
  const ranked = rankByQuality([{ id: "b", ratings: empty }, { id: "a", ratings: empty }], { priorWeight: 0 });
  assert.deepEqual(ranked.map((r) => r.id), ["a", "b"], "零票 + 无先验权重时按 id 决胜，不得退化成输入顺序以外的乱序");
  for (const r of ranked) assert.ok(Number.isFinite(r.score), "分数不许是 NaN：" + JSON.stringify(ranked));
});

test("先验取全体传入者（含被排序者自身），输出成员与输入完全一致", () => {
  const one = { id: "solo", ratings: toDistribution([at(1)]) };
  const ranked = rankByQuality([one]);
  assert.equal(ranked.length, 1);
  // 只有一个应用时，全局先验就是它自己的均值 1；priorWeight=20 与 count=1 加权后必然仍是 1。
  assert.equal(ranked[0]?.score, 1, "先验含自身：本例应为 1 而不是某个内置默认值 3");
});

test("零票应用拿到全局先验均值（默认 priorWeight 下）", () => {
  const crowd = { id: "crowd", ratings: toDistribution([at(5, "a"), at(5, "b")]) };
  const fresh = { id: "fresh", ratings: toDistribution([]) };
  const ranked = rankByQuality([crowd, fresh]);
  assert.equal(ranked[0]?.id, "crowd");
  assert.equal(ranked[1]?.score, 5, "全场先验均值就是 5，零票应用按先验给分而非 0 分");
});
