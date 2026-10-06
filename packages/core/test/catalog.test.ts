import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildCategoryTree,
  compare,
  dice,
  effectiveDistribution,
  normalize,
  rankByQuality,
  rankRecommend,
  satisfies,
  searchCatalog,
  toDistribution,
  type AppSummary,
  type Category,
  type RatingInput,
} from "@appcenter/core";

const app = (over: Partial<AppSummary>): AppSummary => ({
  id: "a",
  name: "应用",
  searchKeys: [],
  publisher: "厂商",
  categoryId: "dev",
  iconUrl: "",
  latestVersion: "1.0.0",
  downloadCount: 0,
  badge: "normal",
  tags: [],
  requiresApproval: false,
  sizeBytes: 1,
  ...over,
});

const catalog: AppSummary[] = [
  app({ id: "wps", name: "WPS Office", searchKeys: ["wps", "bangong"], tags: ["文档"], categoryId: "doc", downloadCount: 4000, badge: "recommend" }),
  app({ id: "sogou", name: "搜狗输入法", searchKeys: ["sougou", "sogou shurufa"], publisher: "搜狗", categoryId: "office-im", downloadCount: 900 }),
  app({ id: "code", name: "代码编辑器", searchKeys: ["code editor"], tags: ["开发"], categoryId: "dev", downloadCount: 10 }),
  app({ id: "vpn", name: "远程接入客户端", searchKeys: ["vpn"], categoryId: "dev", downloadCount: 3, requiresApproval: true }),
];

const vote = (appId: string, userId: string, stars: number, verifiedInstall = true): RatingInput => ({
  appId,
  userId,
  stars,
  verifiedInstall,
  createdAt: "2026-09-01",
});

test("exact name match outranks fuzzy match", () => {
  const hits = searchCatalog(catalog, { text: "代码编辑器" });
  assert.equal(hits[0]?.app.id, "code");
  assert.equal(hits[0]?.matchedOn, "name");
});

test("search keys let pinyin reach the chinese name", () => {
  const hits = searchCatalog(catalog, { text: "sogou shurufa" });
  assert.equal(hits[0]?.app.id, "sogou");
  assert.equal(hits[0]?.matchedOn, "searchKeys");
});

test("publisher and tag fields are searchable", () => {
  assert.equal(searchCatalog(catalog, { text: "搜狗" })[0]?.app.id, "sogou");
  assert.equal(searchCatalog(catalog, { text: "文档" })[0]?.app.id, "wps");
});

test("typos still reach the closest candidate", () => {
  assert.equal(searchCatalog(catalog, { text: "wps offie" })[0]?.app.id, "wps");
});

test("unrelated keyword yields nothing while normalize folds width and case", () => {
  assert.equal(searchCatalog(catalog, { text: "不存在的关键字xyz" }).length, 0);
  assert.equal(normalize("  ＷＰＳ  Ｏffice "), "wps office");
  assert.equal(dice("abc", "abc"), 1);
});

test("category and badge filters plus paging", () => {
  assert.equal(searchCatalog(catalog, { text: "", categoryId: "dev" }).length, 2);
  assert.equal(searchCatalog(catalog, { text: "", badge: "recommend" }).length, 1);
  assert.equal(searchCatalog(catalog, { text: "", limit: 2, offset: 2 }).length, 2);
});

test("recommend badge and download volume lift default ordering", () => {
  assert.equal(searchCatalog(catalog, { text: "" })[0]?.app.id, "wps");
});

test("category tree rolls child counts into parents", () => {
  const categories: Category[] = [
    { id: "office", name: "办公", parentId: null, sortOrder: 1 },
    { id: "doc", name: "文档", parentId: "office", sortOrder: 1 },
    { id: "office-im", name: "即时通讯", parentId: "office", sortOrder: 2 },
    { id: "dev", name: "开发", parentId: null, sortOrder: 2 },
  ];
  const tree = buildCategoryTree(categories, catalog);
  assert.equal(tree.length, 2);
  const office = tree[0];
  assert.equal(office?.name, "办公");
  assert.equal(office?.children[0]?.appCount, 1);
  assert.equal(office?.appCount, 2);
  assert.deepEqual(office?.children[0]?.path, ["办公", "文档"]);
  assert.equal(tree[1]?.appCount, 2);
});

test("semver compare and range", () => {
  assert.equal(compare("1.10.0", "1.9.0"), 1);
  assert.equal(compare("1.0.0-beta", "1.0.0"), -1);
  assert.equal(compare("1.0.0+build", "1.0.0"), 0);
  assert.ok(satisfies("1.2.3", ">=1.0.0,<2.0.0"));
  assert.ok(!satisfies("2.0.0", ">=1.0.0,<2.0.0"));
});

test("semver compare handles the 4-part versions Windows actually reports", () => {
  // 真机上常见四段版本，旧实现只比前三段 → 这些都会被误判为相等，漏报可升级
  assert.equal(compare("12.1.0.28488", "12.1.0.30100"), -1); // WPS 内部构建号
  assert.equal(compare("12.1.0.30100", "12.1.0.28488"), 1);
  assert.equal(compare("6.9.1.868", "6.9.1.9999"), -1); // Quark
  assert.equal(compare("14.40.33214.0", "14.42.34433.0"), -1); // VC++ Redistributable
  assert.equal(compare("10.0.26624", "10.1.26100.7705"), -1); // Universal CRT（前置取最高依赖此序）
  // 第四段相等或缺失视为同版本，尾部补零不改变结果
  assert.equal(compare("12.1.0", "12.1.0.0"), 0);
  assert.equal(compare("1.2.3.4", "1.2.3.4"), 0);
  // 数字核心相等时仍按预发布/构建元数据规则
  assert.equal(compare("1.2.3.4-beta", "1.2.3.4"), -1);
});

test("bayesian smoothing keeps a single five-star app below a proven one", () => {
  const crowd = Array.from({ length: 6 }, (_, i) => ({
    id: "crow" + String(i),
    ratings: toDistribution(Array.from({ length: 40 }, (_, j) => vote("crow" + String(i), "u" + String(j), 4))),
  }));
  const tiny = { id: "tiny", ratings: toDistribution([vote("tiny", "u1", 5)]) };
  const solid = {
    id: "solid",
    ratings: toDistribution([
      ...Array.from({ length: 20 }, (_, j) => vote("solid", "v" + String(j), 4)),
      ...Array.from({ length: 5 }, (_, j) => vote("solid", "w" + String(j), 5)),
    ]),
  };
  const ranked = rankByQuality([...crowd, tiny, solid]);
  assert.equal(ranked[0]?.id, "solid");
  const index = (id: string): number => ranked.findIndex((r) => r.id === id);
  assert.ok(index("tiny") > index("solid"));
});

test("verified installs outweigh anonymous votes of the same stars", () => {
  const inputs = [vote("x", "1", 1, false), vote("x", "2", 5, true)];
  assert.ok(effectiveDistribution(inputs, 3).mean > toDistribution(inputs).mean);
});

test("recommend ranking needs a vote floor before trusting quality", () => {
  const ranked = rankRecommend([
    { id: "fresh", downloadCount: 5000, ratings: toDistribution([vote("fresh", "1", 5)]) },
    { id: "proven", downloadCount: 400, ratings: toDistribution(Array.from({ length: 30 }, (_, j) => vote("proven", "u" + String(j), 4))) },
  ]);
  assert.equal(ranked[0]?.id, "proven");
});

import { categorySubtreeIds } from "@appcenter/core";

test("parent category search includes every descendant category", () => {
  const categories: Category[] = [
    { id: "office", name: "办公", parentId: null, sortOrder: 1 },
    { id: "doc", name: "文档", parentId: "office", sortOrder: 1 },
    { id: "deep", name: "深层", parentId: "doc", sortOrder: 1 },
    { id: "office-im", name: "即时通讯", parentId: "office", sortOrder: 2 },
    { id: "dev", name: "开发", parentId: null, sortOrder: 2 },
  ];
  assert.deepEqual(categorySubtreeIds(categories, "office").sort(), ["deep", "doc", "office", "office-im"]);
  assert.deepEqual(categorySubtreeIds(categories, "dev"), ["dev"]);
  assert.equal(searchCatalog(catalog, { text: "", categoryId: "office" }).length, 0);
  const withSubtree = searchCatalog(catalog, { text: "", categoryIds: categorySubtreeIds(categories, "office") });
  assert.deepEqual(withSubtree.map((h) => h.app.id).sort(), ["sogou", "wps"]);
});
