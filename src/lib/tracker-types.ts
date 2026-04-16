/**
 * 攀岩视频人体跟踪引擎
 * 
 * 核心功能：
 * 1. 使用 TensorFlow.js MoveNet 模型进行人体姿态检测
 * 2. 智能裁剪视口，让攀岩者居中且占画面竖向 ~60%
 * 3. 遮挡检测：当有人遮挡时保持上一次有效位置，避免跟踪跳变
 * 4. 平滑过渡：使用 EMA (指数移动平均) 实现丝滑的镜头跟随
 * 
 * 注意：所有 TensorFlow.js / pose-detection 的引用都在运行时动态 import，
 * 不能在此文件中使用任何来自这些库的静态 import。
 */

// ---------- 类型定义 ----------

export interface Keypoint {
  x: number;
  y: number;
  score?: number;
  name?: string;
}

export interface TrackedPerson {
  bbox: BBox;
  keypoints: Keypoint[];
  confidence: number;
  occluded: boolean;
}

export interface BBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Viewport {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TrackerConfig {
  targetVerticalRatio: number;
  smoothingFactor: number;
  confidenceThreshold: number;
  occlusionMaxHoldFrames: number;
  verticalCenterBias: number;
  minCropSize: number;
  areaJumpThreshold: number;
  /** dyno 模式：检测到快速运动时自动放大视口（0 = 禁用，1 = 默认灵敏度） */
  dynoPadding: number;
}

export const DEFAULT_CONFIG: TrackerConfig = {
  targetVerticalRatio: 0.60,
  smoothingFactor: 0.12,
  confidenceThreshold: 0.25,
  occlusionMaxHoldFrames: 60,
  verticalCenterBias: 0.55,
  minCropSize: 0.15,
  areaJumpThreshold: 2.5,
  dynoPadding: 1.0,
};
