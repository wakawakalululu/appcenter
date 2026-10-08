import type { AppId, RatingDistribution, RatingInput } from "./types.ts";

export const EMPTY_DISTRIBUTION: RatingDistribution = { buckets: [0, 0, 0, 0, 0], mean: 0, count: 0 };

export function toDistribution(inputs: readonly RatingInput[]): RatingDistribution {
  const buckets: [number, number, number, number, number] = [0, 0, 0, 0, 0];
  let sum = 0;
  for (const r of inputs) {
    // 非有限值（NaN/Infinity 之外的 NaN、非数字类型）必须**丢掉**而不是钳位：
    // 实测旧写法 Math.round(NaN) 会同时做到「不进桶」与「sum 变 NaN」——一条坏评分毒掉整个应用的均值，
    // 排序比较随即拿到 NaN、顺序退化成输入顺序。钳成 1 或 5 则是凭空造一票，两个方向都更糟。
    // Infinity 是有限语义内的极端值，按 Math.min/max 钳到 5/1 保留（与规格的「先四舍五入再钳 1..5」一致）。
    if (typeof r.stars !== "number" || Number.isNaN(r.stars)) continue;
    const star = Math.min(5, Math.max(1, Math.round(r.stars)));
    buckets[star - 1] = (buckets[star - 1] ?? 0) + 1;
    sum += star;
  }
  const count = buckets.reduce((a, b) => a + b, 0);
  return { buckets, mean: count === 0 ? 0 : sum / count, count };
}

export function bayesianAverage(distribution: RatingDistribution, priorMean: number, priorWeight: number): number {
  const total = distribution.count;
  const denom = priorWeight + total;
  // 调用方可覆盖 priorWeight，所以「分母为 0」并非不可达（旧注释就这么写，是错的）：
  // priorWeight=0 且无人评分时返回 priorMean，而不是让 NaN 进到排序里。
  if (denom === 0) return priorMean;
  return (priorWeight * priorMean + distribution.mean * total) / denom;
}

/** 真实装过的用户评分权重更高，避免刷分主导榜单。 */
export function effectiveDistribution(inputs: readonly RatingInput[], verifiedMultiplier = 3): RatingDistribution {
  const weighted: RatingInput[] = [];
  // 覆盖值本身也可能是脏数据：实测传 NaN 会让 Math.max(1, NaN) 得到 NaN，
  // 循环一次都不执行 ⇒ 「这条评分存在，但被静默抹掉」（count 从 1 变 0）。
  // 0 与负数是被 Math.max(1, …) 兜住的（一条真实投票至少算一票），所以只有非有限值需要这道防线。
  const multiplier = Number.isFinite(verifiedMultiplier) ? verifiedMultiplier : 3;
  for (const r of inputs) {
    const copies = r.verifiedInstall ? Math.max(1, multiplier) : 1;
    for (let i = 0; i < copies; i++) weighted.push(r);
  }
  return toDistribution(weighted);
}

export interface RankableApp {
  id: AppId;
  ratings: RatingDistribution;
}

export function globalPriorMean(apps: readonly RankableApp[]): number {
  let sum = 0;
  let count = 0;
  for (const a of apps) {
    sum += a.ratings.mean * a.ratings.count;
    count += a.ratings.count;
  }
  return count === 0 ? 3 : sum / count;
}

export function rankByQuality(
  apps: readonly RankableApp[],
  options: { priorWeight?: number } = {},
): { id: AppId; score: number }[] {
  const priorWeight = options.priorWeight ?? 20;
  const priorMean = globalPriorMean(apps);
  return apps
    .map((a) => ({ id: a.id, score: bayesianAverage(a.ratings, priorMean, priorWeight) }))
    .sort((x, y) => y.score - x.score || x.id.localeCompare(y.id));
}

/** 推荐位排序：平滑评分优先，评分不足时回退到下载量。 */
export function rankRecommend(
  apps: readonly (RankableApp & { downloadCount: number })[],
  options: { priorWeight?: number; minVotes?: number } = {},
): { id: AppId; score: number }[] {
  const priorWeight = options.priorWeight ?? 20;
  const minVotes = options.minVotes ?? 5;
  const priorMean = globalPriorMean(apps);
  return apps
    .map((a) => {
      const quality = bayesianAverage(a.ratings, priorMean, priorWeight);
      // 下载量是外部可写字段，可能是负数或非有限值：log10(负数+1) 给出 -Infinity/NaN，
      // 而 NaN 参与排序比较会让顺序变得任意（实测负数那条反而排到第一位）。
      // 决定：非有限或负数一律按 0 计（"没有下载记录"），不引入新语义、也不让脏数据毁掉全序。
      const downloads = Number.isFinite(a.downloadCount) && a.downloadCount > 0 ? a.downloadCount : 0;
      const popularity = Math.log10(downloads + 1);
      const score = a.ratings.count >= minVotes ? quality + popularity * 0.1 : popularity;
      return { id: a.id, score };
    })
    .sort((x, y) => y.score - x.score || x.id.localeCompare(y.id));
}
