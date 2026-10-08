import { test } from "node:test";
import assert from "node:assert/strict";
import { rankRecommend, toDistribution, effectiveDistribution, rankByQuality } from "@appcenter/core";
import { compare, parse, parseRange, parseTolerant, satisfies } from "@appcenter/core";
import type { RatingDistribution, RatingInput } from "@appcenter/core";

/**
 * 这个文件不做新功能断言，它钉的是 **spec/srs.md 第 4.3 与 4.5 节里那些"实测读数"**。
 * 理由与本项目一贯做法一致：规格里的句子如果不对应用例，就会在下次改动时静默漂移，
 * 而其中几条（`+meta-1` 的读法、大小写不归一）确实反直觉，最容易被"顺手改得看起来更合理"。
 */
const noVotes: RatingDistribution = toDistribution([]);

const at = (stars: number, userId: string): RatingInput => ({
  appId: "app-x", userId, stars, verifiedInstall: false, createdAt: "2026-01-01T00:00:00.000Z",
});

test("下载量为负或非有限：按 0 计，分数保持有限且脏数据不许插队", () => {
  const ranked = rankRecommend([
    { id: "ok", ratings: noVotes, downloadCount: 1000 },
    { id: "neg", ratings: noVotes, downloadCount: -1 },
    { id: "worse", ratings: noVotes, downloadCount: -2 },
    { id: "nan", ratings: noVotes, downloadCount: Number.NaN },
  ]);
  for (const r of ranked) assert.ok(Number.isFinite(r.score), "分数不许是 NaN/Infinity：" + JSON.stringify(ranked));
  assert.equal(ranked[0]?.id, "ok", "下载量最大的排第一；旧写法这里会被 NaN/负数那条抢到前面");
  assert.deepEqual(new Set(ranked.map((r) => r.id)), new Set(["ok", "neg", "worse", "nan"]), "成员不增不减");
});

test("`+构建元数据` 不参与优先级：`1.2.3+meta-1` 等于 `1.2.3`，而 `-rc.1+build.2` 仍是预发布", () => {
  // 这里曾是本模块第二处「两个函数对同一串互相矛盾」：旧的 prereleaseOf 要求连字符一路到串尾，
  // 于是 +meta-1 的尾巴 -1 被当成标签（判它比 1.2.3 小），而 -rc.1+build.2 反而读不出标签（判它等于 1.2.3）。
  // 两个方向都反了。现已统一走 splitCore，严格 parse 与 compare 给出同一个标签。
  assert.equal(compare("1.2.3+meta-1", "1.2.3"), 0);
  assert.equal(compare("1.2.3", "1.2.3+meta-1"), 0);
  assert.equal(compare("1.2.3-rc.1+build.2", "1.2.3"), -1);
  assert.equal(satisfies("1.2.3-rc.1+build.2", "=1.2.3"), false);
  assert.equal(parse("1.2.3-rc.1+build.2")?.prerelease, "rc.1");
  assert.equal(parseTolerant("1.2.3-rc.1+build.2").prerelease, "rc.1");
});

test("末尾只留一个 `-` 算没有标签", () => {
  assert.equal(compare("1.2.3-", "1.2.3"), 0);
});

test("标签字母段区分大小写且不归一（码元序）", () => {
  assert.equal(compare("1.2.3-A", "1.2.3-a"), -1);
  assert.equal(compare("1.2.3-1", "1.2.3-a"), -1, "数字段小于字母段");
  assert.equal(compare("1.2.3-1", "1.2.3-2"), -1, "同为数字段按数值");
  assert.equal(compare("1.2.3-10", "1.2.3-9"), 1, "数值而非字典序：10 大于 9");
});

test("逗号子句是 AND，且容忍子句两侧空白", () => {
  assert.equal(satisfies("1.0.0", ">=0.9.0,<1.0.0"), false, "第二条不满足则整体不满足");
  assert.equal(satisfies("1.0.0", ">=0.9.0,<2.0.0"), true);
  assert.equal(parseRange(">=1.0.0 , <2.0.0").length, 2);
});

test("词法不校验：认不出的片段按 = 与字面量比较", () => {
  const clauses = parseRange("garbage");
  assert.equal(clauses.length, 1);
  assert.equal(clauses[0]?.operator, "eq");
  assert.equal(clauses[0]?.version, "garbage");
  assert.equal(satisfies("garbage", "garbage"), true, "自身相等（数值段全按 0 处理后仍等价）");
  assert.equal(satisfies("1.0.0", "garbage"), false);
});

test("verifiedMultiplier 的取值域：0 与负数至少算一票，非有限值退回默认而不是抹掉评分", () => {
  const one = [{ appId: "a", userId: "u", stars: 5, verifiedInstall: true, createdAt: "x" }];
  // 旧写法下 NaN 会让 Math.max(1,NaN)=NaN、复制循环一次都不跑，于是这条评分被静默删除（count 1 -> 0）。
  for (const m of [0, -3, Number.NaN]) {
    const d = effectiveDistribution(one, m);
    assert.ok(d.count >= 1, "覆盖参数是 " + String(m) + " 时也不能丢真实投票：" + JSON.stringify(d));
    assert.ok(Number.isFinite(d.mean), "mean 必须是有限数：" + JSON.stringify(d));
  }
  assert.equal(effectiveDistribution(one, 3).count, 3, "默认三倍权重仍是 3");
});

test("浮点并列按精确相等成立，且决胜不依赖输入顺序", () => {
  const split = toDistribution([at(4, "1"), at(2, "2")]);
  const even = toDistribution([at(3, "3"), at(3, "4")]);
  const forward = rankByQuality([{ id: "z", ratings: split }, { id: "a", ratings: even }]);
  const reverse = rankByQuality([{ id: "a", ratings: even }, { id: "z", ratings: split }]);
  assert.equal(forward[0]?.score, 3);
  assert.equal(reverse[0]?.score, 3);
  assert.deepEqual(forward.map((r) => r.id), reverse.map((r) => r.id), "并列时结果必须与输入顺序无关");
  assert.deepEqual(forward.map((r) => r.id), ["a", "z"]);
});

test("严格 parse 接受的形状（含尾随垃圾不报错），段数不足才判非法", () => {
  for (const s of ["v1.2.3", " 1.2.3 ", "1.02.3", "1.2.3+build", "1.2.3-"]) {
    const p = parse(s);
    assert.ok(p, s + " 应当被接受");
    assert.equal([p?.major, p?.minor, p?.patch].join("."), "1.2.3");
    assert.equal(p?.prerelease, "", s + " 的前缀/空白/前导零/+build/裸尾横线都不产生标签");
  }
  assert.ok(parse("1.2.3abc"), "当前实现不校验尾随内容：这是实测边界，不是设想");
  assert.equal(parse("1.2"), null, "少于三段才算非法");
});

test("宽松解析与比较函数现在同读法（这里曾是一处真实不自洽，已统一）", () => {
  // 旧行为：parseTolerant 要求整段是数字，"1.2abc" 读成 minor=0，而 compare 取段开头连续数字读成 2，
  // 于是"同一个串一个说就是 1.0.0、另一个说比 1.0.0 大"。统一取 compare 的规则（两侧生产代码都无调用方）。
  assert.equal(parseTolerant("1.2abc").minor, 2, "脏段取开头连续数字");
  assert.equal(compare("1.2abc", "1.2.0"), 0, "compare 的既有读数不变");
  assert.equal(compare("1.2abc", "1.0.0"), 1);
  // 一致性判据本体：任取一串，两种读法对"是否大于 1.0.0"必须给同一个答案。
  for (const s of ["1.2abc", "1.02.3", "1.2", "v1.2.3", "1.2.3+meta-1", "abc", ""]) {
    const t = parseTolerant(s);
    const viaTolerant = compare(`${t.major}.${t.minor}.${t.patch}`, "1.0.0");
    assert.equal(compare(s, "1.0.0"), viaTolerant, "两个读法对 " + JSON.stringify(s) + " 结论不一致");
  }
});
