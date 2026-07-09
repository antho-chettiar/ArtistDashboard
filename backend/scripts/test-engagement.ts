import { EngagementService } from "../src/services/analytics/engagement.service";

const result = EngagementService.calculate([
  {
    platform: "INSTAGRAM",
    followers: 100000,
    likes: 5000,
    comments: 500,
    shares: 200
  },
  {
    platform: "YOUTUBE",
    followers: 50000,
    likes: 3000,
    comments: 150,
    shares: 50
  }
]);

console.log(JSON.stringify(result, null, 2));