import Activity from "./pages/Activity";
import AssetsOrDelivery from "./pages/AssetsOrDelivery";
import MediaCollections from "./pages/MediaCollections";
import MediaFilms from "./pages/MediaFilms";
import MediaLibrary from "./pages/MediaLibrary";
import MediaProducts from "./pages/MediaProducts";
import ReviewGuide from "./pages/ReviewGuide";
import SkillOperations from "./pages/SkillOperations";
import TeamPerformance from "./pages/TeamPerformance";

export const industryRoutes = [
  { path: "/ai-video/assets", capabilityId: "ai-video.assets", element: <AssetsOrDelivery />, legacyPaths: ["/p10"] },
  { path: "/ai-video/skills", capabilityId: "ai-video.skills", element: <SkillOperations /> },
  { path: "/ai-video/team-performance", capabilityId: "ai-video.team-performance", element: <TeamPerformance /> },
  { path: "/ai-video/team-performance/:agentId", capabilityId: "ai-video.team-performance", element: <TeamPerformance /> },
  { path: "/ai-video/activity", capabilityId: "ai-video.activity", element: <Activity /> },
  { path: "/ai-video/review-guide", capabilityId: "ai-video.review-guide", element: <ReviewGuide /> },
  /**
   * 媒资库（T-2026-0926-0008）：四个页面各自有导航槽位与能力声明
   * （bundles/ai-video/bundle.json → workloom.ui.navigation.slots），
   * 缺任一侧都会被 IndustryRouteBoundary 拦下——路由与槽位必须成对提交。
   */
  { path: "/ai-video/media", capabilityId: "ai-video.media", element: <MediaLibrary /> },
  { path: "/ai-video/media/collections", capabilityId: "ai-video.media-collections", element: <MediaCollections /> },
  { path: "/ai-video/media/films", capabilityId: "ai-video.media-films", element: <MediaFilms /> },
  { path: "/ai-video/media/products", capabilityId: "ai-video.media-products", element: <MediaProducts /> },
] as const;
