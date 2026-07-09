export interface PlatformEngagement {
  platform: string;
  followers: number;
  likes: number;
  comments: number;
  shares: number;
  streams?: number;
}

export interface PlatformMultiplier {
  platform: string;
  engagementRate: number;
  engagedCount: number;
  multiplier: number;
}

export interface EngagementResult {
  engagementMultiplier: number;
  platformMultipliers: PlatformMultiplier[];
}