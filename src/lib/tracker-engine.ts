/**
 * 攀岩视频人体跟踪引擎 - 运行时模块
 * 
 * 此文件仅在浏览器端运行时动态加载，不会被 SSR 处理。
 * 所有 TensorFlow.js / pose-detection 的引用都在这里。
 */

import type {
  Keypoint,
  TrackedPerson,
  BBox,
  Viewport,
  TrackerConfig,
} from "./tracker-types";
import { DEFAULT_CONFIG } from "./tracker-types";

// ---------- 内部类型 (运行时) ----------

interface PoseResult {
  keypoints: Keypoint[];
  score?: number;
}

interface PoseDetector {
  estimatePoses(
    video: HTMLVideoElement,
    config?: Record<string, unknown>
  ): Promise<PoseResult[]>;
  dispose(): void;
}

// ---------- 主引擎类 ----------

export class ClimbingTrackerEngine {
  private detector: PoseDetector | null = null;
  private config: TrackerConfig;
  private lastValidPerson: TrackedPerson | null = null;
  private smoothedViewport: Viewport | null = null;
  private viewportVelocity: Viewport = { x: 0, y: 0, width: 0, height: 0 };
  private occlusionHoldCounter = 0;
  private frameCount = 0;
  private initialized = false;
  private lastBBoxArea = 0;

  // Dyno 检测状态
  private prevPersonCenter: { cx: number; cy: number } | null = null;
  private dynoIntensity = 0; // 0~1，当前 dyno 强度（用于放大视口）

  // 人体高度 EMA 平滑（消除 bbox 帧间波动导致的视口缩放抖动）
  private smoothedPersonH: number | null = null;

  // 最后一次有效的原始视口（检测中断时保持视角不动，而非放大到全画面）
  private lastRawViewport: Viewport | null = null;

  constructor(config?: Partial<TrackerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async init(): Promise<void> {
    if (this.initialized) return;

    // 运行时动态加载 TF 和 pose-detection
    const tf = await import("@tensorflow/tfjs");
    await tf.ready();
    const poseDetection = await import("@tensorflow-models/pose-detection");

    const model = poseDetection.SupportedModels.MoveNet;

    // 使用 SinglePose Thunder —— 精度远高于 MultiPose Lightning
    // ~30ms/帧，对实时预览完全可接受
    this.detector = (await poseDetection.createDetector(model, {
      modelType: poseDetection.movenet.modelType.SINGLEPOSE_THUNDER,
      enableSmoothing: true,
    })) as unknown as PoseDetector;

    this.initialized = true;
    console.log("[TrackerEngine] MoveNet SinglePose Thunder 模型加载完成");
  }

  reset(): void {
    this.lastValidPerson = null;
    this.smoothedViewport = null;
    this.viewportVelocity = { x: 0, y: 0, width: 0, height: 0 };
    this.occlusionHoldCounter = 0;
    this.frameCount = 0;
    this.lastBBoxArea = 0;
    this.prevPersonCenter = null;
    this.dynoIntensity = 0;
    this.smoothedPersonH = null;
    this.lastRawViewport = null;
  }

  async processFrame(
    video: HTMLVideoElement
  ): Promise<{ viewport: Viewport; person: TrackedPerson | null }> {
    if (!this.detector) {
      throw new Error("引擎未初始化，请先调用 init()");
    }

    this.frameCount++;

    const poses = await this.detector.estimatePoses(video, {
      flipHorizontal: false,
    });

    const vw = video.videoWidth;
    const vh = video.videoHeight;

    const person = this.selectClimber(poses, vw, vh);
    const targetViewport = this.computeTargetViewport(person, vw, vh);
    const smoothed = this.smoothViewport(targetViewport);

    return { viewport: smoothed, person };
  }

  /**
   * 纯人体检测 + 原始视口计算，**不做 EMA 平滑**。
   * 
   * 用于导出时的全局扫描阶段：先收集所有帧的原始视口，
   * 再由导出器做全局双向平滑和运动预判。
   * 
   * 注意：此方法不会修改引擎的 smoothedViewport / velocity 等状态，
   * 但会更新 lastValidPerson（用于跨帧人体匹配）。
   */
  async processFrameRaw(
    video: HTMLVideoElement
  ): Promise<{ viewport: Viewport; person: TrackedPerson | null }> {
    if (!this.detector) {
      throw new Error("引擎未初始化，请先调用 init()");
    }

    this.frameCount++;

    const vw = video.videoWidth;
    const vh = video.videoHeight;

    // 直接使用主检测器（已是 Thunder 模型）
    const poses = await this.detector.estimatePoses(video, {
      flipHorizontal: false,
    });

    const person = this.selectClimber(poses, vw, vh);
    // 直接返回原始目标视口，不做 EMA 平滑
    const rawViewport = this.computeTargetViewport(person, vw, vh);

    return { viewport: rawViewport, person };
  }

  private selectClimber(
    poses: PoseResult[],
    vw: number,
    vh: number
  ): TrackedPerson | null {
    if (poses.length === 0) {
      return this.handleOcclusion();
    }

    const candidates: TrackedPerson[] = poses
      .map((pose) => this.poseToTrackedPerson(pose, vw, vh))
      .filter((p) => p !== null) as TrackedPerson[];

    if (candidates.length === 0) {
      return this.handleOcclusion();
    }

    candidates.sort((a, b) => {
      const areaA = a.bbox.width * a.bbox.height;
      const areaB = b.bbox.width * b.bbox.height;
      return areaB - areaA;
    });

    if (this.lastValidPerson) {
      const best = this.findBestMatchByProximity(candidates);
      if (best) {
        const currentArea = best.bbox.width * best.bbox.height;
        if (
          this.lastBBoxArea > 0 &&
          currentArea / this.lastBBoxArea > this.config.areaJumpThreshold
        ) {
          return this.handleOcclusion();
        }
        this.lastBBoxArea = currentArea;
        this.lastValidPerson = best;
        this.occlusionHoldCounter = 0;
        return best;
      }
    }

    const best = candidates.reduce((a, b) =>
      a.confidence > b.confidence ? a : b
    );

    if (best.confidence < this.config.confidenceThreshold) {
      return this.handleOcclusion();
    }

    this.lastBBoxArea = best.bbox.width * best.bbox.height;
    this.lastValidPerson = best;
    this.occlusionHoldCounter = 0;
    return best;
  }

  private findBestMatchByProximity(
    candidates: TrackedPerson[]
  ): TrackedPerson | null {
    if (!this.lastValidPerson) return candidates[0];

    const lastCx = this.lastValidPerson.bbox.x + this.lastValidPerson.bbox.width / 2;
    const lastCy = this.lastValidPerson.bbox.y + this.lastValidPerson.bbox.height / 2;

    let bestDist = Infinity;
    let bestCandidate: TrackedPerson | null = null;

    for (const c of candidates) {
      if (c.confidence < this.config.confidenceThreshold) continue;
      const cx = c.bbox.x + c.bbox.width / 2;
      const cy = c.bbox.y + c.bbox.height / 2;
      const dist = Math.hypot(cx - lastCx, cy - lastCy);
      if (dist < bestDist) {
        bestDist = dist;
        bestCandidate = c;
      }
    }

    if (bestDist > 0.35) {
      return null;
    }

    return bestCandidate;
  }

  private handleOcclusion(): TrackedPerson | null {
    this.occlusionHoldCounter++;

    if (
      this.lastValidPerson &&
      this.occlusionHoldCounter <= this.config.occlusionMaxHoldFrames
    ) {
      return { ...this.lastValidPerson, occluded: true };
    }

    return null;
  }

  private poseToTrackedPerson(
    pose: PoseResult,
    vw: number,
    vh: number
  ): TrackedPerson | null {
    const validKps = pose.keypoints.filter(
      (kp) => (kp.score ?? 0) > 0.2
    );
    if (validKps.length < 3) return null;

    const xs = validKps.map((kp) => kp.x / vw);
    const ys = validKps.map((kp) => kp.y / vh);

    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);

    const padX = (maxX - minX) * 0.15;
    const padY = (maxY - minY) * 0.2;

    const bbox: BBox = {
      x: Math.max(0, minX - padX),
      y: Math.max(0, minY - padY),
      width: Math.min(1 - Math.max(0, minX - padX), maxX - minX + 2 * padX),
      height: Math.min(1 - Math.max(0, minY - padY), maxY - minY + 2 * padY),
    };

    const avgScore =
      validKps.reduce((sum, kp) => sum + (kp.score ?? 0), 0) /
      validKps.length;

    return {
      bbox,
      keypoints: pose.keypoints,
      confidence: avgScore,
      occluded: false,
    };
  }

  private computeTargetViewport(
    person: TrackedPerson | null,
    vw: number,
    vh: number
  ): Viewport {
    if (!person) {
      // 检测中断时：优先保持最后有效视口不动，避免视口突然放大
      this.prevPersonCenter = null;
      // dyno 强度加速衰减
      this.dynoIntensity *= 0.90;
      if (this.dynoIntensity < 0.01) this.dynoIntensity = 0;

      if (this.lastRawViewport) {
        // 有历史视口 → 保持不动（视角冻结）
        return { ...this.lastRawViewport };
      }
      // 从未检测到人体 → 只能显示完整画面
      return { x: 0, y: 0, width: 1, height: 1 };
    }

    const { bbox } = person;
    const personCx = bbox.x + bbox.width / 2;
    const personCy = bbox.y + bbox.height / 2;
    const personH = bbox.height;
    const sourceAr = vw / vh; // 源视频宽高比

    // ===== 人体高度 EMA 平滑 =====
    // AI bbox 检测帧间波动较大，直接用 personH 算视口会导致视口剧烈缩放
    // 用独立的 EMA 平滑人体高度，消除噪声
    if (this.smoothedPersonH === null) {
      this.smoothedPersonH = personH;
    } else {
      // 慢速 EMA：α = 0.08，约 12 帧才跟上一半变化
      // 对于真实的身体大小变化（靠近/远离墙壁）足够快，但能过滤帧间噪声
      const heightAlpha = 0.08;
      // 额外保护：单帧高度变化超过 30% 时视为噪声/误检，进一步降低 α
      const heightChange = Math.abs(personH - this.smoothedPersonH) / this.smoothedPersonH;
      const effectiveAlpha = heightChange > 0.3 ? heightAlpha * 0.2 : heightAlpha;
      this.smoothedPersonH += effectiveAlpha * (personH - this.smoothedPersonH);
    }
    const stablePersonH = this.smoothedPersonH;

    // ===== Dyno 检测 =====
    // 通过帧间人体中心位移来判断是否在做 dyno（跳跃/大幅移动）
    if (this.prevPersonCenter && this.config.dynoPadding > 0) {
      const dx = personCx - this.prevPersonCenter.cx;
      const dy = personCy - this.prevPersonCenter.cy;
      const displacement = Math.sqrt(dx * dx + dy * dy);

      // 阈值提高：归一化坐标下 >0.05 视为快速运动，避免误触发
      const dynoThreshold = 0.05;
      if (displacement > dynoThreshold) {
        // 运动越大，dyno 强度越高，上限 1.0
        const rawIntensity = Math.min(1.0, (displacement - dynoThreshold) / 0.10);
        this.dynoIntensity = Math.max(this.dynoIntensity, rawIntensity);
      }
    }
    this.prevPersonCenter = { cx: personCx, cy: personCy };

    // dyno 强度自然衰减（每帧衰减 2%，约 50 帧 ~= 2.5 秒回归正常）
    this.dynoIntensity *= 0.98;
    if (this.dynoIntensity < 0.01) this.dynoIntensity = 0;

    // ===== 计算裁剪区域（保持源视频宽高比）=====
    // 使用平滑后的人体高度，避免视口大小帧间剧烈波动
    let cropH = stablePersonH / this.config.targetVerticalRatio;

    // Dyno 时扩大视口：最多额外扩大 40%（从 60% 降低，减少视口跳变）
    const dynoExpansion = 1 + this.dynoIntensity * 0.4 * this.config.dynoPadding;
    cropH *= dynoExpansion;

    cropH = Math.max(cropH, this.config.minCropSize);
    cropH = Math.min(cropH, 1);

    // 保持源视频原始宽高比：cropW / cropH = sourceAr（归一化空间中）
    // 注意：在归一化空间中 width 对应实际 vw 像素，height 对应 vh 像素
    // 实际像素裁剪宽高比 = (cropW * vw) / (cropH * vh) = cropW * sourceAr / cropH
    // 要保持 sourceAr，需要 cropW * vw / (cropH * vh) = vw / vh
    // 即 cropW / cropH = 1（在归一化空间中等宽等高比例）
    // 不对 — 归一化空间中 cropW=1 对应 vw 像素，cropH=1 对应 vh 像素
    // 实际裁剪区域的像素宽高比 = (cropW * vw) / (cropH * vh)
    // 要等于 sourceAr = vw / vh → cropW = cropH
    let cropW = cropH;

    // 如果宽度溢出，限制宽度并调整高度
    if (cropW > 1) {
      cropW = 1;
      cropH = 1; // 保持比例 cropW = cropH
      cropH = Math.min(cropH, 1);
    }
    if (cropH > 1) {
      cropH = 1;
      cropW = 1;
    }

    // 定位：以人体为中心，verticalCenterBias 控制垂直偏移
    const bias = this.config.verticalCenterBias;
    let cropX = personCx - cropW / 2;
    let cropY = personCy - cropH * bias;

    cropX = Math.max(0, Math.min(cropX, 1 - cropW));
    cropY = Math.max(0, Math.min(cropY, 1 - cropH));

    const viewport = { x: cropX, y: cropY, width: cropW, height: cropH };
    // 记录有效视口，检测中断时用于保持视角不动
    this.lastRawViewport = viewport;
    return viewport;
  }

  /**
   * 平滑视口 - 多层平滑策略：
   * 1. 死区：位移小于阈值时完全忽略，避免静止时的微抖
   * 2. 速度限制：单帧最大位移限制，防止大跳变
   * 3. 自适应 EMA：根据目标变化量动态调整 α（大变化用更小的 α 来抑制）
   * 4. 速度阻尼：平滑速度变化，避免加速/减速突变
   */
  private smoothViewport(target: Viewport): Viewport {
    if (!this.smoothedViewport || this.frameCount <= 2) {
      this.smoothedViewport = { ...target };
      this.viewportVelocity = { x: 0, y: 0, width: 0, height: 0 };
      return this.smoothedViewport;
    }

    const prev = this.smoothedViewport;
    const baseAlpha = this.config.smoothingFactor;

    // 死区阈值：低于此值的变化直接忽略（归一化坐标空间）
    const deadZone = 0.002;
    // 单帧最大位移限制（归一化坐标空间）—— dyno 时放宽限制
    const maxStep = 0.035 + this.dynoIntensity * 0.04; // 基础值从0.015提高到0.035
    // 速度阻尼系数（0~1，越小越平滑）—— dyno 时降低阻尼以更快跟随
    const velocityDamping = 0.5 + this.dynoIntensity * 0.3; // 基础值从0.3提高到0.5

    const smoothAxis = (
      prevVal: number,
      targetVal: number,
      prevVel: number,
    ): { value: number; velocity: number } => {
      const diff = targetVal - prevVal;
      const absDiff = Math.abs(diff);

      // 1. 死区：微小变化直接忽略
      if (absDiff < deadZone) {
        return { value: prevVal, velocity: prevVel * velocityDamping };
      }

      // 2. 自适应 α：变化量越大，α 适度降低，但不要过度抑制
      // 当 diff 在 deadZone~0.08 范围内正常跟随，超出后适度衰减
      const normalizedDiff = Math.min(absDiff / 0.08, 1);
      const adaptiveAlpha = baseAlpha * (1 - normalizedDiff * 0.4);

      // 3. EMA 计算目标速度
      const targetVelocity = diff * adaptiveAlpha;

      // 4. 速度阻尼：平滑速度变化
      const smoothedVelocity = prevVel + velocityDamping * (targetVelocity - prevVel);

      // 5. 速度限制：钳制最大单帧位移
      const clampedVelocity = Math.max(-maxStep, Math.min(maxStep, smoothedVelocity));

      return {
        value: prevVal + clampedVelocity,
        velocity: clampedVelocity,
      };
    };

    const xResult = smoothAxis(prev.x, target.x, this.viewportVelocity.x);
    const yResult = smoothAxis(prev.y, target.y, this.viewportVelocity.y);
    const wResult = smoothAxis(prev.width, target.width, this.viewportVelocity.width);
    const hResult = smoothAxis(prev.height, target.height, this.viewportVelocity.height);

    this.smoothedViewport = {
      x: xResult.value,
      y: yResult.value,
      width: wResult.value,
      height: hResult.value,
    };

    this.viewportVelocity = {
      x: xResult.velocity,
      y: yResult.velocity,
      width: wResult.velocity,
      height: hResult.velocity,
    };

    return this.smoothedViewport;
  }

  async dispose(): Promise<void> {
    if (this.detector) {
      this.detector.dispose();
      this.detector = null;
    }
    this.initialized = false;
    this.reset();
  }

  getConfig(): TrackerConfig {
    return { ...this.config };
  }

  updateConfig(partial: Partial<TrackerConfig>): void {
    this.config = { ...this.config, ...partial };
  }
}
