"use client";

import React, { useState, useCallback, useRef } from "react";
import { useTracker } from "@/hooks/useTracker";
import VideoTracker from "@/components/VideoTracker";
import VideoUploader from "@/components/VideoUploader";
import ControlPanel from "@/components/ControlPanel";
import Timeline from "@/components/Timeline";
import ExportPanel from "@/components/ExportPanel";
import type { TrackerConfig } from "@/lib/tracker-types";
import type { ExportConfig, ExportProgress, VideoMeta } from "@/lib/video-exporter";
import type { ClimbPhase, ScanFrame } from "@/lib/climb-detector";

const DEFAULT_DISPLAY_CONFIG: Partial<TrackerConfig> = {
  targetVerticalRatio: 0.6,
  smoothingFactor: 0.04,
  confidenceThreshold: 0.25,
  verticalCenterBias: 0.55,
  areaJumpThreshold: 2.5,
};

export default function ClimbingApp() {
  const [videoSrc, setVideoSrc] = useState<string | null>(null);
  const [fileName, setFileName] = useState("");
  const [showDebug, setShowDebug] = useState(false);
  const [config, setConfig] = useState(DEFAULT_DISPLAY_CONFIG);
  const videoElementRef = useRef<HTMLVideoElement | null>(null);
  const debugCanvasRef = useRef<HTMLCanvasElement>(null);

  // 时间轴状态
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [trimStart, setTrimStart] = useState(0);
  const [trimEnd, setTrimEnd] = useState(0);

  // 导出状态
  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState<ExportProgress | null>(null);
  const [exportUrl, setExportUrl] = useState<string | null>(null);
  const [showExportPanel, setShowExportPanel] = useState(false);
  const exportAbortRef = useRef<AbortController | null>(null);

  // 源视频元数据
  const [videoMeta, setVideoMeta] = useState<VideoMeta | null>(null);

  // 上墙检测状态
  const [isScanning, setIsScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState(0);
  const [climbPhase, setClimbPhase] = useState<ClimbPhase | null>(null);

  const tracker = useTracker(config);

  // 初始化模型（页面加载自动触发）
  const [initStarted, setInitStarted] = useState(false);
  if (!initStarted) {
    setInitStarted(true);
    tracker.initEngine();
  }

  // 时间更新监听
  const timeUpdateRef = useRef<(() => void) | null>(null);

  const setupTimeUpdate = useCallback((video: HTMLVideoElement) => {
    // 清除旧的监听器
    if (timeUpdateRef.current && videoElementRef.current) {
      videoElementRef.current.removeEventListener("timeupdate", timeUpdateRef.current);
    }

    const handler = () => {
      setCurrentTime(video.currentTime);
    };
    timeUpdateRef.current = handler;
    video.addEventListener("timeupdate", handler);
  }, []);

  // 处理视频选择
  const handleVideoSelected = useCallback(
    (url: string, name: string) => {
      if (videoSrc) URL.revokeObjectURL(videoSrc);
      if (exportUrl) {
        URL.revokeObjectURL(exportUrl);
        setExportUrl(null);
      }
      tracker.stopTracking();
      tracker.resetTracking();
      setVideoSrc(url);
      setFileName(name);
      setDuration(0);
      setCurrentTime(0);
      setTrimStart(0);
      setTrimEnd(0);
      setClimbPhase(null);
      setShowExportPanel(false);
      setVideoMeta(null);
    },
    [videoSrc, exportUrl, tracker]
  );

  // 视频加载就绪
  const handleVideoReady = useCallback(
    (video: HTMLVideoElement) => {
      videoElementRef.current = video;
      const dur = video.duration || 0;
      setDuration(dur);
      setTrimEnd(dur);
      setupTimeUpdate(video);

      // 获取源视频元数据（包括估算帧率）
      const meta: VideoMeta = {
        width: video.videoWidth,
        height: video.videoHeight,
        fps: 30, // 先设默认值
        duration: dur,
      };
      setVideoMeta(meta);

      // 异步估算帧率
      import("@/lib/video-exporter").then(({ estimateVideoFps }) => {
        estimateVideoFps(video).then((fps) => {
          setVideoMeta((prev) => prev ? { ...prev, fps } : null);
        });
      });

      // 自动开始播放+跟踪
      if (tracker.isReady) {
        video.play().then(() => {
          tracker.startTracking(video);
        });
      }
    },
    [tracker, setupTimeUpdate]
  );

  // 手动开始
  const handlePlay = useCallback(() => {
    const video = videoElementRef.current;
    if (!video || !tracker.isReady) return;
    video.play().then(() => {
      tracker.startTracking(video);
    });
  }, [tracker]);

  // 手动暂停
  const handlePause = useCallback(() => {
    const video = videoElementRef.current;
    if (video) video.pause();
    tracker.stopTracking();
  }, [tracker]);

  // 重置
  const handleReset = useCallback(() => {
    const video = videoElementRef.current;
    if (video) {
      video.pause();
      video.currentTime = 0;
    }
    tracker.stopTracking();
    tracker.resetTracking();
    setCurrentTime(0);
  }, [tracker]);

  // 配置更新
  const handleConfigChange = useCallback(
    (partial: Partial<TrackerConfig>) => {
      setConfig((prev) => ({ ...prev, ...partial }));
      tracker.updateConfig(partial);
    },
    [tracker]
  );

  // 视频结束
  const handleVideoEnd = useCallback(() => {
    tracker.stopTracking();
  }, [tracker]);

  // 时间轴 Seek
  const handleSeek = useCallback(
    (time: number) => {
      const video = videoElementRef.current;
      if (!video) return;
      video.currentTime = time;
      setCurrentTime(time);
    },
    []
  );

  // 裁切区间变化
  const handleTrimChange = useCallback((start: number, end: number) => {
    setTrimStart(start);
    setTrimEnd(end);
  }, []);

  // ========== 上墙/下墙检测 ==========
  const handleDetectClimb = useCallback(async () => {
    const video = videoElementRef.current;
    if (!video || !tracker.isReady || isScanning) return;

    // 暂停当前跟踪
    tracker.stopTracking();
    video.pause();

    setIsScanning(true);
    setScanProgress(0);

    try {
      // 低帧率扫描整个视频
      const scanFps = 3; // 每秒采样 3 帧
      const totalFrames = Math.ceil(video.duration * scanFps);
      const frames: ScanFrame[] = [];

      // 重置引擎状态以获得干净的检测
      tracker.resetTracking();

      for (let i = 0; i < totalFrames; i++) {
        const time = i / scanFps;
        video.currentTime = time;
        await waitForSeek(video);
        await waitForFrame(video);

        try {
          const result = await tracker.processFrameOnce(video);
          const person = result.person;

          frames.push({
            time,
            personY: person
              ? person.bbox.y + person.bbox.height / 2
              : null,
            personH: person ? person.bbox.height : null,
            hasDetection: !!person && !person.occluded,
          });
        } catch {
          frames.push({
            time,
            personY: null,
            personH: null,
            hasDetection: false,
          });
        }

        setScanProgress((i + 1) / totalFrames);
      }

      // 分析检测结果
      const { detectClimbPhases } = await import("@/lib/climb-detector");
      const phase = detectClimbPhases(frames, video.duration);
      setClimbPhase(phase);

      // 自动设置裁切区间
      setTrimStart(phase.wallOnTime);
      setTrimEnd(phase.wallOffTime);

      // 重置并 seek 到上墙时间
      tracker.resetTracking();
      video.currentTime = phase.wallOnTime;
      setCurrentTime(phase.wallOnTime);
    } catch (error) {
      console.error("上墙检测失败:", error);
    } finally {
      setIsScanning(false);
      setScanProgress(0);
    }
  }, [tracker, isScanning]);

  // ========== 视频导出 ==========
  const handleExport = useCallback(
    async (exportConfig: ExportConfig) => {
      const video = videoElementRef.current;
      if (!video || !tracker.isReady) return;

      // 暂停当前跟踪
      tracker.stopTracking();
      video.pause();

      setIsExporting(true);
      setExportUrl(null);
      exportAbortRef.current = new AbortController();

      // 重置引擎状态
      tracker.resetTracking();

      try {
        const { exportTrackedVideo } = await import("@/lib/video-exporter");
        const url = await exportTrackedVideo(
          video,
          trimStart,
          trimEnd,
          async (v) => {
            // 使用 processFrameRaw：只做人体检测 + 原始视口计算，不做 EMA 平滑
            // 全局智能规划由 video-exporter 内部的 planViewportsGlobally 完成
            const result = await tracker.processFrameRaw(v);
            return { viewport: result.viewport };
          },
          exportConfig,
          setExportProgress,
          exportAbortRef.current.signal
        );

        setExportUrl(url);
      } catch (error) {
        if ((error as Error).message !== "导出已取消") {
          console.error("导出失败:", error);
          setExportProgress({
            phase: "error",
            progress: 0,
            message: `导出失败: ${(error as Error).message}`,
          });
        }
      } finally {
        setIsExporting(false);
        tracker.resetTracking();
        // 恢复到裁切起点
        video.currentTime = trimStart;
        setCurrentTime(trimStart);
      }
    },
    [tracker, trimStart, trimEnd]
  );

  // ========== 调试视频导出 ==========
  const handleExportDebug = useCallback(
    async (exportConfig: ExportConfig) => {
      const video = videoElementRef.current;
      if (!video || !tracker.isReady) return;

      tracker.stopTracking();
      video.pause();

      setIsExporting(true);
      setExportUrl(null);
      exportAbortRef.current = new AbortController();

      tracker.resetTracking();

      try {
        const { exportDebugVideo } = await import("@/lib/video-exporter");
        const url = await exportDebugVideo(
          video,
          trimStart,
          trimEnd,
          async (v) => {
            const result = await tracker.processFrameRaw(v);
            return { viewport: result.viewport, person: result.person };
          },
          exportConfig,
          setExportProgress,
          exportAbortRef.current.signal
        );

        setExportUrl(url);
      } catch (error) {
        if ((error as Error).message !== "导出已取消") {
          console.error("调试视频导出失败:", error);
          setExportProgress({
            phase: "error",
            progress: 0,
            message: `导出失败: ${(error as Error).message}`,
          });
        }
      } finally {
        setIsExporting(false);
        tracker.resetTracking();
        video.currentTime = trimStart;
        setCurrentTime(trimStart);
      }
    },
    [tracker, trimStart, trimEnd]
  );

  const handleCancelExport = useCallback(() => {
    exportAbortRef.current?.abort();
    setIsExporting(false);
    setExportProgress(null);
    if (!exportUrl) {
      setShowExportPanel(false);
    }
  }, [exportUrl]);

  const handleCloseExport = useCallback(() => {
    if (exportUrl) {
      URL.revokeObjectURL(exportUrl);
      setExportUrl(null);
    }
    setExportProgress(null);
    setShowExportPanel(false);
  }, [exportUrl]);

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white">
      {/* 背景装饰 */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden">
        <div className="absolute -top-1/4 -right-1/4 w-1/2 h-1/2 bg-emerald-600/5 rounded-full blur-[128px]" />
        <div className="absolute -bottom-1/4 -left-1/4 w-1/2 h-1/2 bg-cyan-600/5 rounded-full blur-[128px]" />
      </div>

      <div className="relative z-10 px-4 py-8 max-w-7xl mx-auto">
        {/* 头部 */}
        <header className="text-center mb-10">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 bg-emerald-500/10 border border-emerald-500/20 rounded-full text-emerald-400 text-xs font-medium mb-4">
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
            </svg>
            AI 驱动 · 纯前端
          </div>
          <h1 className="text-4xl font-bold tracking-tight mb-3">
            <span className="bg-gradient-to-r from-emerald-300 via-cyan-300 to-emerald-300 bg-clip-text text-transparent">
              攀岩视频智能跟踪
            </span>
          </h1>
          <p className="text-white/40 max-w-lg mx-auto leading-relaxed">
            上传攀岩视频，AI 自动跟踪攀岩者，智能裁剪画面让人体居中。
            <br />
            支持 Dyno 自动放大视角、上墙/下墙检测、时间轴裁切和视频导出。
          </p>
        </header>

        {/* 视频上传 */}
        <div className="max-w-lg mx-auto mb-10">
          <VideoUploader
            onVideoSelected={handleVideoSelected}
            hasVideo={!!videoSrc}
            fileName={fileName}
          />
        </div>

        {/* 主内容区 */}
        {videoSrc && (
          <div className="space-y-6">
            {/* 视频 + 控制面板 */}
            <div className="flex flex-col lg:flex-row items-start justify-center gap-8">
              {/* 视频跟踪画面 */}
              <div className="flex-shrink-0">
                <VideoTracker
                  viewport={tracker.viewport}
                  person={tracker.person}
                  isProcessing={tracker.isProcessing}
                  onVideoReady={handleVideoReady}
                  onVideoEnd={handleVideoEnd}
                  videoSrc={videoSrc}
                  showDebug={showDebug}
                  debugCanvasRef={debugCanvasRef}
                />
              </div>

              {/* 右侧面板 */}
              <div className="w-full lg:w-auto lg:min-w-[380px] space-y-4">
                {/* 控制面板 */}
                <ControlPanel
                  isReady={tracker.isReady}
                  isProcessing={tracker.isProcessing}
                  statusMessage={tracker.statusMessage}
                  hasVideo={!!videoSrc}
                  showDebug={showDebug}
                  config={config}
                  onToggleDebug={() => setShowDebug(!showDebug)}
                  onPlay={handlePlay}
                  onPause={handlePause}
                  onReset={handleReset}
                  onConfigChange={handleConfigChange}
                />

                {/* 上墙检测 + 导出按钮 */}
                <div className="grid grid-cols-2 gap-3">
                  {/* 上墙检测按钮 */}
                  <button
                    onClick={handleDetectClimb}
                    disabled={!tracker.isReady || isScanning || isExporting}
                    className="relative px-4 py-3 bg-amber-500/20 hover:bg-amber-500/30 disabled:bg-white/5 disabled:text-white/20 text-amber-300 rounded-xl font-medium text-sm transition-all duration-200 border border-amber-500/20 disabled:border-white/5 overflow-hidden"
                  >
                    {isScanning && (
                      <div
                        className="absolute inset-y-0 left-0 bg-amber-500/20 transition-all duration-200"
                        style={{ width: `${scanProgress * 100}%` }}
                      />
                    )}
                    <span className="relative z-10 flex items-center justify-center gap-2">
                      {isScanning ? (
                        <>
                          <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                          </svg>
                          扫描中 {(scanProgress * 100).toFixed(0)}%
                        </>
                      ) : (
                        <>🧗 检测上/下墙</>
                      )}
                    </span>
                  </button>

                  {/* 导出按钮 */}
                  <button
                    onClick={() => setShowExportPanel(!showExportPanel)}
                    disabled={!tracker.isReady || isScanning || isExporting}
                    className="px-4 py-3 bg-gradient-to-r from-emerald-500/20 to-cyan-500/20 hover:from-emerald-500/30 hover:to-cyan-500/30 disabled:bg-white/5 disabled:text-white/20 disabled:from-white/5 disabled:to-white/5 text-emerald-300 rounded-xl font-medium text-sm transition-all duration-200 border border-emerald-500/20 disabled:border-white/5"
                  >
                    <span className="flex items-center justify-center gap-2">
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3" />
                      </svg>
                      导出视频
                    </span>
                  </button>
                </div>

                {/* 上墙检测结果 */}
                {climbPhase && (
                  <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl p-4 space-y-2">
                    <div className="flex items-center gap-2 text-sm text-amber-300 font-medium">
                      <span>🧗 上墙/下墙检测结果</span>
                      <span className="text-xs text-amber-300/50">
                        (置信度: {(climbPhase.confidence * 100).toFixed(0)}%)
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-3 text-sm">
                      <div className="bg-black/20 rounded-lg p-2">
                        <div className="text-white/40 text-xs">上墙时间</div>
                        <div className="text-amber-200 font-mono">
                          {formatTimeFull(climbPhase.wallOnTime)}
                        </div>
                      </div>
                      <div className="bg-black/20 rounded-lg p-2">
                        <div className="text-white/40 text-xs">下墙时间</div>
                        <div className="text-amber-200 font-mono">
                          {formatTimeFull(climbPhase.wallOffTime)}
                        </div>
                      </div>
                    </div>
                    <div className="text-xs text-white/30">
                      已自动设置裁切区间，可在时间轴上手动微调
                    </div>
                  </div>
                )}

                {/* 导出面板 */}
                {showExportPanel && (
                  <ExportPanel
                    isExporting={isExporting}
                    exportProgress={exportProgress}
                    trimStart={trimStart}
                    trimEnd={trimEnd}
                    duration={duration}
                    onExport={handleExport}
                    onExportDebug={handleExportDebug}
                    onCancel={exportUrl ? handleCloseExport : handleCancelExport}
                    exportUrl={exportUrl}
                    fileName={fileName}
                    videoMeta={videoMeta}
                    currentViewport={tracker.viewport}
                  />
                )}
              </div>
            </div>

            {/* 调试面板 - 独立行显示在视频+控制面板下方 */}
            {showDebug && (
              <div className="max-w-5xl mx-auto w-full bg-white/[0.03] border border-white/10 rounded-xl p-4 space-y-3">
                <div className="text-sm text-white/60 font-medium">🔍 调试视图</div>
                <div className="flex flex-col sm:flex-row items-start gap-4">
                  <canvas
                    ref={debugCanvasRef}
                    className="rounded-lg border border-white/10 bg-black/30 flex-shrink-0"
                  />
                  {tracker.viewport && (
                    <div className="text-xs text-white/40 font-mono space-y-1.5 min-w-[180px]">
                      <div className="text-white/50 font-sans text-sm font-medium mb-2">跟踪数据</div>
                      <div className="flex justify-between gap-4">
                        <span className="text-white/30">视口位置</span>
                        <span>({tracker.viewport.x.toFixed(3)}, {tracker.viewport.y.toFixed(3)})</span>
                      </div>
                      <div className="flex justify-between gap-4">
                        <span className="text-white/30">视口尺寸</span>
                        <span>{tracker.viewport.width.toFixed(3)} × {tracker.viewport.height.toFixed(3)}</span>
                      </div>
                      {tracker.person && (
                        <>
                          <div className="border-t border-white/5 pt-1.5 mt-1.5" />
                          <div className="flex justify-between gap-4">
                            <span className="text-white/30">人体位置</span>
                            <span>({tracker.person.bbox.x.toFixed(3)}, {tracker.person.bbox.y.toFixed(3)})</span>
                          </div>
                          <div className="flex justify-between gap-4">
                            <span className="text-white/30">人体面积</span>
                            <span>{(tracker.person.bbox.width * tracker.person.bbox.height * 100).toFixed(1)}%</span>
                          </div>
                          <div className="flex justify-between gap-4">
                            <span className="text-white/30">置信度</span>
                            <span className={tracker.person.occluded ? "text-yellow-400" : "text-emerald-400"}>
                              {(tracker.person.confidence * 100).toFixed(0)}%{tracker.person.occluded ? " [遮挡]" : ""}
                            </span>
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* 时间轴 */}
            {duration > 0 && (
              <div className="max-w-5xl mx-auto">
                <Timeline
                  duration={duration}
                  currentTime={currentTime}
                  trimStart={trimStart}
                  trimEnd={trimEnd}
                  isProcessing={tracker.isProcessing}
                  onSeek={handleSeek}
                  onTrimChange={handleTrimChange}
                />
              </div>
            )}
          </div>
        )}

        {/* 使用说明 */}
        {!videoSrc && (
          <div className="max-w-3xl mx-auto mt-12 grid grid-cols-1 sm:grid-cols-4 gap-4">
            {[
              {
                icon: "🧗",
                title: "上传视频",
                desc: "选择或拖拽攀岩视频文件",
              },
              {
                icon: "🤖",
                title: "AI 检测",
                desc: "MoveNet 实时检测人体姿态",
              },
              {
                icon: "✂️",
                title: "智能裁切",
                desc: "自动检测上墙/下墙，裁切冗余片段",
              },
              {
                icon: "📤",
                title: "导出分享",
                desc: "导出跟踪后的视频，保持原始比例",
              },
            ].map((item) => (
              <div
                key={item.title}
                className="text-center p-6 bg-white/[0.02] border border-white/5 rounded-2xl"
              >
                <div className="text-3xl mb-3">{item.icon}</div>
                <h3 className="font-medium text-white/80 mb-1">{item.title}</h3>
                <p className="text-sm text-white/35">{item.desc}</p>
              </div>
            ))}
          </div>
        )}

        {/* 底部 */}
        <footer className="text-center mt-16 text-xs text-white/20">
          所有处理均在浏览器本地完成，视频不会上传到任何服务器
        </footer>
      </div>
    </div>
  );
}

function formatTimeFull(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 100);
  return `${m}:${s.toString().padStart(2, "0")}.${ms.toString().padStart(2, "0")}`;
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
