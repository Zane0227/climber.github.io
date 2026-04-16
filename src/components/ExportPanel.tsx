"use client";

import React, { useState, useEffect } from "react";
import {
  buildSmartPresets,
  computeEffectiveResolution,
  computeExportDimensions,
  type ExportConfig,
  type ExportPreset,
  type ExportProgress,
  type VideoMeta,
  DEFAULT_EXPORT_CONFIG,
} from "@/lib/video-exporter";

interface ExportPanelProps {
  isExporting: boolean;
  exportProgress: ExportProgress | null;
  trimStart: number;
  trimEnd: number;
  duration: number;
  onExport: (config: ExportConfig) => void;
  onExportDebug: (config: ExportConfig) => void;
  onCancel: () => void;
  exportUrl: string | null;
  fileName: string;
  /** 源视频元数据 */
  videoMeta?: VideoMeta | null;
  /** 当前跟踪引擎的 viewport（归一化 0~1），用于估算有效分辨率 */
  currentViewport?: { x: number; y: number; width: number; height: number } | null;
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function ExportPanel({
  isExporting,
  exportProgress,
  trimStart,
  trimEnd,
  duration,
  onExport,
  onExportDebug,
  onCancel,
  exportUrl,
  fileName,
  videoMeta,
  currentViewport,
}: ExportPanelProps) {
  const [selectedPresetIdx, setSelectedPresetIdx] = useState(-1); // -1 表示还没选，会自动选推荐项
  const [useSourceFps, setUseSourceFps] = useState(true);
  const [customFps, setCustomFps] = useState(DEFAULT_EXPORT_CONFIG.fps);

  // 当源视频 meta 到达时，默认使用源帧率
  useEffect(() => {
    if (videoMeta?.fps) {
      setCustomFps(videoMeta.fps);
    }
  }, [videoMeta?.fps]);

  const effectiveFps = useSourceFps && videoMeta?.fps ? videoMeta.fps : customFps;

  // 根据当前 viewport 计算有效分辨率
  const vpWidth = currentViewport?.width ?? 1;
  const vpHeight = currentViewport?.height ?? 1;
  const effectiveRes = videoMeta
    ? computeEffectiveResolution(videoMeta.width, videoMeta.height, vpWidth, vpHeight)
    : null;

  // 基于有效分辨率生成智能预设
  const smartPresets: ExportPreset[] = effectiveRes
    ? buildSmartPresets(effectiveRes.effectiveShortEdge)
    : buildSmartPresets(1080); // fallback

  // 自动选择推荐项（仅在用户未手动选择时）
  const recommendedIdx = smartPresets.findIndex((p) => p.recommended);
  const activeIdx = selectedPresetIdx >= 0 && selectedPresetIdx < smartPresets.length
    ? selectedPresetIdx
    : Math.max(0, recommendedIdx);

  const currentPreset = smartPresets[activeIdx];

  // 根据源视频宽高比和短边分辨率计算导出尺寸
  const exportDimensions = videoMeta
    ? computeExportDimensions(videoMeta.width, videoMeta.height, currentPreset.shortEdge)
    : { width: DEFAULT_EXPORT_CONFIG.width, height: DEFAULT_EXPORT_CONFIG.height };

  const exportConfig: ExportConfig = {
    ...exportDimensions,
    videoBitrate: currentPreset.bitrate,
    fps: effectiveFps,
  };

  const trimDuration = trimEnd - trimStart;
  const hasTrim = trimStart > 0.1 || trimEnd < duration - 0.1;

  return (
    <div className="w-full bg-white/5 backdrop-blur-xl rounded-2xl border border-white/10 p-5 space-y-4">
      {/* 标题 */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-white/50 uppercase tracking-wider flex items-center gap-2">
          <svg
            className="w-4 h-4"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3"
            />
          </svg>
          导出视频
        </h3>
      </div>

      {/* 源视频信息 */}
      {videoMeta && (
        <div className="bg-cyan-500/5 border border-cyan-500/10 rounded-xl p-3 space-y-1.5">
          <div className="text-xs text-cyan-300/60 font-medium">📹 源视频规格</div>
          <div className="grid grid-cols-3 gap-2 text-xs font-mono">
            <div>
              <span className="text-white/30">分辨率</span>
              <div className="text-white/60">{videoMeta.width}×{videoMeta.height}</div>
            </div>
            <div>
              <span className="text-white/30">帧率</span>
              <div className="text-white/60">{videoMeta.fps}fps</div>
            </div>
            <div>
              <span className="text-white/30">时长</span>
              <div className="text-white/60">{formatTime(videoMeta.duration)}</div>
            </div>
          </div>
        </div>
      )}

      {/* 导出区间信息 */}
      <div className="bg-white/[0.03] rounded-xl p-3 space-y-2">
        <div className="flex items-center justify-between text-sm">
          <span className="text-white/40">导出区间</span>
          <span className="text-white/70 font-mono">
            {formatTime(trimStart)} → {formatTime(trimEnd)}
          </span>
        </div>
        <div className="flex items-center justify-between text-sm">
          <span className="text-white/40">时长</span>
          <span className="text-white/70 font-mono">
            {formatTime(trimDuration)}
            {hasTrim && (
              <span className="text-emerald-400/70 ml-2 text-xs">
                (已裁切)
              </span>
            )}
          </span>
        </div>
      </div>

      {!isExporting && !exportUrl && (
        <>
          {/* 分辨率选择 */}
          <div className="space-y-2">
            <label className="text-sm text-white/40">输出分辨率</label>

            {/* 有效分辨率提示 */}
            {effectiveRes && (
              <div className="bg-amber-500/5 border border-amber-500/10 rounded-lg px-3 py-2 text-xs text-amber-300/70">
                <span className="text-amber-300/50">裁切后有效像素 ≈ </span>
                <span className="font-mono text-amber-300/90">
                  {effectiveRes.effectiveWidth}×{effectiveRes.effectiveHeight}
                </span>
                {vpWidth < 0.95 && (
                  <span className="text-amber-300/50 ml-1">
                    (画面放大约 {(1 / Math.min(vpWidth, vpHeight)).toFixed(1)}×)
                  </span>
                )}
              </div>
            )}

            <div className="grid grid-cols-3 gap-2">
              {smartPresets.map((preset, idx) => {
                const dims = videoMeta
                  ? computeExportDimensions(videoMeta.width, videoMeta.height, preset.shortEdge)
                  : null;
                const isActive = idx === activeIdx;
                return (
                  <button
                    key={preset.shortEdge}
                    onClick={() => setSelectedPresetIdx(idx)}
                    className={`px-2 py-2 rounded-lg text-xs font-medium transition-all ${
                      isActive
                        ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30"
                        : "bg-white/5 text-white/50 border border-white/5 hover:bg-white/10"
                    }`}
                  >
                    <div className="flex items-center justify-center gap-1">
                      {preset.label}
                      {preset.recommended && (
                        <span className="text-[9px] bg-emerald-500/20 text-emerald-400 px-1 rounded">荐</span>
                      )}
                    </div>
                    {dims && (
                      <div className="text-[10px] opacity-60 mt-0.5">
                        {dims.width}×{dims.height}
                      </div>
                    )}
                    {preset.quality === "upscale" && (
                      <div className="text-[9px] text-amber-400/60 mt-0.5">有放大</div>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          {/* 帧率选择 */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-sm text-white/40">帧率</label>
              <span className="text-sm font-mono text-emerald-300/80">{effectiveFps} fps</span>
            </div>

            {/* 跟随源视频帧率开关 */}
            {videoMeta?.fps && (
              <button
                onClick={() => setUseSourceFps(!useSourceFps)}
                className={`w-full px-3 py-2 rounded-lg text-xs font-medium transition-all flex items-center justify-between ${
                  useSourceFps
                    ? "bg-cyan-500/15 text-cyan-300 border border-cyan-500/25"
                    : "bg-white/5 text-white/40 border border-white/5 hover:bg-white/10"
                }`}
              >
                <span>跟随源视频帧率 ({videoMeta.fps}fps)</span>
                <span className={`w-8 h-4 rounded-full relative transition-all ${useSourceFps ? "bg-cyan-500/40" : "bg-white/10"}`}>
                  <span className={`absolute top-0.5 w-3 h-3 rounded-full transition-all ${useSourceFps ? "right-0.5 bg-cyan-400" : "left-0.5 bg-white/30"}`} />
                </span>
              </button>
            )}

            {/* 自定义帧率滑块 */}
            {!useSourceFps && (
              <input
                type="range"
                min={15}
                max={60}
                step={5}
                value={customFps}
                onChange={(e) => setCustomFps(parseInt(e.target.value))}
                className="w-full h-1.5 bg-white/10 rounded-full appearance-none cursor-pointer
                  [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4
                  [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-emerald-400
                  [&::-webkit-slider-thumb]:shadow-[0_0_8px_rgba(52,211,153,0.4)]
                  [&::-webkit-slider-thumb]:cursor-pointer"
              />
            )}
          </div>

          {/* 导出按钮 */}
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => onExport(exportConfig)}
              className="px-4 py-3 bg-gradient-to-r from-emerald-500/30 to-cyan-500/30 hover:from-emerald-500/40 hover:to-cyan-500/40 text-white rounded-xl font-medium text-sm transition-all duration-200 border border-emerald-500/20 flex items-center justify-center gap-2"
            >
              <svg
                className="w-4 h-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3"
                />
              </svg>
              导出视频
            </button>
            <button
              onClick={() => onExportDebug(exportConfig)}
              className="px-4 py-3 bg-gradient-to-r from-orange-500/20 to-amber-500/20 hover:from-orange-500/30 hover:to-amber-500/30 text-amber-300 rounded-xl font-medium text-sm transition-all duration-200 border border-amber-500/20 flex items-center justify-center gap-2"
            >
              <svg
                className="w-4 h-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M12 6.042A8.967 8.967 0 0 0 6 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 0 1 6 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 0 1 6-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0 0 18 18a8.967 8.967 0 0 0-6 2.292m0-14.25v14.25"
                />
              </svg>
              调试视频
            </button>
          </div>
          <div className="text-[10px] text-white/25 text-center">
            调试视频：竖屏左右并排 | 横屏上下排列（输出 + 全景调试）
          </div>
        </>
      )}

      {/* 导出进度 */}
      {isExporting && exportProgress && (
        <div className="space-y-3">
          <div className="flex items-center justify-between text-sm">
            <span className="text-white/60">{exportProgress.message}</span>
            <span className="text-emerald-300/80 font-mono">
              {(exportProgress.progress * 100).toFixed(1)}%
            </span>
          </div>

          {/* 进度条 */}
          <div className="w-full h-2 bg-white/10 rounded-full overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-emerald-500 to-cyan-500 rounded-full transition-all duration-300"
              style={{ width: `${exportProgress.progress * 100}%` }}
            />
          </div>

          {exportProgress.currentTime !== undefined && exportProgress.duration !== undefined && (
            <div className="text-xs text-white/30 font-mono text-center">
              {formatTime(exportProgress.currentTime)} / {formatTime(exportProgress.duration)}
            </div>
          )}

          <button
            onClick={onCancel}
            className="w-full px-4 py-2.5 bg-red-500/20 hover:bg-red-500/30 text-red-300 rounded-xl font-medium text-sm transition-all duration-200 border border-red-500/20"
          >
            取消导出
          </button>
        </div>
      )}

      {/* 导出完成 */}
      {exportUrl && (
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-sm text-emerald-400">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
            </svg>
            导出完成！
          </div>

          <a
            href={exportUrl}
            download={`${fileName.replace(/\.[^/.]+$/, "")}_tracked.mp4`}
            className="block w-full px-4 py-3 bg-gradient-to-r from-emerald-500/30 to-cyan-500/30 hover:from-emerald-500/40 hover:to-cyan-500/40 text-white rounded-xl font-medium text-sm transition-all duration-200 border border-emerald-500/20 text-center"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3" />
            </svg>
            下载视频
          </a>

          <button
            onClick={onCancel}
            className="w-full px-4 py-2 bg-white/5 hover:bg-white/10 text-white/50 rounded-xl text-sm transition-all duration-200 border border-white/5"
          >
            关闭
          </button>
        </div>
      )}
    </div>
  );
}
