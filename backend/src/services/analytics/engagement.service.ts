import { PlatformEngagement, PlatformMultiplier, EngagementResult } from "./types";

export class EngagementService {

  static calculatePlatformMultiplier(
    metric: PlatformEngagement
  ): PlatformMultiplier {

    if (metric.followers <= 0) {
      return {
        platform: metric.platform,
        engagementRate: 0,
        engagedCount: 0,
        multiplier: 1
      };
    }

    const totalEngagement =
      metric.likes +
      metric.comments +
      metric.shares;

    const engagementRate =
      totalEngagement / metric.followers;

    const engagedCount =
      engagementRate * metric.followers;

    const rawMultiplier =
      1 + Math.log(1 + engagedCount);

    const multiplier =
      Math.min(rawMultiplier / 10, 2);

    return {
      platform: metric.platform,
      engagementRate,
      engagedCount,
      multiplier
    };
  }

  static calculate(
    metrics: PlatformEngagement[]
  ): EngagementResult {

    if (!metrics.length) {
      return {
        engagementMultiplier: 1,
        platformMultipliers: []
      };
    }

    const platformMultipliers =
      metrics.map((metric) =>
        this.calculatePlatformMultiplier(metric)
      );

    const averageMultiplier =
      platformMultipliers.reduce(
        (sum, p) => sum + p.multiplier,
        0
      ) / platformMultipliers.length;

    return {
      engagementMultiplier: averageMultiplier,
      platformMultipliers
    };
  }
}