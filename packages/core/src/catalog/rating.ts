import type { AppId, RatingDistribution, RatingInput } from "./types.ts";

export const EMPTY_DISTRIBUTION: RatingDistribution = { buckets: [0, 0, 0, 0, 0], mean: 0, count: 0 };

export function toDistribution(inputs: readonly RatingInput[]): RatingDistribution {
  const buckets: [number, number, number, number, number] = [0, 0, 0, 0, 0];
  let sum = 0;
  for (const r of inputs) {
    const star = Math.min(5, Math.max(1, Math.round(r.stars)));
    buckets[star - 1] = (buckets[star - 1] ?? 0) + 1;
    sum += star;
  }
  const count = buckets.reduce((a, b) => a + b, 0);
  return { buckets, mean: count === 0 ? 0 : sum / count, count };
}

export function bayesianAverage(distribution: RatingDistribution, priorMean: number, priorWeight: number): number {
  const total = distribution.count;
  return (priorWeight * priorMean + distribution.mean * total) / (priorWeight + total);
}

/** 真实装过的用户评分权重更高，避免刷分主导榜单。 */
export function effectiveDistribution(inputs: readonly RatingInput[], verifiedMultiplier = 3): RatingDistribution {
  const weighted: RatingInput[] = [];
  for (const r of inputs) {
    const copies = r.verifiedInstall ? Math.max(1, verifiedMultiplier) : 1;
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
      const popularity = Math.log10(a.downloadCount + 1);
      const score = a.ratings.count >= minVotes ? quality + popularity * 0.1 : popularity;
      return { id: a.id, score };
    })
    .sort((x, y) => y.score - x.score || x.id.localeCompare(y.id));
}
