/**
 * 视频导出器
 *
 * 使用 WebCodecs VideoEncoder + mp4-muxer 实现纯前端视频导出
 * 通过精确控制 VideoFrame 时间戳（微秒级），确保导出视频的帧率和时长与源视频一致
 * 
 * 优化策略：
 * - AI 推理降频：不再每帧都跑 MoveNet，而是每秒推理 AI_INFERENCE_FPS 次
 * - 中间帧视口线性插值：非 AI 帧通过前后关键帧插值获得视口
 * - 支持读取源视频原始帧率和分辨率
 */

import { Muxer, ArrayBufferTarget } from "mp4-muxer";

export interface ExportConfig {
  width: number;
  height: number;
  videoBitrate: number; // bps
  fps: number;
}

/** 源视频的元数据信息 */
export interface VideoMeta {
  width: number;
  height: number;
  fps: number; // 估算的帧率
  duration: number;
}

export interface ExportProgress {
  phase: "preparing" | "scanning" | "encoding" | "finalizing" | "done" | "error";
  progress: number; // 0~1
  message: string;
  currentTime?: number;
  duration?: number;
}

export const DEFAULT_EXPORT_CONFIG: ExportConfig = {
  width: 1080,
  height: 1920,
  videoBitrate: 8_000_000,
  fps: 30,
};

// 标准输出分辨率档位（短边像素数）
const RESOLUTION_TIERS = [
  { label: "4K", shortEdge: 2160, bitrate: 20_000_000 },
  { label: "1440p", shortEdge: 1440, bitrate: 12_000_000 },
  { label: "1080p", shortEdge: 1080, bitrate: 8_000_000 },
  { label: "720p", shortEdge: 720, bitrate: 5_000_000 },
  { label: "540p", shortEdge: 540, bitrate: 3_000_000 },
];

export interface ExportPreset {
  label: string;
  shortEdge: number;
  bitrate: number;
  /** 是否为推荐选项（最接近实际有效分辨率） */
  recommended?: boolean;
  /** 相对于有效分辨率是放大还是缩小 */
  quality: "native" | "upscale" | "downscale";
}

/**
 * 根据源视频尺寸和平均 viewport 计算实际有效分辨率（裁切区域的真实像素数）
 * viewport 的 width/height 是归一化的 0~1，代表裁切占源视频的比例
 */
export function computeEffectiveResolution(
  sourceWidth: number,
  sourceHeight: number,
  avgViewportWidth: number,
  avgViewportHeight: number,
): { effectiveWidth: number; effectiveHeight: number; effectiveShortEdge: number } {
  const effectiveWidth = Math.round(sourceWidth * avgViewportWidth);
  const effectiveHeight = Math.round(sourceHeight * avgViewportHeight);
  const effectiveShortEdge = Math.min(effectiveWidth, effectiveHeight);
  return { effectiveWidth, effectiveHeight, effectiveShortEdge };
}

/**
 * 根据实际有效分辨率，生成智能输出预设列表
 * - 只保留不超过有效分辨率太多的档位（允许最多高一档，标记为 upscale）
 * - 最接近有效分辨率的档位标记为推荐
 */
export function buildSmartPresets(effectiveShortEdge: number): ExportPreset[] {
  const presets: ExportPreset[] = [];

  for (const tier of RESOLUTION_TIERS) {
    const ratio = tier.shortEdge / effectiveShortEdge;

    if (ratio > 1.3) {
      // 超过有效分辨率 30% 以上，放大太多没意义，跳过
      continue;
    }

    let quality: ExportPreset["quality"];
    if (ratio > 1.05) {
      quality = "upscale";
    } else if (ratio < 0.95) {
      quality = "downscale";
    } else {
      quality = "native";
    }

    presets.push({
      ...tier,
      quality,
    });
  }

  // 如果一个都没有（有效分辨率极低），至少保留最低档
  if (presets.length === 0) {
    const lowest = RESOLUTION_TIERS[RESOLUTION_TIERS.length - 1];
    presets.push({ ...lowest, quality: "upscale" });
  }

  // 找最接近有效分辨率的档位标记为推荐
  let bestIdx = 0;
  let bestDiff = Infinity;
  for (let i = 0; i < presets.length; i++) {
    const diff = Math.abs(presets[i].shortEdge - effectiveShortEdge);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestIdx = i;
    }
  }
  presets[bestIdx].recommended = true;

  return presets;
}

/**
 * 根据源视频尺寸和短边分辨率计算导出宽高
 * 保持源视频的原始宽高比
 */
export function computeExportDimensions(
  sourceWidth: number,
  sourceHeight: number,
  shortEdge: number,
): { width: number; height: number } {
  const ar = sourceWidth / sourceHeight;
  let w: number, h: number;
  if (ar >= 1) {
    // 横版或正方形：短边是高度
    h = shortEdge;
    w = Math.round(h * ar);
  } else {
    // 竖版：短边是宽度
    w = shortEdge;
    h = Math.round(w / ar);
  }
  // 确保偶数（视频编码器要求）
  w = w % 2 === 0 ? w : w + 1;
  h = h % 2 === 0 ? h : h + 1;
  return { width: w, height: h };
}

// =========== 编码后端（WebCodecs + mp4-muxer）===========

/**
 * 编码后端接口（仅 WebCodecs 实现）
 * 精确控帧、时间戳精准、输出 MP4
 */
interface EncoderBackend {
  /** 编码一帧（canvas 当前内容） */
  encodeFrame(canvas: HTMLCanvasElement, frameIndex: number, isKeyFrame: boolean): void;
  /** 取消并关闭编码器 */
  cancel(): void;
  /** 检查是否有编码错误 */
  checkError(): void;
  /** 完成编码，返回 Blob URL */
  finalize(): Promise<string>;
}

/** 创建 WebCodecs 编码后端 (MP4) */
function createWebCodecsBackend(
  width: number,
  height: number,
  fps: number,
  bitrate: number,
): EncoderBackend {
  // 精确计算每帧时长（微秒），使用整数运算避免浮点漂移
  const frameDurationUs = Math.round(1_000_000 / fps);

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: "avc", width, height },
    fastStart: "in-memory",
    // "strict" 要求时间戳从 0 开始且单调递增，生成更规范的 MP4
    // QuickTime (Mac) 对 MP4 合规性要求严格，offset 模式容易出问题
    firstTimestampBehavior: "strict",
  });

  let encoderError: Error | null = null;

  const videoEncoder = new VideoEncoder({
    output: (chunk, meta) => {
      muxer.addVideoChunk(chunk, meta ?? undefined);
    },
    error: (e) => {
      encoderError = e;
    },
  });

  // H.264 High Profile — 根据分辨率动态选择 Level：
  //   Level 4.0 (640028): max coded area  2,097,152 (e.g. 1920×1088) — Mac 兼容性最好
  //   Level 4.2 (64002A): max coded area  2,228,224 (e.g. 2048×1088)
  //   Level 5.0 (640032): max coded area  5,652,480 (e.g. 2560×1920)
  //   Level 5.1 (640033): max coded area  9,437,184 (e.g. 4096×2304)
  // 优先用低 Level 保证 Mac QuickTime 兼容，分辨率超限时自动升级
  const codedArea = width * height;
  let avcLevel: string;
  if (codedArea <= 2_097_152) {
    avcLevel = "avc1.640028"; // Level 4.0
  } else if (codedArea <= 2_228_224) {
    avcLevel = "avc1.64002A"; // Level 4.2
  } else if (codedArea <= 5_652_480) {
    avcLevel = "avc1.640032"; // Level 5.0
  } else {
    avcLevel = "avc1.640033"; // Level 5.1
  }
  console.log(
    `[VideoExporter] 分辨率 ${width}×${height} (${codedArea}px²), 使用 codec: ${avcLevel}`,
  );

  videoEncoder.configure({
    codec: avcLevel,
    width,
    height,
    bitrate,
    framerate: fps,
  });

  return {
    encodeFrame(canvas, frameIndex, isKeyFrame) {
      // 时间戳从 0 开始，严格按帧序号 × 帧时长计算
      const timestampUs = frameIndex * frameDurationUs;
      const frame = new VideoFrame(canvas, {
        timestamp: timestampUs,
        duration: frameDurationUs,
      });
      videoEncoder.encode(frame, { keyFrame: isKeyFrame });
      frame.close();
    },
    cancel() {
      videoEncoder.close();
    },
    checkError() {
      if (encoderError) throw encoderError;
    },
    async finalize() {
      await videoEncoder.flush();
      videoEncoder.close();
      muxer.finalize();
      const { buffer } = muxer.target as ArrayBufferTarget;
      const blob = new Blob([buffer], { type: "video/mp4" });
      return URL.createObjectURL(blob);
    },
  };
}

/**
 * 创建 WebCodecs 编码后端
 * 强制使用 WebCodecs (VideoEncoder + mp4-muxer) 导出 MP4
 * 需要安全上下文（HTTPS 或 localhost）
 */
function createEncoder(
  _canvas: HTMLCanvasElement,
  width: number,
  height: number,
  fps: number,
  bitrate: number,
): EncoderBackend {
  if (typeof VideoEncoder !== "function" || typeof VideoFrame !== "function") {
    throw new Error(
      "[VideoExporter] WebCodecs 不可用（需要安全上下文 HTTPS 或 localhost），无法导出视频",
    );
  }
  console.log("[VideoExporter] 使用 WebCodecs 编码后端 (MP4)");
  return createWebCodecsBackend(width, height, fps, bitrate);
}

/** AI 推理频率 (每秒多少帧做推理，其余帧插值) */
const AI_INFERENCE_FPS = 5;

type Viewport = { x: number; y: number; width: number; height: number };

/** Hermite smoothstep: 0 处和 1 处导数为 0，过渡更自然 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function smoothstep(t: number): number {
  t = Math.max(0, Math.min(1, t));
  return t * t * (3 - 2 * t);
}

/** 线性插值两个视口（跟随更及时） */
function lerpViewport(a: Viewport, b: Viewport, t: number): Viewport {
  const ct = Math.max(0, Math.min(1, t));
  return {
    x: a.x + (b.x - a.x) * ct,
    y: a.y + (b.y - a.y) * ct,
    width: a.width + (b.width - a.width) * ct,
    height: a.height + (b.height - a.height) * ct,
  };
}

// =========== 全局视口规划算法 ===========

/**
 * 计算每帧的运动速度（归一化坐标空间中人体中心的帧间位移）
 */
function computeMotionSpeeds(
  keyframes: { time: number; viewport: Viewport }[],
): number[] {
  const speeds: number[] = [0];
  for (let i = 1; i < keyframes.length; i++) {
    const prev = keyframes[i - 1].viewport;
    const curr = keyframes[i].viewport;
    const dt = keyframes[i].time - keyframes[i - 1].time;
    if (dt <= 0) {
      speeds.push(0);
      continue;
    }
    // 视口中心的位移速度
    const dx = (curr.x + curr.width / 2) - (prev.x + prev.width / 2);
    const dy = (curr.y + curr.height / 2) - (prev.y + prev.height / 2);
    speeds.push(Math.sqrt(dx * dx + dy * dy) / dt);
  }
  return speeds;
}

/**
 * 全局智能视口规划（核心算法）
 *
 * 与实时 EMA 的根本区别：我们拥有未来帧信息，可以做到：
 * 1. **双向高斯平滑**：前后对称平滑，消除抖动但不产生滞后
 * 2. **运动自适应平滑窗口**：快速运动时缩小窗口（更紧跟随），静止时放大窗口（更稳定）
 * 3. **前瞻预判**：利用未来几帧信息提前开始移动视口，而非等人物移动后才追赶
 * 4. **速度限制 + 加速度限制**：确保视口运动丝滑，无突变
 */
function planViewportsGlobally(
  keyframes: { time: number; viewport: Viewport }[],
): { time: number; viewport: Viewport }[] {
  if (keyframes.length <= 2) return keyframes;

  const speeds = computeMotionSpeeds(keyframes);

  // ===== 第1步：运动自适应高斯平滑 =====
  // 快速运动 → 小窗口（紧跟随）；慢速/静止 → 大窗口（超稳定）
  const minWindow = 3;  // 快速运动时最小窗口
  const maxWindow = Math.min(15, Math.max(5, Math.floor(keyframes.length / 8) * 2 + 1)); // 静止时最大窗口

  // 速度阈值：归一化坐标空间中 >0.15/s 视为快速运动
  const speedThresholdFast = 0.15;
  const speedThresholdSlow = 0.03;

  const adaptiveSmoothed = keyframes.map((kf, idx) => {
    // 取附近几帧的平均速度
    const localSpeedWindow = 3;
    let avgSpeed = 0;
    let count = 0;
    for (let j = -localSpeedWindow; j <= localSpeedWindow; j++) {
      const si = Math.max(0, Math.min(speeds.length - 1, idx + j));
      avgSpeed += speeds[si];
      count++;
    }
    avgSpeed /= count;

    // 根据速度计算自适应窗口大小
    const speedRatio = Math.max(0, Math.min(1,
      (avgSpeed - speedThresholdSlow) / (speedThresholdFast - speedThresholdSlow)
    ));
    // speedRatio=0 → 慢速 → 大窗口；speedRatio=1 → 快速 → 小窗口
    const windowSize = Math.round(maxWindow - speedRatio * (maxWindow - minWindow));
    // 确保奇数
    const ws = windowSize % 2 === 0 ? windowSize + 1 : windowSize;
    const half = Math.floor(ws / 2);

    // 高斯权重
    const sigma = Math.max(half / 2, 0.5);
    let sumX = 0, sumY = 0, sumW = 0, sumH = 0, totalWeight = 0;

    for (let j = -half; j <= half; j++) {
      const srcIdx = Math.max(0, Math.min(keyframes.length - 1, idx + j));
      const w = Math.exp(-(j * j) / (2 * sigma * sigma));
      sumX += keyframes[srcIdx].viewport.x * w;
      sumY += keyframes[srcIdx].viewport.y * w;
      sumW += keyframes[srcIdx].viewport.width * w;
      sumH += keyframes[srcIdx].viewport.height * w;
      totalWeight += w;
    }

    return {
      time: kf.time,
      viewport: {
        x: sumX / totalWeight,
        y: sumY / totalWeight,
        width: sumW / totalWeight,
        height: sumH / totalWeight,
      },
    };
  });

  // ===== 第2步：前瞻偏移 =====
  // 利用未来帧信息，让视口提前 0.2~0.4 秒开始移动
  const lookAheadTime = 0.3; // 秒
  const lookAheadFrames: { time: number; viewport: Viewport }[] = adaptiveSmoothed.map((kf, idx) => {
    // 找到 lookAheadTime 秒后对应的帧
    const targetTime = kf.time + lookAheadTime;
    let futureIdx = idx;
    while (futureIdx < adaptiveSmoothed.length - 1 && adaptiveSmoothed[futureIdx].time < targetTime) {
      futureIdx++;
    }

    if (futureIdx === idx) return kf;

    // 在当前帧和未来帧之间做加权混合
    // 混合权重：快速运动时更多偏向未来帧
    const localSpeed = speeds[Math.min(idx, speeds.length - 1)];
    const futureWeight = Math.min(0.4, Math.max(0.1,
      localSpeed / speedThresholdFast * 0.3
    ));

    const curr = kf.viewport;
    const future = adaptiveSmoothed[futureIdx].viewport;

    return {
      time: kf.time,
      viewport: {
        x: curr.x + (future.x - curr.x) * futureWeight,
        y: curr.y + (future.y - curr.y) * futureWeight,
        width: curr.width + (future.width - curr.width) * futureWeight,
        height: curr.height + (future.height - curr.height) * futureWeight,
      },
    };
  });

  // ===== 第3步：速度和加速度限制（确保丝滑） =====
  // 前向传递：限制帧间最大位移
  // 位置轴(x,y)允许较快移动以跟随人物；缩放轴(width,height)严格限速防止视口大小剧烈波动
  const maxPosSpeedPerSec = 0.5;   // 位置轴：每秒最大位移
  const maxScaleSpeedPerSec = 0.15; // 缩放轴：每秒最大变化（远小于位置轴）
  const result = [...lookAheadFrames];

  for (let i = 1; i < result.length; i++) {
    const dt = result[i].time - result[i - 1].time;
    if (dt <= 0) continue;

    const prev = result[i - 1].viewport;
    const curr = result[i].viewport;
    const clamped = { ...curr };

    // 位置轴
    for (const axis of ["x", "y"] as (keyof Viewport)[]) {
      const maxStep = maxPosSpeedPerSec * dt;
      const diff = curr[axis] - prev[axis];
      if (Math.abs(diff) > maxStep) {
        clamped[axis] = prev[axis] + Math.sign(diff) * maxStep;
      }
    }
    // 缩放轴（更严格）
    for (const axis of ["width", "height"] as (keyof Viewport)[]) {
      const maxStep = maxScaleSpeedPerSec * dt;
      const diff = curr[axis] - prev[axis];
      if (Math.abs(diff) > maxStep) {
        clamped[axis] = prev[axis] + Math.sign(diff) * maxStep;
      }
    }
    result[i] = { time: result[i].time, viewport: clamped };
  }

  // 反向传递：消除前向传递中的不对称
  for (let i = result.length - 2; i >= 0; i--) {
    const dt = result[i + 1].time - result[i].time;
    if (dt <= 0) continue;

    const next = result[i + 1].viewport;
    const curr = result[i].viewport;
    const clamped = { ...curr };

    for (const axis of ["x", "y"] as (keyof Viewport)[]) {
      const maxStep = maxPosSpeedPerSec * dt;
      const diff = curr[axis] - next[axis];
      if (Math.abs(diff) > maxStep) {
        clamped[axis] = next[axis] + Math.sign(diff) * maxStep;
      }
    }
    for (const axis of ["width", "height"] as (keyof Viewport)[]) {
      const maxStep = maxScaleSpeedPerSec * dt;
      const diff = curr[axis] - next[axis];
      if (Math.abs(diff) > maxStep) {
        clamped[axis] = next[axis] + Math.sign(diff) * maxStep;
      }
    }
    result[i] = { time: result[i].time, viewport: clamped };
  }

  // ===== 第4步：最终轻度高斯平滑（消除速度限制引入的小锯齿）=====
  const finalWindow = 3;
  const finalHalf = Math.floor(finalWindow / 2);
  const finalSigma = 0.8;

  const finalResult = result.map((kf, idx) => {
    let sumX = 0, sumY = 0, sumW = 0, sumH = 0, totalWeight = 0;

    for (let j = -finalHalf; j <= finalHalf; j++) {
      const srcIdx = Math.max(0, Math.min(result.length - 1, idx + j));
      const w = Math.exp(-(j * j) / (2 * finalSigma * finalSigma));
      sumX += result[srcIdx].viewport.x * w;
      sumY += result[srcIdx].viewport.y * w;
      sumW += result[srcIdx].viewport.width * w;
      sumH += result[srcIdx].viewport.height * w;
      totalWeight += w;
    }

    return {
      time: kf.time,
      viewport: {
        x: sumX / totalWeight,
        y: sumY / totalWeight,
        width: sumW / totalWeight,
        height: sumH / totalWeight,
      },
    };
  });

  return finalResult;
}

/**
 * 简单高斯平滑（用于不需要智能规划的场景，如调试视频中的原始叠加层）
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function smoothKeyframes(
  keyframes: { time: number; viewport: Viewport }[],
  windowSize: number = 5,
): { time: number; viewport: Viewport }[] {
  if (keyframes.length <= 2) return keyframes;

  const half = Math.floor(windowSize / 2);

  // 生成高斯权重
  const sigma = half / 2;
  const weights: number[] = [];
  for (let i = -half; i <= half; i++) {
    weights.push(Math.exp(-(i * i) / (2 * sigma * sigma)));
  }

  const result = keyframes.map((kf, idx) => {
    let sumX = 0, sumY = 0, sumW = 0, sumH = 0, totalWeight = 0;

    for (let j = -half; j <= half; j++) {
      const srcIdx = Math.max(0, Math.min(keyframes.length - 1, idx + j));
      const w = weights[j + half];
      sumX += keyframes[srcIdx].viewport.x * w;
      sumY += keyframes[srcIdx].viewport.y * w;
      sumW += keyframes[srcIdx].viewport.width * w;
      sumH += keyframes[srcIdx].viewport.height * w;
      totalWeight += w;
    }

    return {
      time: kf.time,
      viewport: {
        x: sumX / totalWeight,
        y: sumY / totalWeight,
        width: sumW / totalWeight,
        height: sumH / totalWeight,
      },
    };
  });

  return result;
}

/**
 * 估算视频帧率
 * 使用 requestVideoFrameCallback（如果支持）或 fallback 为 30fps
 */
export async function estimateVideoFps(video: HTMLVideoElement): Promise<number> {
  // 如果浏览器支持 requestVideoFrameCallback，用它来精确测量
  if ("requestVideoFrameCallback" in video) {
    return new Promise<number>((resolve) => {
      const timestamps: number[] = [];
      const sampleCount = 10;
      let count = 0;

      const wasPlaying = !video.paused;
      const savedTime = video.currentTime;

      // 临时静音播放来采集帧时间
      video.muted = true;
      video.currentTime = 0;

      const onFrame = (_now: number, metadata: { mediaTime: number }) => {
        timestamps.push(metadata.mediaTime);
        count++;
        if (count < sampleCount + 1) {
          (video as HTMLVideoElement & { requestVideoFrameCallback: (cb: typeof onFrame) => void }).requestVideoFrameCallback(onFrame);
        } else {
          video.pause();
          video.currentTime = savedTime;
          if (wasPlaying) video.play();

          // 计算平均帧间隔
          const intervals: number[] = [];
          for (let i = 1; i < timestamps.length; i++) {
            const diff = timestamps[i] - timestamps[i - 1];
            if (diff > 0) intervals.push(diff);
          }
          if (intervals.length > 0) {
            const avg = intervals.reduce((a, b) => a + b, 0) / intervals.length;
            const fps = Math.round(1 / avg);
            // 取最接近的常见帧率
            resolve(snapToCommonFps(fps));
          } else {
            resolve(30);
          }
        }
      };

      (video as HTMLVideoElement & { requestVideoFrameCallback: (cb: typeof onFrame) => void }).requestVideoFrameCallback(onFrame);
      video.play().catch(() => resolve(30));

      // 超时保护
      setTimeout(() => resolve(30), 3000);
    });
  }

  // Fallback: 默认 30fps
  return 30;
}

/** 将帧率对齐到常见帧率 */
function snapToCommonFps(fps: number): number {
  const common = [24, 25, 30, 48, 50, 60, 120];
  let best = 30;
  let bestDiff = Infinity;
  for (const c of common) {
    const diff = Math.abs(fps - c);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = c;
    }
  }
  return best;
}

/**
 * 导出跟踪后的视频
 *
 * 核心优化：
 * 1. AI 推理降频 + 中间帧视口插值
 * 2. 使用 processFrame 获取**原始视口**（不经过 EMA 平滑）
 * 3. 全局智能视口规划：双向平滑 + 运动自适应 + 前瞻预判
 *
 * @param video - 源视频元素
 * @param trimStart - 裁切起点(秒)
 * @param trimEnd - 裁切终点(秒)
 * @param processFrame - 获取当前帧**原始**视口的函数（不含 EMA 平滑）
 * @param config - 导出配置
 * @param onProgress - 进度回调
 * @returns Blob URL
 */
export async function exportTrackedVideo(
  video: HTMLVideoElement,
  trimStart: number,
  trimEnd: number,
  processFrame: (video: HTMLVideoElement) => Promise<{ viewport: Viewport }>,
  config: ExportConfig = DEFAULT_EXPORT_CONFIG,
  onProgress?: (progress: ExportProgress) => void,
  abortSignal?: AbortSignal,
): Promise<string> {
  const report = (p: ExportProgress) => onProgress?.(p);

  report({
    phase: "preparing",
    progress: 0,
    message: "准备导出...",
  });

  // 创建离屏 Canvas
  const canvas = document.createElement("canvas");
  canvas.width = config.width;
  canvas.height = config.height;
  const ctx = canvas.getContext("2d")!;

  // =========== 编码后端（WebCodecs + mp4-muxer）===========
  const encoder = createEncoder(canvas, config.width, config.height, config.fps, config.videoBitrate);

  // =========== 阶段1：预扫描关键帧视口（AI 推理降频）===========
  report({
    phase: "scanning",
    progress: 0,
    message: "正在预扫描视口...",
  });

  video.pause();
  video.currentTime = trimStart;
  await waitForSeek(video);

  const totalDuration = trimEnd - trimStart;
  const aiInterval = 1 / AI_INFERENCE_FPS; // AI 推理间隔(秒)
  const keyframes: { time: number; viewport: Viewport }[] = [];

  // 仅在 AI 采样点做推理
  let scanTime = trimStart;
  while (scanTime <= trimEnd + aiInterval * 0.5) {
    if (abortSignal?.aborted) throw new Error("导出已取消");

    const t = Math.min(scanTime, trimEnd);
    video.currentTime = t;
    await waitForSeek(video);
    await waitForFrame(video);

    const result = await processFrame(video);
    keyframes.push({ time: t, viewport: result.viewport });

    const elapsed = t - trimStart;
    report({
      phase: "scanning",
      progress: Math.min(0.45, (elapsed / totalDuration) * 0.45),
      message: `预扫描中 ${((elapsed / totalDuration) * 100).toFixed(0)}%`,
      currentTime: elapsed,
      duration: totalDuration,
    });

    scanTime += aiInterval;
    // 让主线程喘息
    if (keyframes.length % 3 === 0) await sleep(0);
  }

  // 确保最后一帧有关键帧
  if (keyframes.length > 0 && keyframes[keyframes.length - 1].time < trimEnd) {
    video.currentTime = trimEnd;
    await waitForSeek(video);
    await waitForFrame(video);
    const result = await processFrame(video);
    keyframes.push({ time: trimEnd, viewport: result.viewport });
  }

  // 对关键帧序列做全局智能视口规划
  // 包含：运动自适应平滑 + 前瞻预判 + 速度/加速度限制
  const smoothedKeyframes = planViewportsGlobally(keyframes);

  // =========== 阶段2：逐帧绘制（用插值视口）===========
  const frameInterval = 1 / config.fps;
  // 用精确帧数控制循环，避免浮点累加漂移导致多编码帧
  const totalFrames = Math.round(totalDuration * config.fps);

  video.currentTime = trimStart;
  await waitForSeek(video);

  report({
    phase: "encoding",
    progress: 0.45,
    message: "正在编码视频...",
    currentTime: 0,
    duration: totalDuration,
  });

  let kfIdx = 0; // 当前关键帧索引

  for (let frameIndex = 0; frameIndex < totalFrames; frameIndex++) {
    if (abortSignal?.aborted) {
      encoder.cancel();
      throw new Error("导出已取消");
    }
    encoder.checkError();

    // 通过帧序号精确计算当前时间点，避免浮点累加误差
    const currentExportTime = trimStart + frameIndex * frameInterval;

    // Seek 到目标帧
    video.currentTime = currentExportTime;
    await waitForSeek(video);
    await waitForFrame(video);

    // 通过关键帧插值获取视口（不再每帧跑AI）
    while (kfIdx < smoothedKeyframes.length - 2 && smoothedKeyframes[kfIdx + 1].time < currentExportTime) {
      kfIdx++;
    }
    let vp: Viewport;
    if (kfIdx >= smoothedKeyframes.length - 1) {
      vp = smoothedKeyframes[smoothedKeyframes.length - 1].viewport;
    } else {
      const kf0 = smoothedKeyframes[kfIdx];
      const kf1 = smoothedKeyframes[kfIdx + 1];
      const segDuration = kf1.time - kf0.time;
      const t = segDuration > 0 ? (currentExportTime - kf0.time) / segDuration : 0;
      vp = lerpViewport(kf0.viewport, kf1.viewport, Math.max(0, Math.min(1, t)));
    }

    // 绘制裁剪画面到 canvas
    const sx = vp.x * video.videoWidth;
    const sy = vp.y * video.videoHeight;
    const sw = vp.width * video.videoWidth;
    const sh = vp.height * video.videoHeight;

    ctx.clearRect(0, 0, config.width, config.height);
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, config.width, config.height);

    // 通过编码后端编码当前帧
    const isKeyFrame = frameIndex % (config.fps * 2) === 0;
    encoder.encodeFrame(canvas, frameIndex, isKeyFrame);

    // 更新进度
    const elapsed = currentExportTime - trimStart;
    const progress = 0.45 + Math.min(0.5, (elapsed / totalDuration) * 0.5);

    report({
      phase: "encoding",
      progress,
      message: `编码中 ${(progress * 100).toFixed(1)}%`,
      currentTime: elapsed,
      duration: totalDuration,
    });

    // 给主线程喘息机会（每3帧一次）
    if (frameIndex % 3 === 0) {
      await sleep(0);
    }
  }

  // 完成编码和封装
  report({
    phase: "finalizing",
    progress: 0.95,
    message: "正在合成视频文件...",
  });

  const url = await encoder.finalize();

  report({
    phase: "done",
    progress: 1,
    message: "导出完成！",
  });

  return url;
}

// =========== 调试视频导出 ===========

/** 调试帧数据（包含 person 信息用于绘制叠加层） */
interface DebugKeyframe {
  time: number;
  viewport: Viewport;
  person: {
    bbox: { x: number; y: number; width: number; height: number };
    keypoints: { x: number; y: number; score?: number }[];
    confidence: number;
    occluded: boolean;
  } | null;
}

/**
 * 在 Canvas 上绘制调试叠加层（视口框 + 人体 bbox + 关键点 + 数据标注）
 */
function drawDebugOverlay(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  vw: number,
  vh: number,
  viewport: Viewport,
  person: DebugKeyframe["person"],
  currentTime: number,
) {
  // 绿色视口框
  ctx.strokeStyle = "#00ff88";
  ctx.lineWidth = 3;
  ctx.strokeRect(
    viewport.x * w,
    viewport.y * h,
    viewport.width * w,
    viewport.height * h,
  );

  // 视口尺寸标注
  ctx.fillStyle = "rgba(0,255,136,0.8)";
  ctx.font = `bold ${Math.round(h * 0.022)}px monospace`;
  ctx.fillText(
    `VP: ${viewport.width.toFixed(3)} × ${viewport.height.toFixed(3)}`,
    viewport.x * w + 4,
    viewport.y * h - 6,
  );

  if (person) {
    const { bbox } = person;

    // 人体 bbox
    ctx.strokeStyle = person.occluded ? "#ff4444" : "#ffaa00";
    ctx.lineWidth = 2;
    if (person.occluded) {
      ctx.setLineDash([6, 6]);
    }
    ctx.strokeRect(
      bbox.x * w,
      bbox.y * h,
      bbox.width * w,
      bbox.height * h,
    );
    ctx.setLineDash([]);

    // 关键点
    ctx.fillStyle = person.occluded ? "#ff6666" : "#00ffcc";
    for (const kp of person.keypoints) {
      if ((kp.score ?? 0) > 0.3) {
        ctx.beginPath();
        ctx.arc(
          (kp.x / vw) * w,
          (kp.y / vh) * h,
          Math.max(3, w * 0.004),
          0,
          Math.PI * 2,
        );
        ctx.fill();
      }
    }

    // 人体面积和置信度标注
    const area = (bbox.width * bbox.height * 100).toFixed(1);
    const conf = (person.confidence * 100).toFixed(0);
    ctx.fillStyle = person.occluded ? "#ff6666" : "#ffaa00";
    ctx.font = `bold ${Math.round(h * 0.02)}px monospace`;
    ctx.fillText(
      `面积:${area}% 置信:${conf}%${person.occluded ? " [遮挡]" : ""}`,
      bbox.x * w + 4,
      (bbox.y + bbox.height) * h + Math.round(h * 0.025),
    );
  }

  // 底部状态栏（半透明黑色背景）
  const barH = Math.round(h * 0.04);
  ctx.fillStyle = "rgba(0,0,0,0.6)";
  ctx.fillRect(0, h - barH, w, barH);
  ctx.fillStyle = "#ffffff";
  ctx.font = `${Math.round(barH * 0.6)}px monospace`;

  const timeStr = formatTimeForDebug(currentTime);
  ctx.fillText(`${timeStr}`, 8, h - barH * 0.3);

  if (!person) {
    ctx.fillStyle = "#ff4444";
    ctx.fillText("未检测到人体", w * 0.4, h - barH * 0.3);
  }
}

function formatTimeForDebug(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 100);
  return `${m}:${s.toString().padStart(2, "0")}.${ms.toString().padStart(2, "0")}`;
}

/**
 * 导出调试对比视频
 *
 * 竖屏输入：左右并排（OUTPUT | DEBUG），两侧等高
 * 横屏输入：上下排列（OUTPUT 在上，DEBUG 在下），两部分等宽
 *
 * 中间有分割线
 */
export async function exportDebugVideo(
  video: HTMLVideoElement,
  trimStart: number,
  trimEnd: number,
  processFrame: (video: HTMLVideoElement) => Promise<{
    viewport: Viewport;
    person: {
      bbox: { x: number; y: number; width: number; height: number };
      keypoints: { x: number; y: number; score?: number }[];
      confidence: number;
      occluded: boolean;
    } | null;
  }>,
  config: ExportConfig = DEFAULT_EXPORT_CONFIG,
  onProgress?: (progress: ExportProgress) => void,
  abortSignal?: AbortSignal,
): Promise<string> {
  const report = (p: ExportProgress) => onProgress?.(p);

  report({
    phase: "preparing",
    progress: 0,
    message: "准备导出调试视频...",
  });

  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const sourceAr = vw / vh;
  const outputAr = config.width / config.height;

  // 横屏判定：源视频宽高比 >= 1 视为横屏
  const isLandscape = sourceAr >= 1;

  const gap = 4; // 分割线宽度

  // AVC Level 5.1 最大编码面积为 9,437,184 像素
  // 留一些余量，使用 9,000,000 作为安全上限
  const MAX_CODED_AREA = 9_000_000;

  // 布局变量（根据横竖屏分别计算）
  let topH: number, topW: number;     // 上侧（横屏）或左侧（竖屏）面板
  let bottomH: number, bottomW: number; // 下侧（横屏）或右侧（竖屏）面板
  let finalW: number, finalH: number;

  if (isLandscape) {
    // ===== 横屏：上下排列（OUTPUT 在上，DEBUG 在下）=====
    // 两部分等宽 = config.width
    topW = config.width;
    topH = config.height; // 输出画面保持原始宽高比
    bottomW = config.width;
    bottomH = Math.round(bottomW / sourceAr); // 全景按源视频宽高比

    let totalH = topH + gap + bottomH;
    const totalArea = topW * totalH;

    if (totalArea > MAX_CODED_AREA) {
      const scale = Math.sqrt(MAX_CODED_AREA / totalArea);
      topW = Math.floor(topW * scale);
      topW = topW % 2 === 0 ? topW : topW - 1;
      topH = Math.round(topW / outputAr);
      bottomW = topW;
      bottomH = Math.round(bottomW / sourceAr);
      totalH = topH + gap + bottomH;
      console.log(
        `[DebugExport] 横屏分辨率超限，缩放至 ${topW}×${totalH} (面积=${topW * totalH}, 上限=${MAX_CODED_AREA})`,
      );
    }

    finalW = topW;
    finalH = topH + gap + bottomH;
  } else {
    // ===== 竖屏：左右并排（OUTPUT | DEBUG）=====
    // 两部分等高 = config.height
    topH = config.height;   // 复用 topH/topW 表示左侧
    topW = config.width;
    bottomH = topH;         // 复用 bottomH/bottomW 表示右侧
    bottomW = Math.round(topH * sourceAr);

    let totalW = topW + gap + bottomW;
    const totalArea = totalW * topH;

    if (totalArea > MAX_CODED_AREA) {
      const scale = Math.sqrt(MAX_CODED_AREA / totalArea);
      topH = Math.floor(topH * scale);
      topH = topH % 2 === 0 ? topH : topH - 1;
      topW = Math.round(topH * outputAr);
      bottomH = topH;
      bottomW = Math.round(topH * sourceAr);
      totalW = topW + gap + bottomW;
      console.log(
        `[DebugExport] 竖屏分辨率超限，缩放至 ${totalW}×${topH} (面积=${totalW * topH}, 上限=${MAX_CODED_AREA})`,
      );
    }

    finalW = topW + gap + bottomW;
    finalH = topH;
  }

  // 确保宽高都是偶数（视频编码器要求）
  finalW = finalW % 2 === 0 ? finalW : finalW + 1;
  finalH = finalH % 2 === 0 ? finalH : finalH + 1;

  // 创建离屏 Canvas
  const canvas = document.createElement("canvas");
  canvas.width = finalW;
  canvas.height = finalH;
  const ctx = canvas.getContext("2d")!;

  // 初始化编码后端（WebCodecs + mp4-muxer）
  const areaRatio = (finalW * finalH) / (config.width * config.height);
  const adjustedBitrate = Math.round(config.videoBitrate * areaRatio * 1.2);
  const encoder = createEncoder(canvas, finalW, finalH, config.fps, adjustedBitrate);

  // =========== 阶段1：预扫描关键帧 ===========
  report({
    phase: "scanning",
    progress: 0,
    message: "预扫描视口和人体数据...",
  });

  video.pause();
  video.currentTime = trimStart;
  await waitForSeek(video);

  const totalDuration = trimEnd - trimStart;
  const aiInterval = 1 / AI_INFERENCE_FPS;
  const debugKeyframes: DebugKeyframe[] = [];

  let scanTime = trimStart;
  while (scanTime <= trimEnd + aiInterval * 0.5) {
    if (abortSignal?.aborted) throw new Error("导出已取消");

    const t = Math.min(scanTime, trimEnd);
    video.currentTime = t;
    await waitForSeek(video);
    await waitForFrame(video);

    const result = await processFrame(video);
    debugKeyframes.push({
      time: t,
      viewport: result.viewport,
      person: result.person,
    });

    const elapsed = t - trimStart;
    report({
      phase: "scanning",
      progress: Math.min(0.45, (elapsed / totalDuration) * 0.45),
      message: `预扫描中 ${((elapsed / totalDuration) * 100).toFixed(0)}%`,
      currentTime: elapsed,
      duration: totalDuration,
    });

    scanTime += aiInterval;
    if (debugKeyframes.length % 3 === 0) await sleep(0);
  }

  // 确保最后一帧
  if (debugKeyframes.length > 0 && debugKeyframes[debugKeyframes.length - 1].time < trimEnd) {
    video.currentTime = trimEnd;
    await waitForSeek(video);
    await waitForFrame(video);
    const result = await processFrame(video);
    debugKeyframes.push({ time: trimEnd, viewport: result.viewport, person: result.person });
  }

  // 对视口做全局智能规划
  const viewportOnly = debugKeyframes.map((kf) => ({ time: kf.time, viewport: kf.viewport }));
  const smoothedViewports = planViewportsGlobally(viewportOnly);

  // 将平滑后的视口合并回 debugKeyframes
  for (let i = 0; i < debugKeyframes.length; i++) {
    if (i < smoothedViewports.length) {
      debugKeyframes[i].viewport = smoothedViewports[i].viewport;
    }
  }

  // =========== 阶段2：逐帧绘制 ===========
  const frameInterval = 1 / config.fps;
  // 用精确帧数控制循环，避免浮点累加漂移导致多编码帧
  const totalFrames = Math.round(totalDuration * config.fps);

  video.currentTime = trimStart;
  await waitForSeek(video);

  report({
    phase: "encoding",
    progress: 0.45,
    message: "正在编码调试视频...",
    currentTime: 0,
    duration: totalDuration,
  });

  let kfIdx = 0;

  for (let frameIndex = 0; frameIndex < totalFrames; frameIndex++) {
    if (abortSignal?.aborted) {
      encoder.cancel();
      throw new Error("导出已取消");
    }
    encoder.checkError();

    // 通过帧序号精确计算当前时间点，避免浮点累加误差
    const currentExportTime = trimStart + frameIndex * frameInterval;

    video.currentTime = currentExportTime;
    await waitForSeek(video);
    await waitForFrame(video);

    // 查找最近的关键帧并插值
    while (kfIdx < debugKeyframes.length - 2 && debugKeyframes[kfIdx + 1].time < currentExportTime) {
      kfIdx++;
    }

    let vp: Viewport;
    let person: DebugKeyframe["person"];

    if (kfIdx >= debugKeyframes.length - 1) {
      vp = debugKeyframes[debugKeyframes.length - 1].viewport;
      person = debugKeyframes[debugKeyframes.length - 1].person;
    } else {
      const kf0 = debugKeyframes[kfIdx];
      const kf1 = debugKeyframes[kfIdx + 1];
      const segDuration = kf1.time - kf0.time;
      const t = segDuration > 0 ? (currentExportTime - kf0.time) / segDuration : 0;
      const clampedT = Math.max(0, Math.min(1, t));
      vp = lerpViewport(kf0.viewport, kf1.viewport, clampedT);
      // person 取最近的关键帧
      person = clampedT < 0.5 ? kf0.person : kf1.person;
    }

    // 清空画布（黑色背景）
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, finalW, finalH);

    const sx = vp.x * vw;
    const sy = vp.y * vh;
    const sw = vp.width * vw;
    const sh = vp.height * vh;

    if (isLandscape) {
      // ===== 横屏：上下排列 =====
      // ---- 上方：裁剪后的输出画面 ----
      ctx.drawImage(video, sx, sy, sw, sh, 0, 0, topW, topH);

      // "OUTPUT" 标签
      ctx.fillStyle = "rgba(0,0,0,0.5)";
      ctx.fillRect(0, 0, Math.round(topW * 0.12), Math.round(topH * 0.05));
      ctx.fillStyle = "#00ff88";
      ctx.font = `bold ${Math.round(topH * 0.03)}px monospace`;
      ctx.fillText("OUTPUT", 6, Math.round(topH * 0.035));

      // ---- 中间分割线 ----
      ctx.fillStyle = "#333333";
      ctx.fillRect(0, topH, finalW, gap);

      // ---- 下方：全景调试视图 ----
      const debugY = topH + gap;
      ctx.drawImage(video, 0, 0, vw, vh, 0, debugY, bottomW, bottomH);

      // 在下方画布区域绘制调试叠加层
      ctx.save();
      ctx.translate(0, debugY);
      drawDebugOverlay(ctx, bottomW, bottomH, vw, vh, vp, person, currentExportTime);
      ctx.restore();

      // "DEBUG" 标签
      ctx.fillStyle = "rgba(0,0,0,0.5)";
      ctx.fillRect(0, debugY, Math.round(bottomW * 0.1), Math.round(bottomH * 0.06));
      ctx.fillStyle = "#ff6600";
      ctx.font = `bold ${Math.round(bottomH * 0.035)}px monospace`;
      ctx.fillText("DEBUG", 6, debugY + Math.round(bottomH * 0.04));
    } else {
      // ===== 竖屏：左右并排 =====
      // ---- 左侧：裁剪后的输出画面 ----
      ctx.drawImage(video, sx, sy, sw, sh, 0, 0, topW, topH);

      // "OUTPUT" 标签
      ctx.fillStyle = "rgba(0,0,0,0.5)";
      ctx.fillRect(0, 0, Math.round(topW * 0.18), Math.round(topH * 0.035));
      ctx.fillStyle = "#00ff88";
      ctx.font = `bold ${Math.round(topH * 0.022)}px monospace`;
      ctx.fillText("OUTPUT", 6, Math.round(topH * 0.025));

      // ---- 中间分割线 ----
      ctx.fillStyle = "#333333";
      ctx.fillRect(topW, 0, gap, finalH);

      // ---- 右侧：全景调试视图 ----
      const rightX = topW + gap;
      ctx.drawImage(video, 0, 0, vw, vh, rightX, 0, bottomW, bottomH);

      // 在右侧画布区域绘制调试叠加层
      ctx.save();
      ctx.translate(rightX, 0);
      drawDebugOverlay(ctx, bottomW, bottomH, vw, vh, vp, person, currentExportTime);
      ctx.restore();

      // "DEBUG" 标签
      ctx.fillStyle = "rgba(0,0,0,0.5)";
      ctx.fillRect(rightX, 0, Math.round(bottomW * 0.15), Math.round(bottomH * 0.035));
      ctx.fillStyle = "#ff6600";
      ctx.font = `bold ${Math.round(bottomH * 0.022)}px monospace`;
      ctx.fillText("DEBUG", rightX + 6, Math.round(bottomH * 0.025));
    }

    // 通过编码后端编码当前帧
    const isKeyFrame = frameIndex % (config.fps * 2) === 0;
    encoder.encodeFrame(canvas, frameIndex, isKeyFrame);

    const elapsed = currentExportTime - trimStart;
    const progress = 0.45 + Math.min(0.5, (elapsed / totalDuration) * 0.5);

    report({
      phase: "encoding",
      progress,
      message: `编码调试视频 ${(progress * 100).toFixed(1)}%`,
      currentTime: elapsed,
      duration: totalDuration,
    });

    if (frameIndex % 3 === 0) await sleep(0);
  }

  // 完成
  report({
    phase: "finalizing",
    progress: 0.95,
    message: "正在合成调试视频文件...",
  });

  const url = await encoder.finalize();

  report({
    phase: "done",
    progress: 1,
    message: "调试视频导出完成！",
  });

  return url;
}

function waitForSeek(video: HTMLVideoElement): Promise<void> {
  return new Promise((resolve) => {
    if (!video.seeking) {
      resolve();
      return;
    }
    const onSeeked = () => {
      video.removeEventListener("seeked", onSeeked);
      resolve();
    };
    video.addEventListener("seeked", onSeeked);
  });
}

function waitForFrame(video: HTMLVideoElement): Promise<void> {
  return new Promise((resolve) => {
    if (video.readyState >= 2) {
      resolve();
      return;
    }
    const onCanPlay = () => {
      video.removeEventListener("canplay", onCanPlay);
      resolve();
    };
    video.addEventListener("canplay", onCanPlay);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
